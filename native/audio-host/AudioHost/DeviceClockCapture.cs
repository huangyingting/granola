using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

internal sealed class DeviceClockPacketArgs(byte[] bytes, CaptureClockRange clock) : WaveInEventArgs(bytes, bytes.Length), IDisposable
{
    private byte[]? owned = bytes;
    public CaptureClockRange Clock { get; } = clock;
    public byte[] TakeBytes() => Interlocked.Exchange(ref owned, null)
        ?? throw new InvalidOperationException("Packet ownership was already transferred.");
    public void Dispose()
    {
        var remaining = Interlocked.Exchange(ref owned, null);
        if (remaining is not null) CryptographicOperations.ZeroMemory(remaining);
    }
}

internal readonly record struct DevicePacket(IntPtr Buffer, int Frames, AudioClientBufferFlags Flags, long DevicePosition, long Qpc100ns);

internal interface IDevicePacketReader : IDisposable
{
    WaveFormat WaveFormat { get; }
    void Start();
    void Stop();
    int GetNextPacketSize();
    DevicePacket GetBuffer();
    void ReleaseBuffer(int frames);
}

internal sealed class DeviceClockCapture : IWaveIn
{
    private readonly IDevicePacketReader reader;
    private readonly DevicePacketClock clock;
    private readonly ManualResetEvent stop = new(false);
    private readonly object gate = new();
    private Thread? thread;
    private bool disposed;
    private bool disposing;
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;
    public WaveFormat WaveFormat
    {
        get => reader.WaveFormat;
        set => throw new NotSupportedException("Device-clock capture uses the endpoint's mix format.");
    }

    public DeviceClockCapture(MMDevice endpoint, string kind, CaptureClock origin)
        : this(new WasapiPacketReader(endpoint, kind), origin.OriginTimestamp, Stopwatch.Frequency) { }

    internal DeviceClockCapture(IDevicePacketReader reader, long originTimestamp, long counterFrequency)
    {
        this.reader = reader;
        try
        {
            clock = new DevicePacketClock(originTimestamp, counterFrequency, reader.WaveFormat.SampleRate);
            if (reader.WaveFormat.BlockAlign <= 0)
                throw new AudioException("unsupported_format", "The endpoint mix format has an invalid frame size.");
        }
        catch
        {
            reader.Dispose();
            stop.Dispose();
            throw;
        }
    }

