using System.Security.Cryptography;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class LivePcmTests
{
    private readonly Guid recording = Guid.NewGuid();
    private readonly Guid epoch = Guid.NewGuid();
    private readonly Guid microphone = Guid.NewGuid();
    private readonly Guid system = Guid.NewGuid();

    [Fact]
    public void PacketizesFiftyMillisecondFramesWithUnsealedSampleAndClockIdentity()
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone, system]);
        var pcm = RandomNumberGenerator.GetBytes(3200);
        buffer.Append(microphone, epoch, 1234, pcm.AsSpan(0, 600), 100, 118.75);
        Assert.Empty(buffer.Read(118.75).Frames);
        buffer.Append(microphone, epoch, 1534, pcm.AsSpan(600), 118.75, 200);
        buffer.Append(system, epoch, 0, new byte[1600], 150, 200);
        var metadata = buffer.Snapshot();
        Assert.Empty(metadata.Frames);
        Assert.Equal(1600, metadata.Tracks[0].BufferedSamples);
        var batch = buffer.Read(200);
        Assert.Equal(3, batch.Frames.Length);
        var first = batch.Frames[0];
        Assert.Equal(recording, first.RecordingId);
        Assert.Equal(buffer.PreviewId, first.PreviewId);
        Assert.Equal(epoch, first.CaptureEpoch);
        Assert.Equal(microphone, first.TrackId);
        Assert.Equal(1234, first.SampleStart);
        Assert.Equal(800, first.SampleCount);
        Assert.Equal(100, first.ClockStartMs);
        Assert.Equal(150, first.ClockEndMs);
        Assert.Equal(pcm.AsSpan(0, 1600).ToArray(), Convert.FromBase64String(first.DataBase64));
        Assert.Equal(1, batch.Frames[1].Sequence);
        Assert.Equal(2034, batch.Frames[1].SampleStart);
        Assert.Equal(200, batch.Frames[1].ClockEndMs);
        Assert.Equal(system, batch.Frames[2].TrackId);
        Assert.Equal(0, batch.Frames[2].Sequence);
        Assert.All(batch.Tracks, track => Assert.Equal(0, track.BufferedSamples));
        Assert.Empty(buffer.Read(200).Frames);
        Assert.Equal(2834, batch.Tracks[0].SampleEnd);
    }

    [Fact]
    public async Task FiveSecondsPerTrackDrainOnlyInBoundedRequestSizedBatches()
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone, system]);
        foreach (var track in new[] { microphone, system })
            buffer.Append(track, epoch, 0, new byte[PcmLiveBuffer.MaxBufferedSamples * 2], 0, 5000);
        var sequences = new List<long>();
        for (var index = 0; index < 20; index++)
        {
            var batch = buffer.Read(5000);
            Assert.Equal("active", batch.State);
            Assert.Equal(PcmLiveBuffer.MaxFramesPerRead, batch.Frames.Length);
            sequences.AddRange(batch.Frames.Select(frame => frame.Sequence));
            using var stream = new MemoryStream();
            await FrameCodec.WriteAsync(stream, new AudioEvent(1, Guid.NewGuid(), recording, "recording.live_audio", batch));
            Assert.InRange(stream.Length, 1, FrameCodec.MaxControlBytes + 4);
            stream.Position = 0;
            using var json = JsonDocument.Parse((await FrameCodec.ReadAsync(stream))!);
            var first = json.RootElement.GetProperty("payload").GetProperty("frames")[0];
            Assert.Equal(buffer.PreviewId, first.GetProperty("preview_id").GetGuid());
            Assert.Equal(1600, Convert.FromBase64String(first.GetProperty("data_base64").GetString()!).Length);
        }
        Assert.Equal(Enumerable.Range(0, 100).Select(value => (long)value).Concat(
            Enumerable.Range(0, 100).Select(value => (long)value)), sequences);
        Assert.Empty(buffer.Read(5000).Frames);
        buffer.Append(microphone, epoch, 80_000, new byte[1600], 5000, 5050);
        Assert.Equal(100, Assert.Single(buffer.Read(5050).Frames).Sequence);
    }

    [Fact]
    public void OverrunStopsOnlyPreviewAndClearsBothSourcesInsteadOfDroppingUnmarkedFrames()
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone, system]);
        buffer.Append(system, epoch, 0, new byte[1600], 0, 50);
        buffer.Append(microphone, epoch, 0, new byte[160_000], 0, 5000);
        buffer.Append(microphone, epoch, 80_000, new byte[2], 5000, 5000.0625);
        var batch = buffer.Read(5001);
        Assert.Equal("failed", batch.State);
        Assert.Equal("live_overrun", batch.Code);
        Assert.False(buffer.IsActive);
        Assert.Empty(batch.Frames);
        Assert.All(batch.Tracks, track => Assert.Equal(0, track.BufferedSamples));
        buffer.Append(microphone, epoch, 80_001, new byte[160_000], 5001, 10_001);
        Assert.Empty(buffer.Read(10_001).Frames);
    }

    [Theory]
    [InlineData(400)]
    [InlineData(1600)]
    public void ExpiredPartialOrCompleteFramesAreNotSentAfterASlowReaderReturns(int bytes)
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone]);
        buffer.Append(microphone, epoch, 0, new byte[bytes], 0, 50);
        var batch = buffer.Read(5001);
        Assert.Equal("live_overrun", batch.Code);
        Assert.Empty(batch.Frames);
        Assert.Equal(0, batch.Tracks[0].BufferedSamples);
    }

    [Fact]
    public void StopClearsPartialFramesAndAReplacementHasANewFencedIdentity()
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone]);
        buffer.Append(microphone, epoch, 0, new byte[1602], 0, 50.0625);
        buffer.Stop("capture_paused");
        buffer.Append(microphone, epoch, 801, new byte[1600], 100, 150);
        var batch = buffer.Read(150);
        Assert.Equal("stopped", batch.State);
        Assert.Equal("capture_paused", batch.Code);
        Assert.Empty(batch.Frames);
        Assert.Equal(801, batch.Tracks[0].SampleEnd);
        Assert.Equal(0, batch.Tracks[0].BufferedSamples);
        using var replacement = new PcmLiveBuffer(recording, Guid.NewGuid(), [microphone]);
        Assert.NotEqual(buffer.PreviewId, replacement.PreviewId);
        Assert.NotEqual(batch.CaptureEpoch, replacement.Snapshot().CaptureEpoch);
    }

    [Theory]
    [InlineData(50)]
    [InlineData(2500)]
    [InlineData(5000)]
    public void SmallerPreviewBudgetBoundsBothSamplesAndAgeWithoutChangingTheReadBatch(int milliseconds)
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone, system], milliseconds);
        foreach (var track in new[] { microphone, system })
            buffer.Append(track, epoch, 0, new byte[milliseconds * 32], 0, milliseconds);
        var snapshot = buffer.Snapshot();
        Assert.Equal("active", snapshot.State);
        Assert.All(snapshot.Tracks, track => Assert.Equal(milliseconds * 16, track.BufferedSamples));
        var batch = buffer.Read(milliseconds);
        Assert.Equal(Math.Min(milliseconds / 50 * 2, PcmLiveBuffer.MaxFramesPerRead), batch.Frames.Length);
        buffer.Read(milliseconds + 1);
        if (milliseconds > 50)
        {
            Assert.Equal("live_overrun", buffer.Snapshot().Code);
            Assert.All(buffer.Snapshot().Tracks, track => Assert.Equal(0, track.BufferedSamples));
        }
    }

    [Fact]
    public void DesktopBudgetFailsAtTwoAndAHalfSecondsNotAtTheLegacyFiveSecondLimit()
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone, system], 2500);
        buffer.Append(system, epoch, 0, new byte[400], 0, 12.5);
        buffer.Append(microphone, epoch, 0, new byte[80_000], 0, 2500);
        Assert.Equal("active", buffer.Snapshot().State);
        buffer.Append(microphone, epoch, 40_000, new byte[2], 2500, 2500.0625);
        Assert.Equal("live_overrun", buffer.Snapshot().Code);
        Assert.Empty(buffer.Read(2501).Frames);
        Assert.All(buffer.Snapshot().Tracks, track => Assert.Equal(0, track.BufferedSamples));
        using var partial = new PcmLiveBuffer(recording, epoch, [microphone], 2500);
        partial.Append(microphone, epoch, 0, new byte[400], 0, 12.5);
        Assert.Empty(partial.Read(2501).Frames);
        Assert.Equal("live_overrun", partial.Snapshot().Code);
    }

    [Theory]
    [InlineData(-50)]
    [InlineData(0)]
    [InlineData(25)]
    [InlineData(51)]
    [InlineData(5001)]
    [InlineData(int.MaxValue)]
    public void RejectsInvalidPreviewBudget(int milliseconds)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new PcmLiveBuffer(recording, epoch, [microphone], milliseconds));
    }

    [Theory]
    [InlineData("source", "invalid_live_pcm")]
    [InlineData("epoch", "invalid_live_pcm")]
    [InlineData("odd", "invalid_live_pcm")]
    [InlineData("clock", "invalid_live_pcm")]
    [InlineData("range", "invalid_live_pcm")]
    [InlineData("samples", "live_discontinuity")]
    [InlineData("regression", "live_discontinuity")]
    public void InvalidPreviewInputDoesNotThrowIntoTheCaptureConsumer(string change, string code)
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone]);
        buffer.Append(microphone, epoch, 0, new byte[1600], 0, 50);
        buffer.Append(change == "source" ? system : microphone, change == "epoch" ? Guid.NewGuid() : epoch,
            change == "samples" ? 0 : change == "range" ? long.MaxValue : 800,
            new byte[change == "odd" ? 1 : 1600], 0, change == "clock" ? double.NaN : change == "regression" ? 49 : 100);
        var batch = buffer.Read(100);
        Assert.Equal("failed", batch.State);
        Assert.Equal(code, batch.Code);
        Assert.Empty(batch.Frames);
    }

    [Fact]
    public async Task ConcurrentSourcesAndReaderRemainBoundedEvenWhenTheReaderFallsBehind()
    {
        using var buffer = new PcmLiveBuffer(recording, epoch, [microphone, system]);
        var pcm = new byte[1600];
        var producers = new[] { microphone, system }.Select(track => Task.Run(() =>
        {
            for (var index = 0; index < 1000; index++)
                buffer.Append(track, epoch, index * 800, pcm, 0, 0);
        }));
        await Task.WhenAll(producers.Append(Task.Run(() =>
        {
            for (var index = 0; index < 1000; index++)
            {
                var batch = buffer.Read(0);
                Assert.InRange(batch.Frames.Length, 0, PcmLiveBuffer.MaxFramesPerRead);
                Assert.All(batch.Tracks, track => Assert.InRange(track.BufferedSamples, 0, PcmLiveBuffer.MaxBufferedSamples));
            }
        })));
        buffer.Dispose();
        Assert.Empty(buffer.Read(0).Frames);
    }

    [Theory]
    [InlineData(5000)]
    [InlineData(2500)]
    public void LiveFailureDoesNotInterruptEncryptedChunkPersistenceOrClaimSavedSamplesEarly(int milliseconds)
    {
        var root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-tests", Guid.NewGuid().ToString("D"));
        try
        {
            var protector = new TestKeyProtector();
            var spec = new TrackSpec(microphone, "microphone", "endpoint", "explicit", "synthetic");
            var store = new RecordingStore(root, recording, [spec], protector);
            var writer = new PcmChunkWriter(store, microphone);
            writer.BeginEpoch(epoch);
            using var buffer = new PcmLiveBuffer(recording, epoch, [microphone], milliseconds);
            var pcm = RandomNumberGenerator.GetBytes(32_000);
            for (var second = 0; second < 31; second++)
            {
                var start = writer.TotalSamples;
                writer.Append(pcm, second * 1000, (second + 1) * 1000);
                buffer.Append(microphone, epoch, start, pcm, second * 1000, (second + 1) * 1000);
                Assert.Equal((second + 1) * 16_000, writer.TotalSamples);
                Assert.Equal((second + 1) / 30 * 480_000, store.Status().Tracks[0].SavedSamples);
            }
            Assert.Equal("live_overrun", buffer.Snapshot().Code);
            writer.Flush();
            store.Transition("sealed", "capture.stopped", 31_000);
            var verified = RecordingStore.Inspect(root, recording, protector);
            Assert.Equal("sealed", verified.State);
            Assert.Equal(496_000, verified.TotalSamples);
            Assert.Empty(verified.Issues);
            var chunks = Directory.GetFiles(store.DirectoryPath, "*.chunk");
            Assert.Equal(2, chunks.Length);
            Assert.Equal(496_000 * 2, chunks.Sum(path => EncryptedFile.Read(path, recording, "audio_chunk", protector).Plaintext.Length));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
