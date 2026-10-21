using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class ArchiveTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-archive", Guid.NewGuid().ToString("D"));
    private readonly TestKeyProtector protector = new();
    private readonly Guid id = Guid.NewGuid();
    private readonly TrackSpec microphone = new(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic-microphone");
    private RecordingArchive Archive => new(root, protector);
    private RecordingStore Create(params TrackSpec[] tracks) => new(root, id, tracks.Length == 0 ? [microphone] : tracks, protector);
    private static PcmChunkWriter Writer(RecordingStore store, Guid track)
    {
        var writer = new PcmChunkWriter(store, track);
        writer.BeginEpoch(Guid.NewGuid());
        return writer;
    }

    [Fact]
    public async Task CanonicalWavRangesRoundTripWithDistinctPlaintextChecksumAndNoTemporaryFiles()
    {
        var store = Create();
        var pcm = RandomNumberGenerator.GetBytes(40_000);
        var marker = Encoding.UTF8.GetBytes("synthetic-private-audio-archive");
        marker.CopyTo(pcm, 0);
        var writer = Writer(store, microphone.TrackId);
        writer.Append(pcm, 0, 1250);
        writer.Flush();
        store.Transition("sealed", "capture.stopped", 1250);
        var before = Directory.GetFiles(store.DirectoryPath).ToDictionary(path => path, File.ReadAllBytes);
        var upload = Assert.Single(Archive.List(id, microphone.TrackId).Chunks);
        var expected = PcmChunkWriter.ToWav(pcm);
        Assert.Equal(expected.Length, upload.SizeBytes);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(expected)), upload.Sha256);
        Assert.NotEqual(upload.Chunk.PcmSha256, upload.Sha256);
        using var actual = new MemoryStream();
        while (actual.Length < upload.SizeBytes)
        {
            var range = Archive.Read(id, upload.Chunk.ChunkId, (int)actual.Length, RecordingArchive.MaxRangeBytes);
            Assert.Equal(upload, range.Upload);
            Assert.Equal(actual.Length, range.Offset);
            var bytes = Convert.FromBase64String(range.DataBase64);
            Assert.InRange(bytes.Length, 1, RecordingArchive.MaxRangeBytes);
            actual.Write(bytes);
            Assert.Equal(actual.Length == upload.SizeBytes, range.EndOfChunk);
            using var frame = new MemoryStream();
            await FrameCodec.WriteAsync(frame, new AudioEvent(1, Guid.NewGuid(), id, "recording.chunk_range", range));
            Assert.True(frame.Length <= FrameCodec.MaxControlBytes + 4);
        }
        Assert.Equal(expected, actual.ToArray());
        Assert.Equal(expected[43..47], Convert.FromBase64String(Archive.Read(id, upload.Chunk.ChunkId, 43, 4).DataBase64));
        foreach (var (path, bytes) in before)
        {
            Assert.Equal(bytes, File.ReadAllBytes(path));
            Assert.DoesNotContain("synthetic-private-audio-archive", Encoding.UTF8.GetString(bytes));
        }
        Assert.Equal(before.Count, Directory.GetFiles(store.DirectoryPath).Length);
    }

    [Fact]
    public void PagesPerTrackAndTimelineWithoutMovingEarlierSequencesWhileCaptureAppends()
    {
        var loopback = new TrackSpec(Guid.NewGuid(), "loopback", "endpoint", "default", "default");
        var store = Create(microphone, loopback);
        var writer = Writer(store, microphone.TrackId);
        for (var i = 0; i < 51; i++)
        {
            writer.Append(new byte[2], i, i + 1);
            writer.Flush();
            store.Transition("recording", "capture.started", i + 1, Guid.NewGuid());
        }
        var other = Writer(store, loopback.TrackId);
        other.Append(new byte[2], 0, 1);
        other.Flush();
        var first = Archive.List(id, microphone.TrackId);
        Assert.Equal(50, first.Chunks.Count);
        Assert.True(first.HasMore);
        Assert.Equal(Enumerable.Range(0, 50), first.Chunks.Select(chunk => chunk.Chunk.Sequence));
        var old = store.Snapshot();
        writer.Append(new byte[2], 51, 52);
        writer.Flush();
        Assert.Single(Archive.List(id, microphone.TrackId, 50, old).Chunks);
        Assert.False(Archive.List(id, microphone.TrackId, 50, old).HasMore);
        Assert.Equal(2, Archive.List(id, microphone.TrackId, 50, store.Snapshot()).Chunks.Count);
        Assert.Equal(loopback.TrackId, Assert.Single(Archive.List(id, loopback.TrackId).Chunks).Chunk.TrackId);
        var events = Archive.Describe(id);
        Assert.Equal(50, events.Events.Count);
        Assert.True(events.HasMore);
        Assert.Single(Archive.Describe(id, 50).Events);
        old.Tracks[0].ChunkIds.Clear();
        old.Events.Clear();
        Assert.Equal(52, store.Snapshot().Tracks[0].ChunkIds.Count);
        Assert.Equal(51, store.Snapshot().Events.Count);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("truncated")]
    [InlineData("tampered")]
    [InlineData("metadata")]
    public void NeverReturnsAPlaintextRangeFromAnInvalidChunk(string damage)
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        var upload = Assert.Single(Archive.List(id, microphone.TrackId).Chunks);
        var path = Path.Combine(store.DirectoryPath, upload.Chunk.ChunkId.ToString("D") + ".chunk");
        var bytes = File.ReadAllBytes(path);
        switch (damage)
        {
            case "missing": File.Delete(path); break;
            case "truncated": File.WriteAllBytes(path, bytes[..^1]); break;
            case "tampered": bytes[^1] ^= 1; File.WriteAllBytes(path, bytes); break;
            case "metadata":
                File.Delete(path);
                EncryptedFile.Write(path, id, "audio_chunk", upload.Chunk with { PcmSha256 = new string('0', 64) }, new byte[3200], protector);
                break;
        }
        Assert.Equal("chunk_unreadable", Assert.Throws<AudioException>(() => Archive.Read(id, upload.Chunk.ChunkId, 0, 1)).Code);
    }

    [Fact]
    public void RejectsForeignResourcesAndInvalidRangesAndPreservesUnavailableKeys()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        var upload = Assert.Single(Archive.List(id, microphone.TrackId).Chunks);
        Assert.Equal("track_not_found", Assert.Throws<AudioException>(() => Archive.List(id, Guid.NewGuid())).Code);
        Assert.Equal("chunk_not_found", Assert.Throws<AudioException>(() => Archive.Read(id, Guid.NewGuid(), 0, 1)).Code);
        Assert.Equal("recording_not_found", Assert.Throws<AudioException>(() => Archive.Describe(Guid.NewGuid())).Code);
        foreach (var (offset, length) in new[] { (-1, 1), (0, 0), (0, RecordingArchive.MaxRangeBytes + 1), (upload.SizeBytes, 1) })
            Assert.Equal("invalid_range", Assert.Throws<AudioException>(() => Archive.Read(id, upload.Chunk.ChunkId, offset, length)).Code);
        var path = Path.Combine(store.DirectoryPath, "manifest.enc");
        var before = File.ReadAllBytes(path);
        var wrongKey = new RecordingArchive(root, new TestKeyProtector());
        Assert.Equal("key_unavailable", Assert.Throws<AudioException>(() => wrongKey.Describe(id)).Code);
        Assert.Equal("key_unavailable", Assert.Throws<AudioException>(() => wrongKey.Read(id, upload.Chunk.ChunkId, 0, 1, store.Snapshot())).Code);
        Assert.Equal(before, File.ReadAllBytes(path));
    }

    [Fact]
    public void BindsChunkIdentityToTheManifestAndReportsDamagedManifestsWithoutRepair()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        var upload = Assert.Single(Archive.List(id, microphone.TrackId).Chunks);
        var path = Path.Combine(store.DirectoryPath, "manifest.enc");
        var manifest = store.Snapshot();
        var other = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "explicit", "another-synthetic-device");
        manifest.Tracks[0] = new TrackManifest
        {
            Spec = other,
            ActualDeviceId = other.DeviceId,
            SavedSamples = 1600,
            ChunkIds = [upload.Chunk.ChunkId]
        };
        EncryptedFile.Write(path, id, "manifest", null, JsonSerializer.SerializeToUtf8Bytes(manifest, AudioJson.Options), protector);
        Assert.Equal("chunk_unreadable", Assert.Throws<AudioException>(() => Archive.Read(id, upload.Chunk.ChunkId, 0, 1)).Code);
        var damaged = File.ReadAllBytes(path);
        damaged[^1] ^= 1;
        File.WriteAllBytes(path, damaged);
        Assert.Equal("manifest_unreadable", Assert.Throws<AudioException>(() => Archive.Describe(id)).Code);
        Assert.Equal(damaged, File.ReadAllBytes(path));
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
