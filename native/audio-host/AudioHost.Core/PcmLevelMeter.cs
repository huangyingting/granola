using System.Buffers.Binary;

namespace WindowsAiNotes.Audio;

public sealed record PcmLevel(int Samples, double Peak, double Rms, double ClockMs);
public sealed record TrackLevel(Guid TrackId, PcmLevel? Level);
public sealed record CaptureLevels(Guid CaptureEpoch, double ClockMs, IReadOnlyList<TrackLevel> Tracks);

public sealed class PcmLevelMeter
{
    public const int MaxSamples = 16_000;
    private readonly object gate = new();
    private int samples;
    private int peak;
    private double squares;
    private double clock;

    public void Append(ReadOnlySpan<byte> pcm, double clockMs)
    {
        if (pcm.Length % 2 != 0 || !double.IsFinite(clockMs) || clockMs < 0)
            throw new InvalidDataException("Invalid PCM level frame or clock.");
        if (pcm.IsEmpty) return;
        pcm = pcm[^Math.Min(pcm.Length, MaxSamples * 2)..];
        var count = pcm.Length / 2;
        var framePeak = 0;
        double frameSquares = 0;
        for (var offset = 0; offset < pcm.Length; offset += 2)
        {
            var sample = (int)BinaryPrimitives.ReadInt16LittleEndian(pcm[offset..]);
            framePeak = Math.Max(framePeak, Math.Abs(sample));
            frameSquares += (double)sample * sample;
        }
        lock (gate)
        {
            if (clockMs < clock)
                throw new InvalidDataException("PCM level clocks must not move backwards.");
            if (samples + count > MaxSamples)
            {
                samples = 0;
                peak = 0;
                squares = 0;
            }
            samples += count;
            peak = Math.Max(peak, framePeak);
            squares += frameSquares;
            clock = clockMs;
        }
    }

    public PcmLevel? Read()
    {
        lock (gate)
        {
            if (samples == 0) return null;
            var level = new PcmLevel(samples, peak / 32768.0, Math.Sqrt(squares / samples) / 32768.0, clock);
            samples = 0;
            peak = 0;
            squares = 0;
            return level;
        }
    }
}
