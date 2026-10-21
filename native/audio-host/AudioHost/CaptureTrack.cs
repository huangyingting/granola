using System.Diagnostics;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

internal sealed class CaptureTrack : IDisposable
{
    private sealed record Packet(byte[] Bytes, double StartMs, double EndMs);
    private readonly MMDevice endpoint;
    private readonly WasapiCapture capture;
    private readonly Channel<Packet> packets = Channel.CreateBounded<Packet>(new BoundedChannelOptions(64)
    {
        SingleReader = true,
        SingleWriter = true,
        FullMode = BoundedChannelFullMode.Wait
    });
    private readonly TaskCompletionSource stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<AudioException> failure;
    private readonly Stopwatch clock;
    private readonly Task consumer;
    private readonly int maxQueuedBytes;
    private long queuedBytes;
    private int stopping;
    private bool started;

    public CaptureTrack(MMDevice endpoint, string kind, PcmChunkWriter writer, Stopwatch clock,
        TaskCompletionSource<AudioException> failure)
    {
        this.endpoint = endpoint;
        this.clock = clock;
        this.failure = failure;
        capture = kind == "microphone" ? new WasapiCapture(endpoint) : new WasapiLoopbackCapture(endpoint);
        maxQueuedBytes = checked(capture.WaveFormat.AverageBytesPerSecond * 5);
        PcmConverter converter;
        try
        {
            converter = new PcmConverter(capture.WaveFormat);
        }
        catch
        {
            capture.Dispose();
            throw;
        }
        capture.DataAvailable += OnData;
        capture.RecordingStopped += (_, args) =>
        {
            if (args.Exception is not null || Volatile.Read(ref stopping) == 0)
                failure.TrySetResult(new AudioException("device_lost", "Capture stopped unexpectedly; saved chunks are preserved.", true));
            packets.Writer.TryComplete();
            stopped.TrySetResult();
        };
        consumer = Task.Run(async () =>
        {
            try
            {
                await foreach (var packet in packets.Reader.ReadAllAsync())
                {
                    using var normalized = new MemoryStream();
                    converter.Convert(packet.Bytes, (bytes, count) => normalized.Write(bytes, 0, count));
                    writer.Append(normalized.GetBuffer().AsSpan(0, (int)normalized.Length), packet.StartMs, packet.EndMs);
                    Interlocked.Add(ref queuedBytes, -packet.Bytes.Length);
                }
                writer.Flush();
            }
            catch (Exception error)
            {
                var audioError = error as AudioException ??
                    new AudioException("capture_failed", "Audio processing or encrypted storage failed; inspect the saved recording.", inner: error);
                failure.TrySetResult(audioError);
                throw audioError;
            }
        });
    }

    private void OnData(object? sender, WaveInEventArgs args)
    {
        if (args.BytesRecorded == 0 || failure.Task.IsCompleted) return;
        if (args.BytesRecorded > 1024 * 1024
            || args.BytesRecorded % capture.WaveFormat.BlockAlign != 0
            || Interlocked.Add(ref queuedBytes, args.BytesRecorded) > maxQueuedBytes)
        {
            failure.TrySetResult(new AudioException("capture_overrun", "The bounded capture queue overflowed or received invalid audio. Recording must stop."));
            return;
        }
        var bytes = args.Buffer.AsSpan(0, args.BytesRecorded).ToArray();
        var endMs = clock.Elapsed.TotalMilliseconds;
        var startMs = Math.Max(0, endMs - 1000.0 * bytes.Length / capture.WaveFormat.AverageBytesPerSecond);
        if (!packets.Writer.TryWrite(new Packet(bytes, startMs, endMs)))
        {
            Interlocked.Add(ref queuedBytes, -bytes.Length);
            failure.TrySetResult(new AudioException("capture_overrun", "The bounded capture queue is full. Recording must stop."));
        }
    }

    public void Start()
    {
        capture.StartRecording();
        started = true;
    }

    public async Task StopAsync()
    {
        Interlocked.Exchange(ref stopping, 1);
        Exception? stopError = null;
        try
        {
            if (started)
            {
                capture.StopRecording();
                await stopped.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        catch (Exception error) when (error is TimeoutException or System.Runtime.InteropServices.COMException)
        {
            stopError = error;
            failure.TrySetResult(new AudioException("stop_failed", "The audio endpoint did not stop cleanly. Inspect the saved recording.", inner: error));
        }
        finally
        {
            packets.Writer.TryComplete();
        }
        await consumer;
        if (stopError is not null)
            throw new AudioException("stop_failed", "The audio endpoint did not stop cleanly. Inspect the saved recording.", inner: stopError);
    }

    public void Dispose()
    {
        capture.DataAvailable -= OnData;
        capture.Dispose();
        endpoint.Dispose();
    }
}
