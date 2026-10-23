using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateSessionRetentionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-update-retention-{Guid.NewGuid():N}");
    private string Workers => Path.Combine(root, "workers");
    private string Retired => Path.Combine(root, "retired");
    private string Source => Path.Combine(root, "source");

    public UpdateSessionRetentionTests()
    {
        Directory.CreateDirectory(root);
        new DirectoryInfo(Workers).Create(UpdatePrivateDirectory.Security());
        foreach (var name in UpdateRuntimeStager.RequiredFiles)
        {
            var path = Path.Combine(Source, name);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, $"Synthetic nonexecutable runtime member: {name}");
        }
        File.WriteAllText(Path.Combine(root, "notes.sqlite"), "Synthetic notes canary outside all runtime roots.");
    }

    [Fact]
    public void RetainsTheTwoNewestHealthySessionsAndMovesOnlyABoundedOlderBatchBeforeResumableDeletion()
    {
        var sessions = Enumerable.Range(0, 7).Select(_ => Healthy()).ToArray();
        var latest = sessions.OrderByDescending(directory => UpdateWorkerJournal.Read(directory)!.UpdatedAt, StringComparer.Ordinal)
            .ThenBy(directory => Path.GetFileName(directory), StringComparer.Ordinal).Take(2).ToDictionary(directory => directory, Snapshot);
        var notes = File.ReadAllBytes(Path.Combine(root, "notes.sqlite"));
        var first = UpdateSessionRetention.Retire(Workers, Retired);
        Assert.Equal(new(4, 0, 0, 0), first);
        Assert.Equal(3, Directory.GetDirectories(Workers).Length);
        Assert.Equal(4, Directory.GetDirectories(Retired).Length);
        UpdateStartupRecovery.RequireSafe(Workers);
        Assert.Equal(1, UpdateSessionRetention.Retire(Workers, Retired).Retired);
        Assert.Equal(2, UpdateSessionRetention.Drain(Retired).Removed);
        Assert.Equal(2, UpdateSessionRetention.Drain(Retired).Removed);
        Assert.Equal(1, UpdateSessionRetention.Drain(Retired).Removed);
        Assert.Empty(Directory.EnumerateFileSystemEntries(Retired));
        foreach (var (directory, files) in latest) AssertSnapshot(directory, files);
        Assert.Equal(notes, File.ReadAllBytes(Path.Combine(root, "notes.sqlite")));
    }

    [Theory]
    [InlineData("committed")]
    [InlineData("installed")]
    [InlineData("torn-health")]
    [InlineData("corrupt-health")]
    public void AnUnresolvedOrCorruptSessionPreventsAnyRetirementAndCannotBeWashedAwayByCleanup(string fault)
    {
        for (var index = 0; index < 3; index++) Healthy();
        var staged = Stage();
        var journal = Installed(staged);
        if (fault == "committed")
            File.WriteAllText(Path.Combine(staged.Directory, UpdateRuntimeState.Filename),
                File.ReadAllText(Path.Combine(staged.Directory, UpdateRuntimeState.Filename)).Replace("\"installing\"", "\"committed\"", StringComparison.Ordinal));
        if (fault is "torn-health" or "corrupt-health")
        {
            var previous = File.ReadAllBytes(Path.Combine(staged.Directory, UpdateRuntimeState.Filename));
            journal.WriteHealthy(Proof(staged.Directory));
            if (fault == "torn-health") File.WriteAllBytes(Path.Combine(staged.Directory, UpdateRuntimeState.Filename), previous);
            else
            {
                var path = Path.Combine(staged.Directory, UpdateRuntimeState.Filename);
                var state = JsonNode.Parse(File.ReadAllText(path))!;
                state["resolution"] = "not a protected resolution";
                File.WriteAllText(path, state.ToJsonString());
            }
        }
        var snapshots = Directory.GetDirectories(Workers).ToDictionary(directory => directory, Snapshot);
        Assert.Throws<UpdateHandoffException>(() => UpdateSessionRetention.Retire(Workers, Retired));
        Assert.False(Directory.Exists(Retired));
        foreach (var (directory, files) in snapshots) AssertSnapshot(directory, files);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("unknown")]
    [InlineData("duplicate")]
    [InlineData("hash")]
    [InlineData("path")]
    [InlineData("alias")]
    [InlineData("order")]
    [InlineData("oversized")]
    public void ThePlainDeletionIndexNeverAuthorizesRetirementWithoutTheMatchingSealedRuntimeDigest(string fault)
    {
        var oldest = ThreeHealthy();
        var path = Path.Combine(oldest, UpdateRuntimeFiles.Filename);
        var json = JsonNode.Parse(File.ReadAllText(path))!;
        switch (fault)
        {
            case "unknown": json["healthy"] = true; break;
            case "hash": json["files"]![0]!["sha256"] = new string('f', 64); break;
            case "path": json["files"]![0]!["path"] = "../notes.sqlite"; break;
            case "alias": json["files"]![1]!["path"] = json["files"]![0]!["path"]!.DeepClone(); break;
            case "order":
                var files = json["files"]!.AsArray();
                var first = files[0]!.DeepClone();
                files[0] = files[1]!.DeepClone();
                files[1] = first;
                break;
        }
        File.WriteAllText(path, json.ToJsonString());
        if (fault == "missing") File.Delete(path);
        if (fault == "duplicate") File.WriteAllText(path, File.ReadAllText(path).Replace("\"version\":1", "\"version\":1,\"version\":1", StringComparison.Ordinal));
        if (fault == "oversized") File.WriteAllText(path, new string('x', UpdateRuntimeSeal.MaximumBytes + 1));
        var filesBefore = Snapshot(oldest);
        var result = UpdateSessionRetention.Retire(Workers, Retired);
        Assert.Equal(0, result.Retired);
        Assert.Equal(1, result.Rejected + result.Incomplete);
        AssertSnapshot(oldest, filesBefore);
        UpdateStartupRecovery.RequireSafe(Workers);
    }

    [Theory]
    [InlineData("payload")]
    [InlineData("state")]
    [InlineData("outcome")]
    [InlineData("receipt")]
    [InlineData("index")]
    [InlineData("extra")]
    [InlineData("session")]
    public void ChangedOrUnexpectedRetiredDataIsRetainedRatherThanDeletedAsSuccessfulCleanup(string fault)
    {
        var retired = RetireOldest();
        var path = Path.Combine(retired, fault switch
        {
            "payload" => "AudioHost.Core.dll",
            "state" => UpdateRuntimeState.Filename,
            "outcome" => UpdateWorkerJournal.Filename,
            "receipt" => UpdateSessionRetention.ReceiptFilename,
            "index" => UpdateRuntimeFiles.Filename,
            _ => "notes.sqlite"
        });
        if (fault == "payload")
        {
            var bytes = File.ReadAllBytes(path);
            bytes[^1] ^= 1;
            File.WriteAllBytes(path, bytes);
        }
        else if (fault == "session")
        {
            var moved = Path.Combine(Retired, $"worker-{Guid.NewGuid():D}");
            Directory.Move(retired, moved);
            retired = moved;
        }
        else if (fault == "extra") File.WriteAllText(path, "Synthetic unexpected note must not be removed.");
        else
        {
            var json = JsonNode.Parse(File.ReadAllText(path))!;
            json["version"] = 2;
            File.WriteAllText(path, json.ToJsonString());
        }
        var before = Snapshot(retired);
        var result = UpdateSessionRetention.Drain(Retired);
        Assert.Equal(0, result.Removed);
        Assert.Equal(1, result.Rejected + result.Incomplete);
        AssertSnapshot(retired, before);
        UpdateStartupRecovery.RequireSafe(Workers);
    }

    [Theory]
    [InlineData("payload")]
    [InlineData("one-journal")]
    [InlineData("both-journals")]
    [InlineData("receipt-only")]
    [InlineData("empty")]
    public void ResumesInterruptedDeletionWithoutRestoringAnActiveFenceOrNeedingAlreadyDeletedPayload(string boundary)
    {
        var retired = RetireOldest();
        if (boundary == "payload") File.Delete(Path.Combine(retired, "AudioHost.Core.dll"));
        else if (boundary is "one-journal" or "both-journals")
        {
            File.Delete(Path.Combine(retired, UpdateRuntimeState.Filename));
            if (boundary == "both-journals") File.Delete(Path.Combine(retired, UpdateWorkerJournal.Filename));
        }
        else
        {
            foreach (var file in UpdateRuntimeStager.RequiredFiles) File.Delete(Path.Combine(retired, file));
            Directory.Delete(Path.Combine(retired, "licenses", "dotnet"));
            Directory.Delete(Path.Combine(retired, "licenses"));
            File.Delete(Path.Combine(retired, UpdateRuntimeState.Filename));
            File.Delete(Path.Combine(retired, UpdateWorkerJournal.Filename));
            File.Delete(Path.Combine(retired, UpdateRuntimeFiles.Filename));
            if (boundary == "empty") File.Delete(Path.Combine(retired, UpdateSessionRetention.ReceiptFilename));
        }
        Assert.Equal(new(0, 1, 0, 0), UpdateSessionRetention.Drain(Retired));
        Assert.False(Directory.Exists(retired));
        UpdateStartupRecovery.RequireSafe(Workers);
    }

    [Fact]
    public void APhysicalSourceLeasePreventsRetirementAndALockedRetiredMemberRemainsPendingUntilReleased()
    {
        var oldest = ThreeHealthy();
        using (UpdatePathLock.OpenDirectory(oldest))
        {
            var blocked = UpdateSessionRetention.Retire(Workers, Retired);
            Assert.Equal(1, blocked.Incomplete);
            Assert.Equal(0, blocked.Retired);
            Assert.False(File.Exists(Path.Combine(oldest, UpdateSessionRetention.ReceiptFilename)));
        }
        Assert.Equal(1, UpdateSessionRetention.Retire(Workers, Retired).Retired);
        var retired = Path.Combine(Retired, Path.GetFileName(oldest));
        using (File.OpenRead(Path.Combine(retired, UpdateRuntimeFiles.Filename)))
        {
            var before = Snapshot(retired);
            var blocked = UpdateSessionRetention.Drain(Retired);
            Assert.Equal(1, blocked.Incomplete);
            AssertSnapshot(retired, before);
        }
        Assert.Equal(1, UpdateSessionRetention.Drain(Retired).Removed);
    }

    [Fact]
    public void CancellationDoesNotPretendCleanupSucceededAndReadOnlyPayloadIsNeverSilentlyUnprotected()
    {
        var retired = RetireOldest();
        var before = Snapshot(retired);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => UpdateSessionRetention.Drain(Retired, cancelled.Token));
        AssertSnapshot(retired, before);
        var path = Path.Combine(retired, "AudioHost.Core.dll");
        File.SetAttributes(path, FileAttributes.ReadOnly);
        try
        {
            Assert.Equal(1, UpdateSessionRetention.Drain(Retired).Incomplete);
            Assert.True(File.Exists(Path.Combine(retired, UpdateSessionRetention.ReceiptFilename)));
        }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
        Assert.Equal(1, UpdateSessionRetention.Drain(Retired).Removed);
    }

    [Theory]
    [InlineData("file-link")]
    [InlineData("directory-link")]
    [InlineData("hard-link")]
    public void RejectsLinksWithoutFollowingThemOrDeletingAnExternalCanary(string mode)
    {
        var retired = RetireOldest();
        var canary = Path.Combine(root, "notes.sqlite");
        var expected = File.ReadAllBytes(canary);
        if (mode == "directory-link") Directory.CreateSymbolicLink(Path.Combine(retired, "outside"), Source);
        else
        {
            var path = Path.Combine(retired, "AudioHost.Core.dll");
            File.Delete(path);
            if (mode == "file-link") File.CreateSymbolicLink(path, canary);
            else Assert.True(CreateHardLink(path, canary, 0), new Win32Exception(Marshal.GetLastPInvokeError()).Message);
        }
        var result = UpdateSessionRetention.Drain(Retired);
        Assert.Equal(0, result.Removed);
        Assert.Equal(1, result.Incomplete + result.Rejected);
        Assert.Equal(expected, File.ReadAllBytes(canary));
        Assert.True(File.Exists(Path.Combine(retired, UpdateSessionRetention.ReceiptFilename)));
    }

    [Fact]
    public void BoundedFullOrUnexpectedRetirementQueuesNeverEvictUnknownDataToMakeRoom()
    {
        var oldest = ThreeHealthy();
        new DirectoryInfo(Retired).Create(UpdatePrivateDirectory.Security());
        for (var index = 0; index < UpdateSessionRetention.MaximumRetired; index++)
            new DirectoryInfo(Path.Combine(Retired, $"worker-{Guid.NewGuid():D}")).Create(UpdatePrivateDirectory.Security());
        Assert.Equal(1, UpdateSessionRetention.Retire(Workers, Retired).Incomplete);
        Assert.True(Directory.Exists(oldest));
        Directory.Delete(Directory.GetDirectories(Retired)[0]);
        File.WriteAllText(Path.Combine(Retired, "notes.sqlite"), "Synthetic unexpected queue member.");
        Assert.Equal(1, UpdateSessionRetention.Retire(Workers, Retired).Rejected);
        Assert.Equal(1, UpdateSessionRetention.Drain(Retired).Rejected);
        Assert.Equal(UpdateSessionRetention.MaximumRetired - 1, Directory.GetDirectories(Retired).Length);
        Assert.True(File.Exists(Path.Combine(Retired, "notes.sqlite")));
    }

    [Fact]
    public void DeletionLeasesKeepTheOriginalPrivateRuntimeSecurityReadableWithoutReopeningTheDirectories()
    {
        var runtime = Stage();
        using var directory = UpdatePathLock.OpenForRemoval(runtime.Directory, directory: true);
        UpdatePrivateDirectory.Require(directory);
        foreach (var child in Directory.EnumerateDirectories(runtime.Directory, "*", SearchOption.AllDirectories))
        {
            using var held = UpdatePathLock.OpenForRemoval(child, directory: true);
            UpdatePrivateDirectory.Require(held, requireProtected: false);
        }
        foreach (var path in Directory.EnumerateFiles(runtime.Directory, "*", SearchOption.AllDirectories))
        {
            using var handle = UpdatePathLock.OpenForRemoval(path, directory: false);
            using var stream = new FileStream(handle, FileAccess.Read);
            UpdatePrivateDirectory.RequireFile(stream);
        }
    }

    [Fact]
    public void RenameAndDeleteUseTheOriginalKernelHandleAndNeverReplaceAnExistingDestination()
    {
        var source = Path.Combine(Workers, $"worker-{Guid.NewGuid():D}");
        new DirectoryInfo(source).Create(UpdatePrivateDirectory.Security());
        new DirectoryInfo(Retired).Create(UpdatePrivateDirectory.Security());
        var destination = Path.Combine(Retired, Path.GetFileName(source));
        using (var held = UpdatePathLock.OpenForRemoval(source, directory: true))
        {
            Assert.Throws<IOException>(() => Directory.Move(source, source + "-replaced"));
            UpdatePathLock.Rename(held, destination);
            Assert.False(Directory.Exists(source));
            Assert.True(Directory.Exists(destination));
            Assert.Throws<IOException>(() => Directory.Move(destination, destination + "-replaced"));
            UpdatePathLock.Delete(held);
        }
        Assert.False(Directory.Exists(destination));
        Directory.CreateDirectory(source);
        Directory.CreateDirectory(destination);
        File.WriteAllText(Path.Combine(destination, "notes.sqlite"), "Do not replace.");
        using var original = UpdatePathLock.OpenForRemoval(source, directory: true);
        Assert.Throws<Win32Exception>(() => UpdatePathLock.Rename(original, destination));
        Assert.Equal("Do not replace.", File.ReadAllText(Path.Combine(destination, "notes.sqlite")));
    }

    [Fact]
    public void AnActiveRootCannotBeItsOwnRetirementQueueAndAnAbsentRootCreatesNothing()
    {
        Assert.Equal(UpdateCleanupCounts.Empty, UpdateSessionRetention.Retire(Workers, Retired));
        Assert.False(Directory.Exists(Retired));
        var oldest = ThreeHealthy();
        var before = Snapshot(oldest);
        Assert.Equal(1, UpdateSessionRetention.Retire(Workers, Workers).Rejected);
        AssertSnapshot(oldest, before);
        Assert.Equal(3, Directory.GetDirectories(Workers).Length);
    }

    [Theory]
    [InlineData("notes")]
    [InlineData("folder")]
    public void UnexpectedActiveSessionContentsAreNotEvenMovedIntoTheRetirementQueue(string kind)
    {
        var oldest = ThreeHealthy();
        if (kind == "notes") File.WriteAllText(Path.Combine(oldest, "notes.sqlite"), "Synthetic unexpected notes must not move.");
        else Directory.CreateDirectory(Path.Combine(oldest, "local profile"));
        var before = Snapshot(oldest);
        var result = UpdateSessionRetention.Retire(Workers, Retired);
        Assert.Equal(0, result.Retired);
        Assert.Equal(1, result.Rejected);
        AssertSnapshot(oldest, before);
        Assert.False(File.Exists(Path.Combine(oldest, UpdateSessionRetention.ReceiptFilename)));
        Assert.Empty(Directory.EnumerateFileSystemEntries(Retired));
    }

    private string RetireOldest()
    {
        var oldest = ThreeHealthy();
        Assert.Equal(new(1, 0, 0, 0), UpdateSessionRetention.Retire(Workers, Retired));
        Assert.False(Directory.Exists(oldest));
        return Path.Combine(Retired, Path.GetFileName(oldest));
    }

    private string ThreeHealthy()
    {
        return Enumerable.Range(0, 3).Select(_ => Healthy())
            .OrderBy(directory => UpdateWorkerJournal.Read(directory)!.UpdatedAt, StringComparer.Ordinal)
            .ThenByDescending(directory => Path.GetFileName(directory), StringComparer.Ordinal).First();
    }

    private string Healthy()
    {
        var staged = Stage();
        Installed(staged).WriteHealthy(Proof(staged.Directory));
        return staged.Directory;
    }

    private StagedUpdateRuntime Stage() =>
        UpdateRuntimeStager.Copy(Source, Source, Workers, UpdateRuntimeStager.RequiredFiles);

    private static UpdateRestartProof Proof(string directory) =>
        new(Path.GetFileName(directory)[7..], new(5678, "134000000000000002"), "0.1.1", 8);

    private static UpdateWorkerJournal Installed(StagedUpdateRuntime runtime)
    {
        UpdateRuntimeState.Claim(runtime.Directory, runtime.Sha256);
        var journal = new UpdateWorkerJournal(runtime.Directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        journal.Write("prepared", "update_worker_prepared");
        journal.Write("committed", "update_worker_committed");
        journal.Write("installing", "update_installer_started", true, installerProcess: new(1234, "134000000000000001"));
        journal.Write("installed", "update_worker_installed", true, 0);
        return journal;
    }

    private static Dictionary<string, byte[]> Snapshot(string directory) =>
        Directory.GetFiles(directory, "*", SearchOption.AllDirectories).ToDictionary(
            path => Path.GetRelativePath(directory, path), File.ReadAllBytes);

    private static void AssertSnapshot(string directory, Dictionary<string, byte[]> expected)
    {
        var actual = Snapshot(directory);
        Assert.Equal(expected.Keys.Order(), actual.Keys.Order());
        foreach (var (name, bytes) in expected) Assert.Equal(bytes, actual[name]);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);

    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string path, string existing, nint security);
}
