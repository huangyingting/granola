using System.Diagnostics;
using System.Security.Cryptography;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

internal sealed class CaptureTrack : IDisposable
{
    internal sealed record Packet(byte[] Bytes, double StartMs, double EndMs);
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
    private readonly PcmLevelMeter levels = new();
    public Guid TrackId { get; }

    public CaptureTrack(MMDevice endpoint, Guid trackId, string kind, PcmChunkWriter writer, Stopwatch clock,
        TaskCompletionSource<AudioException> failure, LivePcmConsumer live)
    {
        this.endpoint = endpoint;
        TrackId = trackId;
        this.clock = clock;
        this.failure = failure;
        capture = kind == "microphone" ? new WasapiCapture(endpoint) : new WasapiLoopbackCapture(endpoint);
        maxQueuedBytes = checked(capture.WaveFormat.AverageBytesPerSecond * 5);
        CapturePcmProcessor processor;
        try
        {
            processor = new CapturePcmProcessor(capture.WaveFormat);
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
            using var ownedProcessor = processor;
            try
            {
                await foreach (var packet in packets.Reader.ReadAllAsync())
                {
                    try
                    {
                        ownedProcessor.Process(packet.Bytes, packet.StartMs, packet.EndMs, (pcm, startMs, endMs) =>
                        {
                            var sampleStart = writer.TotalSamples;
                            writer.Append(pcm.Span, startMs, endMs);
                            levels.Append(pcm.Span, endMs);
                            live(sampleStart, pcm.Span, startMs, endMs);
                        });
                    }
                    finally
                    {
                        Interlocked.Add(ref queuedBytes, -packet.Bytes.Length);
                    }
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
            finally
            {
                Interlocked.Add(ref queuedBytes, -CompleteAndClear(packets));
            }
        });
    }

    public delegate void LivePcmConsumer(long sampleStart, ReadOnlySpan<byte> bytes, double startMs, double endMs);
    public TrackLevel ReadLevel() => new(TrackId, levels.Read());

    internal static long CompleteAndClear(Channel<Packet> packets)
    {
        packets.Writer.TryComplete();
        long cleared = 0;
        while (packets.Reader.TryRead(out var packet))
        {
            CryptographicOperations.ZeroMemory(packet.Bytes);
            cleared += packet.Bytes.Length;
        }
        return cleared;
    }

    private void OnData(object? sender, WaveInEventArgs args)
    {
        if (args.BytesRecorded == 0 || failure.Task.IsCompleted) return;
        if (args.BytesRecorded > 1024 * 1024
            || args.BytesRecorded < 0 || args.BytesRecorded > args.Buffer.Length
            || args.BytesRecorded % capture.WaveFormat.BlockAlign != 0)
        {
            failure.TrySetResult(new AudioException("capture_overrun", "The bounded capture queue overflowed or received invalid audio. Recording must stop."));
            return;
        }
        if (Interlocked.Add(ref queuedBytes, args.BytesRecorded) > maxQueuedBytes)
        {
            Interlocked.Add(ref queuedBytes, -args.BytesRecorded);
            failure.TrySetResult(new AudioException("capture_overrun", "The bounded capture queue overflowed or received invalid audio. Recording must stop."));
            return;
        }
        var bytes = args.Buffer.AsSpan(0, args.BytesRecorded).ToArray();
        var endMs = clock.Elapsed.TotalMilliseconds;
        var startMs = Math.Max(0, endMs - 1000.0 * bytes.Length / capture.WaveFormat.AverageBytesPerSecond);
        if (!packets.Writer.TryWrite(new Packet(bytes, startMs, endMs)))
        {
            CryptographicOperations.ZeroMemory(bytes);
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
