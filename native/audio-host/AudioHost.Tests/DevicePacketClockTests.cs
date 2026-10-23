using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class DevicePacketClockTests
{
    [Theory]
    [InlineData(1_000_000)]
    [InlineData(10_000_000)]
    [InlineData(24_000_000)]
    public void MapsAlreadyConvertedQpcUnitsWithoutCallbackArrival(long frequency)
    {
        var clock = new DevicePacketClock(3 * frequency, frequency, 48_000);
        Assert.Equal(new CaptureClockRange(125, 135), clock.Map(480, 2000, 31_250_000, false, false));
        Assert.Equal(new CaptureClockRange(135, 145), clock.Map(480, 2480, 31_350_000, false, false));
    }

    [Fact]
    public void SharedOriginAlignsDifferentSourceFormatsAndFreshPauseEpochs()
    {
        var microphone = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        var loopback = new DevicePacketClock(3_000_000, 1_000_000, 48_000);
        var resumed = new DevicePacketClock(3_000_000, 1_000_000, 48_000);
        Assert.Equal(microphone.Map(160, 0, 31_250_000, false, false),
            loopback.Map(480, 901, 31_250_000, true, false));
        Assert.Equal(new CaptureClockRange(2125, 2135), resumed.Map(480, 0, 51_250_000, true, false));
    }

    [Fact]
    public void LargeAbsoluteCountersKeepSubMillisecondPrecision()
    {
        var clock = new DevicePacketClock(9_000_000_000_000_000, 3_000_000, 16_000);
        var range = clock.Map(160, 0, 30_000_000_000_012_345, false, false);
        Assert.Equal(1.2345, range.StartMs, 9);
        Assert.Equal(11.2345, range.EndMs, 9);
    }

    [Theory]
    [InlineData(161, false, 31_350_000, false, "capture_discontinuity")]
    [InlineData(159, false, 31_350_000, false, "capture_discontinuity")]
    [InlineData(160, true, 31_350_000, false, "capture_discontinuity")]
    [InlineData(160, false, 31_250_000, false, "capture_clock_invalid")]
    [InlineData(160, false, 31_000_000, false, "capture_clock_invalid")]
    [InlineData(160, false, 31_350_000, true, "capture_clock_invalid")]
    public void RejectsGapsDuplicatesGlitchesAndUncertainTimestampsTerminally(
        long position, bool discontinuity, long qpc, bool timestampError, string code)
    {
        var clock = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        clock.Map(160, 0, 31_250_000, false, false);
        Assert.Equal(code, Assert.Throws<AudioException>(() => clock.Map(160, position, qpc, discontinuity, timestampError)).Code);
        Assert.Equal("capture_clock_invalid",
            Assert.Throws<AudioException>(() => clock.Map(160, 160, 31_350_000, false, false)).Code);
    }

    [Theory]
    [InlineData(0, 0, 31_250_000)]
    [InlineData(-1, 0, 31_250_000)]
    [InlineData(96_001, 0, 31_250_000)]
    [InlineData(160, -1, 31_250_000)]
    [InlineData(160, long.MaxValue, 31_250_000)]
    [InlineData(160, 0, 0)]
    [InlineData(160, 0, -1)]
    [InlineData(160, 0, 29_999_999)]
    [InlineData(160, 0, long.MaxValue)]
    public void RejectsInvalidFrameCountsPositionsAndClockBounds(int frames, long position, long qpc)
    {
        var clock = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        Assert.Equal("capture_clock_invalid",
            Assert.Throws<AudioException>(() => clock.Map(frames, position, qpc, false, false)).Code);
    }

    [Theory]
    [InlineData(-1, 1_000_000, 16_000)]
    [InlineData(0, 0, 16_000)]
    [InlineData(0, -1, 16_000)]
    [InlineData(0, 1_000_000, 7999)]
    [InlineData(0, 1_000_000, 192_001)]
    public void RejectsUnsupportedClockConfiguration(long origin, long frequency, int sampleRate) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new DevicePacketClock(origin, frequency, sampleRate));
}
