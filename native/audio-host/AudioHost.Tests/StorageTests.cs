using System.Security.Cryptography;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class StorageTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "windows-ai-notes-storage-tests", Guid.NewGuid().ToString("D"));
    private readonly string root;
    private readonly TestKeyProtector protector = new();
    private readonly Guid recording = Guid.NewGuid();
    private readonly Guid track = Guid.NewGuid();

    public StorageTests()
    {
        root = Path.Combine(directory, "audio");
        Directory.CreateDirectory(root);
    }

    private StorageBudget Budget(Func<long>? free = null) =>
        new(root, StorageBudget.GiB, free ?? (() => 10 * StorageBudget.GiB));

    private void Sized(string name, long bytes)
    {
        using var file = new FileStream(Path.Combine(root, name), FileMode.CreateNew, FileAccess.Write);
        file.SetLength(bytes);
    }

    private ChunkMetadata Chunk(byte[] pcm) =>
        new(1, recording, track, Guid.NewGuid(), Guid.NewGuid(), 0, 0, pcm.Length / 2, 16_000, 1, 16,
            0, pcm.Length / 32.0, Convert.ToHexStringLower(SHA256.HashData(pcm)));

    [Fact]
    public void CountsAllNativeFilesIncludingOrphansPartialsAndUnknownSubdirectoriesWithoutDecrypting()
    {
        Directory.CreateDirectory(Path.Combine(root, "interrupted", "nested"));
        File.WriteAllBytes(Path.Combine(root, "interrupted", "manifest.enc"), new byte[13]);
        File.WriteAllBytes(Path.Combine(root, "interrupted", "orphan.chunk"), new byte[17]);
        File.WriteAllBytes(Path.Combine(root, "interrupted", "nested", "pending.partial"), new byte[19]);
        Sized("unrecognized-file", 23);
        var status = Budget().Read();
        Assert.Equal(72, status.UsedBytes);
        Assert.Equal(StorageBudget.GiB, status.QuotaBytes);
        Assert.Equal("ready", status.State);
        Assert.Null(status.Code);
        Assert.Equal(4, Directory.GetFiles(root, "*", SearchOption.AllDirectories).Length);
    }

    [Theory]
    [InlineData(-1, "ready")]
    [InlineData(0, "warning")]
    [InlineData(1, "warning")]
    public void QuotaWarningRoundsUpToTheFirstWholeByteAtEightyPercent(int difference, string expected)
    {
        var quota = 2 * StorageBudget.GiB;
        Sized("unique-copy", (quota * 4 + 4) / 5 + difference);
        var status = new StorageBudget(root, quota, () => 10 * StorageBudget.GiB).Read();
        Assert.Equal(expected, status.State);
        Assert.Null(status.Code);
        Assert.True(File.Exists(Path.Combine(root, "unique-copy")));
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, false)]
    [InlineData(1, true)]
    public void AdmissionHonorsTheExactGlobalQuotaAndEmergencyMetadataBoundary(int excess, bool blocked)
    {
        Sized("unique-unuploaded.partial",
            StorageBudget.GiB - StorageBudget.MetadataReserveBytes - StorageBudget.CaptureHeadroomBytes + excess);
        var budget = Budget();
        var status = budget.Read();
        Assert.Equal(blocked ? "blocked" : "warning", status.State);
        if (blocked)
        {
            Assert.Equal("storage_limit", Assert.Throws<AudioException>(budget.EnsureCaptureCapacity).Code);
            var id = Guid.NewGuid();
            Assert.Equal("storage_limit", Assert.Throws<AudioException>(() =>
                new RecordingStore(root, id, [new(track, "microphone", "endpoint", "explicit", "synthetic")],
                    protector, storage: budget)).Code);
            Assert.False(Directory.Exists(Path.Combine(root, id.ToString("D"))));
        }
        else budget.EnsureCaptureCapacity();
        Assert.True(File.Exists(Path.Combine(root, "unique-unuploaded.partial")));
    }

    [Theory]
    [InlineData(-1, true)]
    [InlineData(0, false)]
    [InlineData(1, false)]
    public void AdmissionHonorsTheExactPhysicalDiskReserve(int difference, bool blocked)
    {
        var budget = Budget(() => StorageBudget.DiskReserveBytes + StorageBudget.CaptureHeadroomBytes + difference);
        var status = budget.Read();
        Assert.Equal(blocked ? "disk_full" : null, status.Code);
        Assert.Equal(blocked ? "blocked" : "warning", status.State);
        if (blocked) Assert.Equal("disk_full", Assert.Throws<AudioException>(budget.EnsureCaptureCapacity).Code);
        else budget.EnsureCaptureCapacity();
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, false)]
    [InlineData(1, true)]
    public void MediaReservationHonorsTheExactEncryptedByteBoundary(int excess, bool blocked)
    {
        const int length = 4096;
        Sized("previous-unique-copy", StorageBudget.GiB - StorageBudget.MetadataReserveBytes - length + excess);
        var budget = Budget();
        if (blocked)
            Assert.Equal("storage_limit", Assert.Throws<AudioException>(() =>
                budget.Reserve(length, media: true)).Code);
        else
        {
            using var reservation = budget.Reserve(length, media: true);
        }
        Assert.Empty(Directory.GetFiles(root, "*.partial"));
        Assert.True(File.Exists(Path.Combine(root, "previous-unique-copy")));
        budget.Read();
    }

    [Theory]
    [InlineData(-1, true)]
    [InlineData(0, false)]
    public void MediaReservationPreservesTheExactPhysicalDiskReserve(int difference, bool blocked)
    {
        const int length = 4096;
        var budget = Budget(() => StorageBudget.DiskReserveBytes + length + difference);
        if (blocked)
            Assert.Equal("disk_full", Assert.Throws<AudioException>(() =>
                budget.Reserve(length, media: true)).Code);
        else
        {
            using var reservation = budget.Reserve(length, media: true);
        }
        Assert.Empty(Directory.GetFiles(root, "*.partial"));
        budget.Read();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EncryptedMediaCountsHeaderAndTagBeforeOpeningAnyFile(bool physicalDisk)
    {
        var pcm = new byte[3200];
        var chunk = Chunk(pcm);
        if (!physicalDisk)
            Sized("unique-copy", StorageBudget.GiB - StorageBudget.MetadataReserveBytes - pcm.Length);
        var budget = Budget(physicalDisk ? () => StorageBudget.DiskReserveBytes + pcm.Length : null);
        Assert.Equal(physicalDisk ? "disk_full" : "storage_limit", Assert.Throws<AudioException>(() =>
            EncryptedFile.Write(Path.Combine(root, "new.chunk"), recording, "audio_chunk", chunk, pcm, protector, budget)).Code);
        Assert.False(File.Exists(Path.Combine(root, "new.chunk")));
        Assert.Empty(Directory.GetFiles(root, "*.partial"));
    }

    [Fact]
    public void FailureMetadataCanUseTheReserveAboveQuotaButCannotOverwriteWithoutEnoughPeakDiskSpace()
    {
        Sized("unique-unuploaded.partial", StorageBudget.GiB);
        var path = Path.Combine(root, "manifest.enc");
        var original = new byte[2000];
        var replacement = new byte[2000];
        replacement[0] = 42;
        EncryptedFile.Write(path, recording, "manifest", null, original, protector);
        var originalBytes = File.ReadAllBytes(path);
        var free = original.Length;
        var budget = Budget(() => free);
        Assert.Equal("disk_full", Assert.Throws<AudioException>(() =>
            EncryptedFile.Write(path, recording, "manifest", null, replacement, protector, budget)).Code);
        Assert.Equal(originalBytes, File.ReadAllBytes(path));
        Assert.Single(Directory.GetFiles(root, "*.partial"));
        // Random base64 values can acquire JSON escape overhead, so envelope size varies.
        free = replacement.Length + 64 * 1024 + 28;
        EncryptedFile.Write(path, recording, "manifest", null, replacement, protector, budget);
        Assert.Equal(replacement, EncryptedFile.Read(path, recording, "manifest", protector).Plaintext);
        Assert.Equal("blocked", budget.Read().State);
        Assert.Equal(StorageBudget.GiB, new FileInfo(Path.Combine(root, "unique-unuploaded.partial")).Length);
    }

    [Fact]
    public void MidCaptureQuotaFailurePreservesCommittedChunksAndWritesAnExplicitFailedManifest()
    {
        var budget = Budget();
        var spec = new TrackSpec(track, "microphone", "endpoint", "explicit", "synthetic");
        var store = new RecordingStore(root, recording, [spec], protector, storage: budget);
        var writer = new PcmChunkWriter(store, track);
        writer.BeginEpoch(Guid.NewGuid());
        writer.Append(new byte[3200], 0, 100);
        writer.Flush();
        var committed = Assert.Single(Directory.GetFiles(store.DirectoryPath, "*.chunk"));
        var preserved = File.ReadAllBytes(committed);
        Sized("unuploaded-orphan.partial", StorageBudget.GiB);
        writer.Append(new byte[3200], 100, 200);
        var error = Assert.Throws<AudioException>(writer.Flush);
        Assert.Equal("storage_limit", error.Code);
        store.Transition("failed", "capture.failed", 200, code: error.Code);
        Assert.Equal(preserved, File.ReadAllBytes(committed));
        var report = RecordingStore.Inspect(root, recording, protector);
        Assert.Equal("interrupted", report.State);
        Assert.Equal(1600, report.TotalSamples);
        Assert.Single(Directory.GetFiles(store.DirectoryPath, "*.chunk"));
        Assert.Equal("failed", new RecordingArchive(root, protector).Describe(recording).State);
        Assert.Equal("storage_limit", Budget().Read().Code);
        Assert.True(File.Exists(Path.Combine(root, "unuploaded-orphan.partial")));
    }

    [Fact]
    public void OneHourOfSyntheticDualTrackPcmIsAccountedAsEncryptedFilesAndRemainsRecoverable()
    {
        var other = Guid.NewGuid();
        var store = new RecordingStore(root, recording,
            [new(track, "microphone", "endpoint", "explicit", "synthetic-mic"),
             new(other, "loopback", "endpoint", "explicit", "synthetic-output")], protector, storage: Budget());
        var writers = new[] { new PcmChunkWriter(store, track), new PcmChunkWriter(store, other) };
        foreach (var writer in writers) writer.BeginEpoch(Guid.NewGuid());
        var pcm = new byte[PcmChunkWriter.MaxSamples * 2];
        for (var i = 0; i < 120; i++)
            foreach (var writer in writers) writer.Append(pcm, i * 30_000, (i + 1) * 30_000);
        store.Transition("sealed", "capture.stopped", 3_600_000);
        var report = RecordingStore.Inspect(root, recording, protector);
        Assert.Equal("sealed", report.State);
        Assert.Equal(240, report.VerifiedChunks);
        Assert.Equal(2L * 3600 * 16_000, report.TotalSamples);
        Assert.True(Budget().Read().UsedBytes > report.TotalSamples * 2);
        Assert.Equal(Directory.GetFiles(root, "*", SearchOption.AllDirectories).Sum(path => new FileInfo(path).Length),
            Budget().Read().UsedBytes);
    }

    [Fact]
    public void UnreadableCapacityNeverBecomesAnEmptyOrHealthySnapshot()
    {
        File.WriteAllBytes(Path.Combine(root, "unique-copy"), [1, 2, 3]);
        var budget = Budget(() => throw new IOException("Synthetic capacity failure."));
        Assert.Equal("storage_unavailable", Assert.Throws<AudioException>(() => budget.Read()).Code);
        Assert.Equal("storage_unavailable", Assert.Throws<AudioException>(budget.EnsureCaptureCapacity).Code);
        Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(Path.Combine(root, "unique-copy")));
        Assert.Throws<AudioException>(() => budget.Read(0));
        Assert.Throws<AudioException>(() => new StorageBudget(root, StorageBudget.GiB + 1));
        Assert.Throws<AudioException>(() => new StorageBudget(root, 51 * StorageBudget.GiB));
    }

    [Fact]
    public void LinkedStorageIsNotFollowedOrCountedAsVerifiedCapacity()
    {
        if (OperatingSystem.IsWindows()) return;
        var outside = Path.Combine(directory, "outside");
        Directory.CreateDirectory(outside);
        File.WriteAllBytes(Path.Combine(outside, "preserved"), [9, 8, 7]);
        Directory.CreateSymbolicLink(Path.Combine(root, "linked"), outside);
        Assert.Equal("storage_unavailable", Assert.Throws<AudioException>(() => Budget().Read()).Code);
        Assert.Equal(new byte[] { 9, 8, 7 }, File.ReadAllBytes(Path.Combine(outside, "preserved")));
    }

    public void Dispose() => Directory.Delete(directory, recursive: true);
}
