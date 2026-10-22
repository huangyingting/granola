using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateWorkerJournalTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-worker-journal-{Guid.NewGuid():D}");
    private readonly string directory;
    private string Pathname => Path.Combine(directory, UpdateWorkerJournal.Filename);

    public UpdateWorkerJournalTests()
    {
        Directory.CreateDirectory(root);
        directory = Path.Combine(root, $"worker-{Guid.NewGuid():D}");
        new DirectoryInfo(directory).Create(UpdatePrivateDirectory.Security());
    }

    [Fact]
    public void FlushesAndAtomicallyReplacesBoundedSingleUseDurableOutcomes()
    {
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        foreach (var phase in new[] { "preparing", "prepared", "committed", "installing", "installed" })
        {
            journal.Write(phase, "update_worker_test", phase == "installed", phase == "installed" ? 0 : null,
                phase == "installed" ? new(1234, "134000000000000001") : null);
            var bytes = File.ReadAllBytes(Pathname);
            Assert.True(bytes.Length < 2048);
            Assert.Equal(journal.Latest, JsonSerializer.Deserialize<UpdateWorkerOutcome>(bytes, AudioJson.Options));
            Assert.Equal(Path.GetFileName(directory)[7..], journal.Latest!.SessionId);
            Assert.DoesNotContain(Directory.GetFiles(directory), path => path.EndsWith(".tmp", StringComparison.Ordinal));
        }
        Assert.Throws<InvalidOperationException>(() => journal.Write("prepared", "update_worker_test"));
        Assert.Equal("update_worker_used", Assert.Throws<UpdateHandoffException>(
            () => new UpdateWorkerJournal(directory, "0.1.0", "0.1.1")).Code);
    }

    [Fact]
    public void DoesNotEraseTheLastDurablePhaseWhenReplacementFails()
    {
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        var original = File.ReadAllBytes(Pathname);
        File.SetAttributes(Pathname, FileAttributes.ReadOnly);
        try
        {
            var error = Record.Exception(() => journal.Write("prepared", "update_worker_prepared"));
            Assert.True(error is IOException or UnauthorizedAccessException);
            Assert.Equal(original, File.ReadAllBytes(Pathname));
            Assert.Equal("preparing", journal.Latest!.Phase);
            Assert.Single(Directory.EnumerateFileSystemEntries(directory));
        }
        finally { File.SetAttributes(Pathname, FileAttributes.Normal); }
    }

    [Fact]
    public void NeverRewindsKnownInstallerStartOrRecordsSuccessWithoutAnExitZero()
    {
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        journal.Write("prepared", "update_worker_prepared");
        journal.Write("committed", "update_worker_committed");
        journal.Write("installing", "update_installer_started", true);
        Assert.Throws<InvalidOperationException>(() => journal.Write("failed", "update_installer_failed"));
        Assert.Throws<InvalidOperationException>(() => journal.Write("installed", "update_worker_installed", true, 1));
        Assert.Throws<InvalidOperationException>(() => journal.Write("installed", "update_worker_installed", true, 0));
        journal.Write("failed", "update_installer_failed", true, 2);
        Assert.True(journal.Latest!.InstallerStarted);
        Assert.Equal(2, journal.Latest.InstallerExitCode);
    }

    [Fact]
    public void PreservesExactInstallerIdentityAndRejectsReplacementOrInvalidIdentity()
    {
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        journal.Write("prepared", "update_worker_prepared");
        journal.Write("committed", "update_worker_committed");
        var identity = new UpdateParentIdentity(1234, "134000000000000001");
        foreach (var invalid in new[] { identity with { Pid = 0 }, identity with { CreationFileTime = "0134000000000000001" },
            identity with { CreationFileTime = "-1" }, identity with { CreationFileTime = "9223372036854775808" } })
            Assert.Throws<InvalidOperationException>(() =>
                journal.Write("installing", "update_installer_started", true, installerProcess: invalid));
        journal.Write("installing", "update_installer_started", true, installerProcess: identity);
        Assert.Throws<InvalidOperationException>(() => journal.Write("installing", "update_installer_started", true,
            installerProcess: identity with { Pid = 5678 }));
        journal.Write("installing", "update_installer_timeout", true);
        Assert.Equal(identity, journal.Latest!.InstallerProcess);
        journal.Write("installed", "update_worker_installed", true, 0);
        Assert.Equal(identity, journal.Latest!.InstallerProcess);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