    public void StartRecording()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed || disposing, this);
            if (thread is not null) throw new InvalidOperationException("A device-clock source can only start once.");
            var starting = new Thread(Run) { IsBackground = true, Name = "WindowsAiNotes.DeviceClockCapture" };
            starting.Start();
            thread = starting;
        }
    }

    public void StopRecording()
    {
        lock (gate)
            if (!disposed) stop.Set();
    }

    private void Run()
    {
        Exception? failure = null;
        var started = false;
        try
        {
            reader.Start();
            started = true;
            while (!stop.WaitOne(0))
            {
                Drain();
                stop.WaitOne(10);
            }
            started = false;
            reader.Stop();
            Drain();
        }
        catch (Exception error)
        {
            failure = error;
        }
        finally
        {
            try
            {
                if (started) reader.Stop();
            }
            catch (Exception error)
            {
                failure = failure is null ? error : new AggregateException(failure, error);
            }
            try { reader.Dispose(); }
            catch (Exception error) { failure = failure is null ? error : new AggregateException(failure, error); }
            RecordingStopped?.Invoke(this, new StoppedEventArgs(failure));
        }
    }

    private void Drain()
    {
        for (var count = 0; count < 64; count++)
        {
            var size = reader.GetNextPacketSize();
            if (size == 0) return;
            if (size < 0)
                throw new AudioException("capture_overrun", "The endpoint reported an invalid packet size.");
            var packet = reader.GetBuffer();
            if (packet.Frames == 0) return;
            byte[]? bytes = null;
            try
            {
                CaptureClockRange range;
                try
                {
                    const AudioClientBufferFlags supported = AudioClientBufferFlags.DataDiscontinuity
                        | AudioClientBufferFlags.Silent | AudioClientBufferFlags.TimestampError;
                    if (packet.Frames < 0 || packet.Frames > 1024 * 1024 / WaveFormat.BlockAlign
                        || (packet.Flags & ~supported) != 0
                        || (!packet.Flags.HasFlag(AudioClientBufferFlags.Silent) && packet.Buffer == IntPtr.Zero))
                        throw new AudioException("capture_overrun", "The endpoint supplied invalid or oversized packet data.");
                    range = clock.Map(packet.Frames, packet.DevicePosition, packet.Qpc100ns,
                        packet.Flags.HasFlag(AudioClientBufferFlags.DataDiscontinuity),
                        packet.Flags.HasFlag(AudioClientBufferFlags.TimestampError));
                    bytes = new byte[checked(packet.Frames * WaveFormat.BlockAlign)];
                    if (!packet.Flags.HasFlag(AudioClientBufferFlags.Silent))
                        Marshal.Copy(packet.Buffer, bytes, 0, bytes.Length);
                }
                finally
                {
                    // The native lease must end on this thread before any queue/storage callback.
                    reader.ReleaseBuffer(Math.Max(0, packet.Frames));
                }
                using var args = new DeviceClockPacketArgs(bytes, range);
                bytes = null;
                DataAvailable?.Invoke(this, args);
            }
            finally
            {
                if (bytes is not null) CryptographicOperations.ZeroMemory(bytes);
            }
        }
        if (stop.WaitOne(0) && reader.GetNextPacketSize() != 0)
            throw new AudioException("capture_overrun", "The endpoint stop tail exceeded the bounded packet drain.");
    }

    public void Dispose()
    {
        Thread? running;
        lock (gate)
        {
            if (disposed) return;
            disposing = true;
            stop.Set();
            running = thread;
        }
        if (running is not null && !running.Join(TimeSpan.FromSeconds(10)))
            throw new AudioException("stop_failed", "The device-clock thread did not exit; the recording must not be assumed complete.");
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            try { if (running is null) reader.Dispose(); }
            finally { stop.Dispose(); }
        }
    }

    private sealed class WasapiPacketReader : IDevicePacketReader
    {
        private readonly AudioClient client;
        private readonly WaveFormat mixFormat;
        private readonly AudioClientStreamFlags flags;
        public WaveFormat WaveFormat { get; }
        public WasapiPacketReader(MMDevice endpoint, string kind)
        {
            client = endpoint.AudioClient;
            try
            {
                mixFormat = client.MixFormat;
                WaveFormat = mixFormat.AsStandardWaveFormat();
                flags = AudioClientStreamFlags.AutoConvertPcm | AudioClientStreamFlags.SrcDefaultQuality
                    | (kind == "loopback" ? AudioClientStreamFlags.Loopback : 0);
                if (kind is not ("loopback" or "microphone"))
                    throw new AudioException("invalid_request", "A supported endpoint capture kind is required.");
            }
            catch
            {
                client.Dispose();
                throw;
            }
        }
        public void Start()
        {
            client.Initialize(AudioClientShareMode.Shared, flags, 1_000_000, 0, mixFormat, Guid.Empty);
            client.Start();
        }
        public void Stop() => client.Stop();
        public int GetNextPacketSize() => client.AudioCaptureClient.GetNextPacketSize();
        public DevicePacket GetBuffer()
        {
            var pointer = client.AudioCaptureClient.GetBuffer(out var frames, out var packetFlags, out var device, out var qpc);
            return new DevicePacket(pointer, frames, packetFlags, device, qpc);
        }
        public void ReleaseBuffer(int frames) => client.AudioCaptureClient.ReleaseBuffer(frames);
        public void Dispose() => client.Dispose();
    }
}
