using System.Buffers.Binary;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class LevelTests
{
    private static byte[] Pcm(params short[] samples)
    {
        var bytes = new byte[samples.Length * 2];
        for (var index = 0; index < samples.Length; index++)
            BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(index * 2), samples[index]);
        return bytes;
    }

    [Fact]
    public void ComputesPeakAndRmsAcrossPacketsWithoutRetainingAudio()
    {
        var meter = new PcmLevelMeter();
        Assert.Null(meter.Read());
        var first = Pcm(16384, -16384);
        meter.Append(first, 50);
        Array.Clear(first);
        meter.Append(Pcm(0, 0), 100);
        var level = Assert.IsType<PcmLevel>(meter.Read());
        Assert.Equal(4, level.Samples);
        Assert.Equal(0.5, level.Peak);
        Assert.Equal(Math.Sqrt(0.125), level.Rms, 12);
        Assert.Equal(100, level.ClockMs);
        Assert.Null(meter.Read());
    }

    [Fact]
    public void DistinguishesSilentFramesFromNoFramesAndHandlesSignedFullScale()
    {
        var meter = new PcmLevelMeter();
        meter.Append(Pcm(0, 0), 10);
        Assert.Equal(new PcmLevel(2, 0, 0, 10), meter.Read());
        Assert.Null(meter.Read());
        meter.Append(Pcm(short.MinValue, short.MaxValue), 20);
        var level = Assert.IsType<PcmLevel>(meter.Read());
        Assert.Equal(1, level.Peak);
        Assert.InRange(level.Rms, 0.9999, 1);
    }

    [Fact]
    public void SlowReadersKeepOnlyABoundedRecentWindow()
    {
        var meter = new PcmLevelMeter();
        meter.Append(Pcm(32767), 1);
        meter.Append(new byte[PcmLevelMeter.MaxSamples * 2], 1001);
        Assert.Equal(new PcmLevel(PcmLevelMeter.MaxSamples, 0, 0, 1001), meter.Read());
        var large = new byte[PcmLevelMeter.MaxSamples * 4];
        BinaryPrimitives.WriteInt16LittleEndian(large, short.MinValue);
        meter.Append(large, 3000);
        Assert.Equal(new PcmLevel(PcmLevelMeter.MaxSamples, 0, 0, 3000), meter.Read());
    }

    [Fact]
    public void RejectsMalformedFramesAndRegressingClocksWithoutResettingEvidence()
    {
        var meter = new PcmLevelMeter();
        meter.Append(Pcm(16384), 50);
        Assert.Throws<InvalidDataException>(() => meter.Append(new byte[1], 60));
        Assert.Throws<InvalidDataException>(() => meter.Append(Pcm(0), double.NaN));
        Assert.Throws<InvalidDataException>(() => meter.Append(Pcm(0), -1));
        Assert.Throws<InvalidDataException>(() => meter.Append(Pcm(0), 49));
        Assert.Equal(new PcmLevel(1, 0.5, 0.5, 50), meter.Read());
    }

    [Fact]
    public async Task FramedTelemetryContainsOnlyBoundedDerivedLevelsAndExplicitlyMissingFrames()
    {
        var recording = Guid.NewGuid();
        var epoch = Guid.NewGuid();
        var microphone = Guid.NewGuid();
        using var stream = new MemoryStream();
        await FrameCodec.WriteAsync(stream, new AudioEvent(1, null, recording, "recording.levels",
            new CaptureLevels(epoch, 100, [
                new TrackLevel(microphone, new PcmLevel(800, 0.5, 0.25, 50)),
                new TrackLevel(Guid.NewGuid(), null)
            ])));
        stream.Position = 0;
        using var json = JsonDocument.Parse((await FrameCodec.ReadAsync(stream))!);
        var message = json.RootElement;
        Assert.Equal(recording, message.GetProperty("recording_id").GetGuid());
        Assert.Equal(JsonValueKind.Null, message.GetProperty("request_id").ValueKind);
        var payload = message.GetProperty("payload");
        Assert.Equal(epoch, payload.GetProperty("capture_epoch").GetGuid());
        var tracks = payload.GetProperty("tracks");
        Assert.Equal(2, tracks.GetArrayLength());
        Assert.Equal(microphone, tracks[0].GetProperty("track_id").GetGuid());
        var level = tracks[0].GetProperty("level");
        Assert.Equal(4, level.EnumerateObject().Count());
        Assert.Equal(800, level.GetProperty("samples").GetInt32());
        Assert.Equal(0.5, level.GetProperty("peak").GetDouble());
        Assert.Equal(0.25, level.GetProperty("rms").GetDouble());
        Assert.Equal(50, level.GetProperty("clock_ms").GetDouble());
        Assert.Equal(JsonValueKind.Null, tracks[1].GetProperty("level").ValueKind);
    }
}
