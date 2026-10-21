using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class RecordingTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-tests", Guid.NewGuid().ToString("D"));
    private readonly TestKeyProtector protector = new();
    private readonly Guid recordingId = Guid.NewGuid();
    private readonly TrackSpec microphone = new(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic-microphone");
    private readonly TrackSpec loopback = new(Guid.NewGuid(), "loopback", "endpoint", "explicit", "synthetic-loopback");

    private RecordingStore Create(params TrackSpec[] tracks) =>
        new(root, recordingId, tracks.Length == 0 ? [microphone] : tracks, protector);
    private RecoveryReport Inspect(IKeyProtector? keyProtector = null) =>
        RecordingStore.Inspect(root, recordingId, keyProtector ?? protector);

    private static PcmChunkWriter Writer(RecordingStore store, Guid trackId)
    {
        var writer = new PcmChunkWriter(store, trackId);
        writer.BeginEpoch(Guid.NewGuid());
        return writer;
    }

    private string[] Chunks(RecordingStore store) => Directory.GetFiles(store.DirectoryPath, "*.chunk");

    [Fact]
    public void DualTrackRecordingSealsAndRoundTripsWithoutPlaintextFiles()
    {
        var store = Create(microphone, loopback);
        var pcm = Encoding.UTF8.GetBytes("synthetic-audio-marker-1234567890");
        if (pcm.Length % 2 != 0) pcm = [.. pcm, 0];
        foreach (var track in new[] { microphone, loopback })
        {
            var writer = Writer(store, track.TrackId);
            writer.Append(pcm, 0, 1);
            writer.Flush();
        }
        store.Transition("sealed", "capture.stopped", 1);
        var report = Inspect();
        Assert.Equal("sealed", report.State);
        Assert.Equal(2, report.VerifiedChunks);
        Assert.Equal(pcm.Length, report.TotalSamples);
        Assert.Empty(report.Issues);
        foreach (var path in Chunks(store))
        {
            var (header, actual) = EncryptedFile.Read(path, recordingId, "audio_chunk", protector);
            Assert.Equal(pcm, actual);
            Assert.Equal(recordingId, header.Chunk!.RecordingId);
            Assert.DoesNotContain("synthetic-audio-marker", Encoding.UTF8.GetString(File.ReadAllBytes(path)));
        }
        Assert.DoesNotContain("synthetic-microphone", Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(store.DirectoryPath, "manifest.enc"))));
    }

    [Fact]
    public void SplitsThirtySecondChunksAndAuthenticatesTheTail()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        var pcm = RandomNumberGenerator.GetBytes((PcmChunkWriter.MaxSamples + 123) * 2);
        writer.Append(pcm, 0, 30_007.6875);
        writer.Flush();
        store.Transition("sealed", "capture.stopped", 30_008);
        var chunks = Chunks(store).Select(path => EncryptedFile.Read(path, recordingId, "audio_chunk", protector))
            .OrderBy(item => item.Header.Chunk!.Sequence).ToArray();
        Assert.Equal(2, chunks.Length);
        Assert.Equal(PcmChunkWriter.MaxSamples, chunks[0].Header.Chunk!.SampleCount);
        Assert.Equal(123, chunks[1].Header.Chunk!.SampleCount);
        Assert.Equal(PcmChunkWriter.MaxSamples, chunks[1].Header.Chunk!.SampleStart);
        Assert.NotEqual(chunks[0].Header.WrappedKey, chunks[1].Header.WrappedKey);
        Assert.NotEqual(chunks[0].Header.Nonce, chunks[1].Header.Nonce);
        Assert.Equal(pcm, chunks.SelectMany(item => item.Plaintext).ToArray());
        Assert.Equal("sealed", Inspect().State);
    }

    [Fact]
    public void CrashPreservesSealedChunksButDoesNotClaimAnUnsealedTail()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[(PcmChunkWriter.MaxSamples + 100) * 2], 0, 30_006.25);
        var report = Inspect();
        Assert.Equal("interrupted", report.State);
        Assert.Equal(PcmChunkWriter.MaxSamples, report.TotalSamples);
        Assert.Contains(report.Issues, issue => issue.Code == "unsealed_tail");
    }

    [Fact]
    public void PauseCreatesAnExplicitEpochBoundaryWithoutLosingSamples()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        var firstEpoch = Guid.NewGuid();
        writer.BeginEpoch(firstEpoch);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        store.Transition("paused", "capture.paused", 100);
        store.Transition("recording", "capture.started", 5000);
        var secondEpoch = Guid.NewGuid();
        writer.BeginEpoch(secondEpoch);
        writer.Append(new byte[3200], 5000, 5100);
        writer.Flush();
        store.Transition("sealed", "capture.stopped", 5100);
        var chunks = Chunks(store).Select(path => EncryptedFile.Read(path, recordingId, "audio_chunk", protector).Header.Chunk!)
            .OrderBy(chunk => chunk.Sequence).ToArray();
        Assert.Equal(firstEpoch, chunks[0].CaptureEpoch);
        Assert.Equal(secondEpoch, chunks[1].CaptureEpoch);
        Assert.Equal(5000, chunks[1].ClockStartMs);
        Assert.Equal(1600, chunks[1].SampleStart);
        Assert.Equal(3200, Inspect().TotalSamples);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("truncated")]
    [InlineData("tampered")]
    [InlineData("header")]
    public void MissingOrDamagedChunkNeverPassesAsComplete(string damage)
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        store.Transition("sealed", "capture.stopped", 100);
        var path = Assert.Single(Chunks(store));
        var bytes = File.ReadAllBytes(path);
        switch (damage)
        {
            case "missing": File.Delete(path); break;
            case "truncated": File.WriteAllBytes(path, bytes[..^1]); break;
            case "tampered": bytes[^17] ^= 1; File.WriteAllBytes(path, bytes); break;
            case "header":
                var text = Encoding.UTF8.GetString(bytes);
                var start = text.IndexOf("\"sample_start\":0", StringComparison.Ordinal);
                Assert.True(start > 0);
                bytes[start + "\"sample_start\":".Length] = (byte)'1';
                File.WriteAllBytes(path, bytes);
                break;
        }
        Assert.Equal("incomplete", Inspect().State);
        Assert.Contains(Inspect().Issues, issue => issue.Code == "chunk_missing");
    }

    [Fact]
    public void MissingMiddleChunkIsDetectedBySequenceAndSampleRange()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[PcmChunkWriter.MaxSamples * 2 * 3], 0, 90_000);
        store.Transition("sealed", "capture.stopped", 90_000);
        var middle = Chunks(store).Single(path =>
            EncryptedFile.Read(path, recordingId, "audio_chunk", protector).Header.Chunk!.Sequence == 1);
        File.Delete(middle);
        var report = Inspect();
        Assert.Equal("incomplete", report.State);
        Assert.Contains(report.Issues, issue => issue.Code == "sample_gap");
    }

    [Fact]
    public void FindsAuthenticatedOrphanAfterChunkCommitBeforeManifestCommit()
    {
        var store = Create();
        var manifestPath = Path.Combine(store.DirectoryPath, "manifest.enc");
        var oldManifest = File.ReadAllBytes(manifestPath);
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        File.WriteAllBytes(manifestPath, oldManifest);
        var report = Inspect();
        Assert.Equal("interrupted", report.State);
        Assert.Equal(1, report.RecoveredChunks);
        Assert.Equal(1600, report.TotalSamples);
        Assert.Equal(oldManifest, File.ReadAllBytes(manifestPath));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExplicitRecoveryAdoptsAuthenticatedOrphansWithoutSealingResumingOrChangingAudio(bool partialFile)
    {
        var store = Create(microphone, loopback);
        var manifestPath = Path.Combine(store.DirectoryPath, "manifest.enc");
        var original = File.ReadAllBytes(manifestPath);
        var pcm = RandomNumberGenerator.GetBytes(3200);
        foreach (var track in new[] { microphone, loopback })
        {
            var writer = Writer(store, track.TrackId);
            writer.Append(pcm, 0, 100);
            writer.Flush();
        }
        File.WriteAllBytes(manifestPath, original);
        if (partialFile) File.WriteAllBytes(Path.Combine(store.DirectoryPath, "crash.partial"), [1, 2, 3]);
        var preserved = Directory.GetFiles(store.DirectoryPath).Where(p => p != manifestPath).ToDictionary(p => p, File.ReadAllBytes);
        Assert.Equal("confirmation_required",
            Assert.Throws<AudioException>(() => RecordingStore.Recover(root, recordingId, protector, false)).Code);
        Assert.Equal(original, File.ReadAllBytes(manifestPath));
        var report = RecordingStore.Recover(root, recordingId, protector, true);
        Assert.Equal(partialFile ? "incomplete" : "interrupted", report.State);
        Assert.Equal(0, report.RecoveredChunks);
        Assert.Equal(2, report.VerifiedChunks);
        Assert.Equal(3200, report.TotalSamples);
        Assert.Contains(report.Issues, issue => issue.Code == "unsealed_tail");
        var archive = new RecordingArchive(root, protector);
        var manifest = archive.Describe(recordingId);
        Assert.Equal("failed", manifest.State);
        Assert.Equal("recovery.adopted", Assert.Single(manifest.Events).EventType);
        foreach (var track in manifest.Tracks)
        {
            Assert.Equal(1600, track.SavedSamples);
            var upload = Assert.Single(archive.List(recordingId, track.Spec.TrackId).Chunks);
            var range = archive.Read(recordingId, upload.Chunk.ChunkId, 0, RecordingArchive.MaxRangeBytes);
            Assert.Equal(PcmChunkWriter.ToWav(pcm), Convert.FromBase64String(range.DataBase64));
        }
        var committed = File.ReadAllBytes(manifestPath);
        Assert.Equal(report.State, RecordingStore.Recover(root, recordingId, protector, true).State);
        Assert.Equal(committed, File.ReadAllBytes(manifestPath));
        foreach (var (path, bytes) in preserved) Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Equal(preserved.Count + 1, Directory.GetFiles(store.DirectoryPath).Length);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("corrupt")]
    [InlineData("gap")]
    [InlineData("duplicate")]
    [InlineData("foreign-track")]
    [InlineData("sealed")]
    [InlineData("key")]
    [InlineData("manifest-order")]
    [InlineData("manifest-samples")]
    public void UnsafeRecoveryPreservesEveryFileWithoutChoosingOrFabricatingAudio(string damage)
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        writer.Append(new byte[3200], 100, 200);
        writer.Flush();
        var manifestPath = Path.Combine(store.DirectoryPath, "manifest.enc");
        var (_, manifestBytes) = EncryptedFile.Read(manifestPath, recordingId, "manifest", protector);
        var manifest = JsonSerializer.Deserialize<RecordingManifest>(manifestBytes, AudioJson.Options)!;
        writer.Append(new byte[3200], 200, 300);
        writer.Flush();
        if (damage == "sealed") manifest.State = "sealed";
        if (damage == "manifest-order") manifest.Tracks[0].ChunkIds.Reverse();
        if (damage == "manifest-samples") manifest.Tracks[0].SavedSamples++;
        EncryptedFile.Write(manifestPath, recordingId, "manifest", null,
            JsonSerializer.SerializeToUtf8Bytes(manifest, AudioJson.Options), protector);
        var orphanPath = Chunks(store).Single(path =>
            EncryptedFile.Read(path, recordingId, "audio_chunk", protector).Header.Chunk!.Sequence == 2);
        var (header, pcm) = EncryptedFile.Read(orphanPath, recordingId, "audio_chunk", protector);
        if (damage == "missing")
            File.Delete(Path.Combine(store.DirectoryPath, manifest.Tracks[0].ChunkIds[0].ToString("D") + ".chunk"));
        else if (damage == "corrupt")
        {
            var bytes = File.ReadAllBytes(orphanPath);
            bytes[^1] ^= 1;
            File.WriteAllBytes(orphanPath, bytes);
        }
        else if (damage is "gap" or "duplicate" or "foreign-track")
        {
            var chunk = header.Chunk!;
            chunk = damage switch
            {
                "gap" => chunk with { Sequence = 3, SampleStart = 4800 },
                "duplicate" => chunk with { ChunkId = Guid.NewGuid() },
                _ => chunk with { TrackId = Guid.NewGuid() }
            };
            if (chunk.ChunkId == header.Chunk!.ChunkId) File.Delete(orphanPath);
            EncryptedFile.Write(Path.Combine(store.DirectoryPath, chunk.ChunkId.ToString("D") + ".chunk"),
                recordingId, "audio_chunk", chunk, pcm, protector);
        }
        var before = Directory.GetFiles(store.DirectoryPath).ToDictionary(path => path, File.ReadAllBytes);
        Assert.Equal("recovery_unsafe", Assert.Throws<AudioException>(() =>
            RecordingStore.Recover(root, recordingId, damage == "key" ? new TestKeyProtector() : protector, true)).Code);
        foreach (var (path, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Equal(before.Count, Directory.GetFiles(store.DirectoryPath).Length);
    }

    [Fact]
    public void InspectionOnlyAndRecoveryWithoutOrphansNeverRewriteTheManifest()
    {
        var store = Create();
        var before = Directory.GetFiles(store.DirectoryPath).ToDictionary(path => path, File.ReadAllBytes);
        Assert.Equal("interrupted", Inspect().State);
        Assert.Equal("nothing_to_recover", Assert.Throws<AudioException>(() =>
            RecordingStore.Recover(root, recordingId, protector, true)).Code);
        foreach (var (path, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(path));
    }

    [Fact]
    public void FailureToProtectTheReplacementManifestLeavesAllOriginalFilesIntact()
    {
        var store = Create();
        var manifestPath = Path.Combine(store.DirectoryPath, "manifest.enc");
        var original = File.ReadAllBytes(manifestPath);
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        File.WriteAllBytes(manifestPath, original);
        var before = Directory.GetFiles(store.DirectoryPath).ToDictionary(path => path, File.ReadAllBytes);
        Assert.Throws<CryptographicException>(() =>
            RecordingStore.Recover(root, recordingId, new FailingProtection(protector), true));
        Assert.Equal(1, Inspect().RecoveredChunks);
        foreach (var (path, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Equal(before.Count, Directory.GetFiles(store.DirectoryPath).Length);
    }

    private sealed class FailingProtection(IKeyProtector inner) : IKeyProtector
    {
        public byte[] Protect(byte[] key) => throw new CryptographicException("Synthetic key protection failure.");
        public byte[] Unprotect(byte[] wrappedKey) => inner.Unprotect(wrappedKey);
    }

    [Fact]
    public void UnavailableKeyNeverResetsOrDeletesExistingData()
    {
        var store = Create();
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        var before = Directory.GetFiles(store.DirectoryPath).ToDictionary(path => path, File.ReadAllBytes);
        var report = Inspect(new TestKeyProtector());
        Assert.Equal("key_unavailable", report.State);
        foreach (var (path, bytes) in before)
            Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Equal(before.Count, Directory.GetFiles(store.DirectoryPath).Length);
    }

    [Fact]
    public void PartialFilesAndCorruptManifestAreExplicit()
    {
        var store = Create();
        File.WriteAllBytes(Path.Combine(store.DirectoryPath, "crash.partial"), [1, 2, 3]);
        Assert.Contains(Inspect().Issues, issue => issue.Code == "uncommitted_file");
        var manifest = Path.Combine(store.DirectoryPath, "manifest.enc");
        var bytes = File.ReadAllBytes(manifest);
        bytes[^1] ^= 1;
        File.WriteAllBytes(manifest, bytes);
        Assert.Equal("incomplete", Inspect().State);
        Assert.Contains(Inspect().Issues, issue => issue.Code == "manifest_unreadable");
    }

    [Fact]
    public void RefusesToOverwriteAnExistingRecordingOrAppendAfterSealing()
    {
        var store = Create();
        Assert.Equal("recording_exists", Assert.Throws<AudioException>(() => Create()).Code);
        store.Transition("sealed", "capture.stopped", 0);
        var writer = Writer(store, microphone.TrackId);
        writer.Append(new byte[2], 0, 1);
        Assert.Equal("invalid_state", Assert.Throws<AudioException>(writer.Flush).Code);
    }

    [Fact]
    public void ReconstructedWavIsDeterministicAndHasPlaintextChecksumDomain()
    {
        var pcm = new byte[] { 0, 0, 255, 127, 0, 128 };
        var wav = PcmChunkWriter.ToWav(pcm);
        Assert.Equal(wav, PcmChunkWriter.ToWav(pcm));
        Assert.Equal("RIFF", Encoding.ASCII.GetString(wav, 0, 4));
        Assert.Equal(pcm.Length, BinaryPrimitives.ReadInt32LittleEndian(wav.AsSpan(40)));
        Assert.Equal(16_000, BinaryPrimitives.ReadInt32LittleEndian(wav.AsSpan(24)));
        Assert.Equal(pcm, wav[44..]);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
