using System.Security.Cryptography;

namespace WindowsAiNotes.Audio;

public sealed record LivePcmFrame(int FormatVersion, Guid RecordingId, Guid PreviewId, Guid TrackId, Guid CaptureEpoch,
    long Sequence, long SampleStart, int SampleCount, int SampleRate, int Channels, int BitsPerSample,
    double ClockStartMs, double ClockEndMs, string DataBase64);
public sealed record LiveTrackCursor(Guid TrackId, long? SampleEnd, int BufferedSamples);
public sealed record LiveAudioBatch(Guid PreviewId, Guid CaptureEpoch, string State, string? Code,
    LiveTrackCursor[] Tracks, LivePcmFrame[] Frames);

public sealed class PcmLiveBuffer : IDisposable
{
    public const int FrameSamples = 800;
    public const int MaxBufferedSamples = 16_000 * 5;
    public const int MaxFramesPerRead = 10;
    private readonly int maxBufferedMs;
    private readonly int maxBufferedSamples;
    private sealed class Track
    {
        public readonly byte[] Pending = new byte[FrameSamples * 2];
        public int Length;
        public int QueuedSamples;
        public long Sequence;
        public long? SampleEnd;
        public long SampleStart;
        public double ClockStart;
        public double ClockEnd;
    }
    private sealed record Frame(Guid TrackId, long Sequence, long SampleStart, double ClockStart, double ClockEnd, byte[] Bytes);
    private readonly object gate = new();
    private readonly Guid recordingId;
    private readonly Guid epoch;
    private readonly Dictionary<Guid, Track> tracks;
    private readonly Queue<Frame> frames = [];
    private string state = "active";
    private string? code;
    public Guid PreviewId { get; } = Guid.NewGuid();
    public bool IsActive { get { lock (gate) return state == "active"; } }

    public PcmLiveBuffer(Guid recordingId, Guid epoch, Guid[] trackIds, int maxBufferedMs = 5000)
    {
        if (recordingId == Guid.Empty || epoch == Guid.Empty || trackIds.Length is < 1 or > 2
            || trackIds.Any(id => id == Guid.Empty) || trackIds.Distinct().Count() != trackIds.Length)
            throw new ArgumentException("A live buffer requires one recording, epoch and distinct capture tracks.");
        if (maxBufferedMs is < 50 or > 5000 || maxBufferedMs % 50 != 0)
            throw new ArgumentOutOfRangeException(nameof(maxBufferedMs), "Live buffering must be 50 to 5000 milliseconds in complete frames.");
        this.recordingId = recordingId;
        this.epoch = epoch;
        this.maxBufferedMs = maxBufferedMs;
        maxBufferedSamples = maxBufferedMs * 16;
        tracks = trackIds.ToDictionary(id => id, _ => new Track());
    }

    public void Append(Guid trackId, Guid captureEpoch, long sampleStart, ReadOnlySpan<byte> pcm, double startMs, double endMs)
    {
        lock (gate)
        {
            if (state != "active") return;
            if (!tracks.TryGetValue(trackId, out var track) || captureEpoch != epoch
                || sampleStart < 0 || sampleStart > 230_400_000 - pcm.Length / 2 || pcm.Length % 2 != 0
                || !double.IsFinite(startMs) || !double.IsFinite(endMs) || startMs < 0 || endMs < startMs || endMs > 14_400_000)
            {
                Fail("invalid_live_pcm");
                return;
            }
            if (track.SampleEnd is not null && (sampleStart != track.SampleEnd || endMs < track.ClockEnd))
            {
                Fail("live_discontinuity");
                return;
            }
            if (pcm.Length == 0) return;
            if (track.QueuedSamples + track.Length / 2 + pcm.Length / 2 > maxBufferedSamples || Expired(endMs))
            {
                Fail("live_overrun");
                return;
            }
            var consumed = 0;
            while (consumed < pcm.Length)
            {
                if (track.Length == 0)
                {
                    track.SampleStart = sampleStart + consumed / 2;
                    track.ClockStart = startMs + (endMs - startMs) * consumed / pcm.Length;
                }
                var count = Math.Min(track.Pending.Length - track.Length, pcm.Length - consumed);
                pcm.Slice(consumed, count).CopyTo(track.Pending.AsSpan(track.Length));
                track.Length += count;
                consumed += count;
                track.ClockEnd = startMs + (endMs - startMs) * consumed / pcm.Length;
                if (track.ClockEnd < track.ClockStart)
                {
                    Fail("live_discontinuity");
                    return;
                }
                if (track.Length == track.Pending.Length)
                {
                    frames.Enqueue(new Frame(trackId, track.Sequence++, track.SampleStart,
                        track.ClockStart, track.ClockEnd, track.Pending.ToArray()));
                    track.QueuedSamples += FrameSamples;
                    CryptographicOperations.ZeroMemory(track.Pending);
                    track.Length = 0;
                }
            }
            track.SampleEnd = sampleStart + pcm.Length / 2;
        }
    }

    public LiveAudioBatch Read(double clockMs)
    {
        lock (gate)
        {
            if (state == "active")
            {
                if (!double.IsFinite(clockMs) || clockMs < 0 || clockMs > 14_400_000)
                    Fail("invalid_live_pcm");
                else if (Expired(clockMs))
                    Fail("live_overrun");
            }
            var result = new List<LivePcmFrame>();
            while (state == "active" && result.Count < MaxFramesPerRead && frames.TryDequeue(out var frame))
            {
                result.Add(new LivePcmFrame(1, recordingId, PreviewId, frame.TrackId, epoch, frame.Sequence,
                    frame.SampleStart, FrameSamples, 16_000, 1, 16, frame.ClockStart, frame.ClockEnd,
                    Convert.ToBase64String(frame.Bytes)));
                tracks[frame.TrackId].QueuedSamples -= FrameSamples;
                CryptographicOperations.ZeroMemory(frame.Bytes);
            }
            return Batch(result.ToArray());
        }
    }

    public LiveAudioBatch Snapshot()
    {
        lock (gate) return Batch([]);
    }

    private LiveAudioBatch Batch(LivePcmFrame[] result) => new(PreviewId, epoch, state, code,
        tracks.Select(pair => new LiveTrackCursor(pair.Key, pair.Value.SampleEnd,
            pair.Value.QueuedSamples + pair.Value.Length / 2)).ToArray(), result);

    private bool Expired(double clockMs) => frames.Any(frame => clockMs - frame.ClockStart > maxBufferedMs)
        || tracks.Values.Any(track => track.Length != 0 && clockMs - track.ClockStart > maxBufferedMs);

    private void Fail(string reason)
    {
        state = "failed";
        code = reason;
        Clear();
    }

    private void Clear()
    {
        while (frames.TryDequeue(out var frame)) CryptographicOperations.ZeroMemory(frame.Bytes);
        foreach (var track in tracks.Values)
        {
            CryptographicOperations.ZeroMemory(track.Pending);
            track.Length = 0;
            track.QueuedSamples = 0;
        }
    }

    public void Stop(string reason = "preview_stopped")
    {
        lock (gate)
        {
            if (state != "active") return;
            state = "stopped";
            code = reason;
            Clear();
        }
    }

    public void Dispose() => Stop();
}
