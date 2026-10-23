using System.Diagnostics;

namespace WindowsAiNotes.Audio;

public sealed class CaptureClock
{
    public long OriginTimestamp { get; } = Stopwatch.GetTimestamp();
    public TimeSpan Elapsed => Stopwatch.GetElapsedTime(OriginTimestamp);
}

public readonly record struct CaptureClockRange(double StartMs, double EndMs);

public sealed class DevicePacketClock
{
    private const long QpcUnitsPerSecond = 10_000_000;
    private readonly long originTimestamp;
    private readonly long counterFrequency;
    private readonly int sampleRate;
    private long? nextDevicePosition;
    private long previousQpc;
    private long previousObservation;
    private int previousFrames;
    private double previousEnd;
    private bool failed;

    public DevicePacketClock(long originTimestamp, long counterFrequency, int sampleRate)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(originTimestamp);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(counterFrequency);
        if (sampleRate is < 8000 or > 192_000)
            throw new ArgumentOutOfRangeException(nameof(sampleRate), "A supported sample rate and monotonic clock origin are required.");
        this.originTimestamp = originTimestamp;
        this.counterFrequency = counterFrequency;
        this.sampleRate = sampleRate;
    }

    public CaptureClockRange Map(int frames, long devicePosition, long qpc100ns, bool discontinuity, bool timestampError,
        long observedTimestamp)
    {
        if (failed)
            throw new AudioException("capture_clock_invalid", "The failed device clock cannot be reused.");
        try
        {
            if (timestampError || frames <= 0 || frames > sampleRate * PcmConverter.MaxBufferedSeconds
                || devicePosition < 0 || devicePosition > long.MaxValue - frames || qpc100ns <= 0
                || observedTimestamp < originTimestamp || observedTimestamp < previousObservation)
                throw new AudioException("capture_clock_invalid", "The endpoint supplied an invalid or uncertain packet timestamp.");
            if (nextDevicePosition is not null && (discontinuity || devicePosition != nextDevicePosition))
                throw new AudioException("capture_discontinuity", "The endpoint reported missing or discontinuous audio; saved chunks are preserved.");
            // WASAPI already expresses QPC in 100 ns units, not raw performance-counter ticks.
            var scaled = (Int128)qpc100ns * counterFrequency - (Int128)originTimestamp * QpcUnitsPerSecond;
            var startMs = (double)scaled / (counterFrequency * 10_000.0);
            var endMs = startMs + frames * 1000.0 / sampleRate;
            if (startMs < 0 || endMs > 14_400_000
                || (nextDevicePosition is not null && (qpc100ns <= previousQpc || endMs <= previousEnd)))
                throw new AudioException("capture_clock_invalid", "The endpoint packet clock regressed or exceeded the supported recording range.");
            // One source frame plus QPC's 100 ns quantization is an experimental rejection budget, not hardware acceptance.
            var tolerance = QpcUnitsPerSecond + sampleRate;
            if (nextDevicePosition is not null)
            {
                var intervalError = (Int128)(qpc100ns - previousQpc) * sampleRate - (Int128)previousFrames * QpcUnitsPerSecond;
                if (Int128.Abs(intervalError) > tolerance)
                    throw new AudioException("capture_discontinuity", "The endpoint packet timestamps do not account for a continuous source-frame interval.");
            }
            var relativeToObservation = (Int128)qpc100ns * counterFrequency - (Int128)observedTimestamp * QpcUnitsPerSecond;
            var endAfterObservation = relativeToObservation * sampleRate + (Int128)frames * QpcUnitsPerSecond * counterFrequency;
            if (endAfterObservation > (Int128)tolerance * counterFrequency)
                throw new AudioException("capture_clock_invalid", "The endpoint packet timestamp extends beyond the observed capture clock.");
            nextDevicePosition = devicePosition + frames;
            previousQpc = qpc100ns;
            previousObservation = observedTimestamp;
            previousFrames = frames;
            previousEnd = endMs;
            return new CaptureClockRange(startMs, endMs);
        }
        catch
        {
            failed = true;
            throw;
        }
    }
}
