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
        Assert.Equal(new CaptureClockRange(125, 135), clock.Map(480, 2000, 31_250_000, false, false, 4 * frequency));
        Assert.Equal(new CaptureClockRange(135, 145), clock.Map(480, 2480, 31_350_000, false, false, 4 * frequency));
    }

    [Fact]
    public void SharedOriginAlignsDifferentSourceFormatsAndFreshPauseEpochs()
    {
        var microphone = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        var loopback = new DevicePacketClock(3_000_000, 1_000_000, 48_000);
        var resumed = new DevicePacketClock(3_000_000, 1_000_000, 48_000);
        Assert.Equal(microphone.Map(160, 0, 31_250_000, false, false, 4_000_000),
            loopback.Map(480, 901, 31_250_000, true, false, 4_000_000));
        Assert.Equal(new CaptureClockRange(2125, 2135), resumed.Map(480, 0, 51_250_000, true, false, 6_000_000));
    }

    [Fact]
    public void LargeAbsoluteCountersKeepSubMillisecondPrecision()
    {
        var clock = new DevicePacketClock(9_000_000_000_000_000, 3_000_000, 16_000);
        var range = clock.Map(160, 0, 30_000_000_000_012_345, false, false, 9_000_000_000_300_000);
        Assert.Equal(1.2345, range.StartMs, 9);
        Assert.Equal(11.2345, range.EndMs, 9);
    }

    [Theory]
    [InlineData(31_450_000)]
    [InlineData(31_300_000)]
    [InlineData(601_000_000)]
    public void ContiguousFramesDoNotAuthorizeUnflaggedTimestampGapsOrOverlap(long qpc)
    {
        var clock = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        clock.Map(160, 0, 31_250_000, false, false, 4_000_000);
        Assert.Equal("capture_discontinuity",
            Assert.Throws<AudioException>(() => clock.Map(160, 160, qpc, false, false, 4_000_000)).Code);
    }

    [Theory]
    [InlineData(8000, 80, 1251)]
    [InlineData(16_000, 160, 626)]
    [InlineData(44_100, 441, 227)]
    [InlineData(48_000, 480, 209)]
    [InlineData(192_000, 1920, 53)]
    public void OneSourceFramePlusQpcQuantizationBudgetHasExactSignedBoundaries(int rate, int frames, long maximumOffset)
    {
        foreach (var sign in new[] { -1, 1 })
        {
            var clock = new DevicePacketClock(3_000_000, 1_000_000, rate);
            clock.Map(frames, 0, 31_250_000, false, false, 4_000_000);
            var range = clock.Map(frames, frames, 31_350_000 + sign * maximumOffset, false, false, 4_000_000);
            Assert.Equal(135 + sign * maximumOffset / 10_000.0, range.StartMs, 9);
            var rejected = new DevicePacketClock(3_000_000, 1_000_000, rate);
            rejected.Map(frames, 0, 31_250_000, false, false, 4_000_000);
            Assert.Equal("capture_discontinuity", Assert.Throws<AudioException>(() =>
                rejected.Map(frames, frames, 31_350_000 + sign * (maximumOffset + 1), false, false, 4_000_000)).Code);
            Assert.Equal("capture_clock_invalid", Assert.Throws<AudioException>(() =>
                rejected.Map(frames, frames, 31_350_000, false, false, 4_000_000)).Code);
        }
    }

    [Fact]
    public void VariablePacketSizesUseThePreviousPacketFrameDuration()
    {
        var clock = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        Assert.Equal(new CaptureClockRange(125, 135), clock.Map(160, 0, 31_250_000, false, false, 4_000_000));
        Assert.Equal(new CaptureClockRange(135, 165), clock.Map(480, 160, 31_350_000, false, false, 4_000_000));
        Assert.Equal(new CaptureClockRange(165, 170), clock.Map(80, 640, 31_650_000, false, false, 4_000_000));
    }

    [Theory]
    [InlineData(8000)]
    [InlineData(16_000)]
    [InlineData(44_100)]
    [InlineData(48_000)]
    [InlineData(192_000)]
    public void FractionalFrameDurationsDoNotAccumulateQpcQuantizationErrors(int rate)
    {
        var clock = new DevicePacketClock(3_000_000, 1_000_000, rate);
        long cursor = 0;
        for (var index = 0; index < 1000; index++)
        {
            var frames = (index % 3) switch { 0 => 127, 1 => 129, _ => 256 };
            var qpc = 31_250_000 + cursor * 10_000_000 / rate;
            var range = clock.Map(frames, cursor, qpc, false, false, 100_000_000);
            Assert.Equal((qpc - 30_000_000) / 10_000.0, range.StartMs, 9);
            Assert.Equal(range.StartMs + frames * 1000.0 / rate, range.EndMs, 9);
            cursor += frames;
        }
    }

    [Theory]
    [InlineData(31_750_000, true)]
    [InlineData(31_749_374, true)]
    [InlineData(31_749_373, false)]
    [InlineData(30_000_000, false)]
    [InlineData(29_999_999, false)]
    public void PacketEndCannotExtendBeyondTheFreshRawClockObservationBudget(long observed, bool valid)
    {
        var clock = new DevicePacketClock(30_000_000, 10_000_000, 16_000);
        if (valid)
            Assert.Equal(new CaptureClockRange(125, 175), clock.Map(800, 0, 31_250_000, false, false, observed));
        else
        {
            Assert.Equal("capture_clock_invalid", Assert.Throws<AudioException>(() =>
                clock.Map(800, 0, 31_250_000, false, false, observed)).Code);
            Assert.Equal("capture_clock_invalid", Assert.Throws<AudioException>(() =>
                clock.Map(800, 0, 31_250_000, false, false, 31_750_000)).Code);
        }
    }

    [Fact]
    public void TheObservationClockMustNotRegressEvenWhenPacketTimestampsRemainValid()
    {
        var clock = new DevicePacketClock(3_000_000, 1_000_000, 16_000);
        clock.Map(160, 0, 31_250_000, false, false, 4_000_000);
        Assert.Equal("capture_clock_invalid", Assert.Throws<AudioException>(() =>
            clock.Map(160, 160, 31_350_000, false, false, 3_999_999)).Code);
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
        clock.Map(160, 0, 31_250_000, false, false, 4_000_000);
        Assert.Equal(code, Assert.Throws<AudioException>(() => clock.Map(160, position, qpc, discontinuity, timestampError, 4_000_000)).Code);
        Assert.Equal("capture_clock_invalid",
            Assert.Throws<AudioException>(() => clock.Map(160, 160, 31_350_000, false, false, 4_000_000)).Code);
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
            Assert.Throws<AudioException>(() => clock.Map(frames, position, qpc, false, false, 4_000_000)).Code);
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
