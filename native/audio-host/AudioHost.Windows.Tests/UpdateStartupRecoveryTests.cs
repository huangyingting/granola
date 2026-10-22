using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateStartupRecoveryTests : IDisposable
{
    private readonly string parent = Path.Combine(Path.GetTempPath(), $"notes-startup-recovery-{Guid.NewGuid():D}");
    private string Root => Path.Combine(parent, "workers");
    private const string Manifest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    public UpdateStartupRecoveryTests()
    {
        Directory.CreateDirectory(parent);
        new DirectoryInfo(Root).Create(UpdatePrivateDirectory.Security());
    }

    [Theory]
    [InlineData("staged", null)]
    [InlineData("claimed", "update_recovery_required")]
    [InlineData("preparing", null)]
    [InlineData("prepared", null)]
    [InlineData("failed-before-commit", null)]
    [InlineData("committed", "update_recovery_required")]
    [InlineData("failed-after-commit", "update_recovery_required")]
    [InlineData("installing-intent", "update_recovery_required")]
    [InlineData("installing-started", "update_recovery_required")]
    [InlineData("failed-after-start", "update_recovery_required")]
    [InlineData("installed", "update_recovery_required")]
    public void OnlyAllowsUncommittedSessionsAndNeverTreatsAnInstalledOutcomeAsFreshHealth(string scenario, string? code)
    {
        var directory = Session();
        if (scenario != "staged") UpdateRuntimeState.Claim(directory, Manifest);
        if (scenario is not ("staged" or "claimed"))
        {
            var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
            journal.Write("preparing", "update_worker_preparing");
            if (scenario != "preparing")
            {
                journal.Write("prepared", "update_worker_prepared");
                if (scenario == "failed-before-commit") journal.Write("failed", "update_signature_invalid");
                else if (scenario != "prepared")
                {
                    journal.Write("committed", "update_worker_committed");
                    if (scenario == "failed-after-commit") journal.Write("failed", "update_worker_cancelled");
                    else if (scenario != "committed")
                    {
                        journal.Write("installing", "update_installer_starting");
                        if (scenario != "installing-intent")
                        {
                            journal.Write("installing", "update_installer_started", true,
                                installerProcess: new(1234, "134000000000000001"));
                            if (scenario == "installed") journal.Write("installed", "update_worker_installed", true, 0);
                            if (scenario == "failed-after-start") journal.Write("failed", "update_installer_failed", true, 2);
                        }
                    }
                }
            }
        }
        var files = Directory.GetFiles(directory).ToDictionary(path => path, File.ReadAllBytes);
        if (code is null) UpdateStartupRecovery.RequireSafe(Root);
        else Assert.Equal(code, Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
        Assert.Equal(files.Keys.Order(), Directory.GetFiles(directory).Order());
        foreach (var (path, bytes) in files) Assert.Equal(bytes, File.ReadAllBytes(path));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("session")]
    [InlineData("manifest")]
    [InlineData("time")]
    [InlineData("phase")]
    [InlineData("missing-property")]
    [InlineData("null-property")]
    [InlineData("unknown-property")]
    [InlineData("duplicate-property")]
    [InlineData("malformed")]
    [InlineData("oversized")]
    [InlineData("missing-marker")]
    public void MissingLegacyOrInvalidRuntimeStateNeverBecomesUnusedByDefault(string fault)
    {
        var directory = Session();
        var path = Path.Combine(directory, UpdateRuntimeState.Filename);
        var state = JsonNode.Parse(File.ReadAllText(path))!;
        switch (fault)
        {
            case "version": state["version"] = 2; break;
            case "session": state["session_id"] = Guid.NewGuid().ToString("D"); break;
            case "manifest": state["runtime_sha256"] = new string('A', 64); break;
            case "time": state["updated_at"] = "yesterday"; break;
            case "phase": state["phase"] = "healthy"; break;
            case "missing-property": state.AsObject().Remove("phase"); break;
            case "null-property": state["phase"] = null; break;
            case "unknown-property": state["parent_pid"] = 1234; break;
        }
        File.WriteAllText(path, state.ToJsonString());
        if (fault == "duplicate-property")
            File.WriteAllText(path, File.ReadAllText(path).Replace("\"version\":1", "\"version\":1,\"version\":1", StringComparison.Ordinal));
        if (fault == "malformed") File.WriteAllText(path, "{");
        if (fault == "oversized") File.WriteAllText(path, new string('x', 16_385));
        if (fault == "missing-marker") File.Delete(path);
        Assert.Equal("update_recovery_invalid",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
    }

    [Theory]
    [InlineData("unknown-field")]
    [InlineData("missing-field")]
    [InlineData("session")]
    [InlineData("version")]
    [InlineData("versions")]
    [InlineData("identity")]
    [InlineData("started")]
    [InlineData("phase")]
    [InlineData("time")]
    [InlineData("duplicate-field")]
    public void DoesNotAcceptDamagedOrContradictoryOutcomeSnapshots(string fault)
    {
        var directory = Session();
        UpdateRuntimeState.Claim(directory, Manifest);
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        var path = Path.Combine(directory, UpdateWorkerJournal.Filename);
        var outcome = JsonNode.Parse(File.ReadAllText(path))!;
        switch (fault)
        {
            case "unknown-field": outcome["handle"] = 42; break;
            case "missing-field": outcome.AsObject().Remove("installer_started"); break;
            case "session": outcome["session_id"] = Guid.NewGuid().ToString("D"); break;
            case "version": outcome["version"] = 2; break;
            case "versions": outcome["offered_version"] = "0.1.0"; break;
            case "identity": outcome["installer_process"] = JsonSerializer.SerializeToNode(new UpdateParentIdentity(1234, "0134"), AudioJson.Options); break;
            case "started": outcome["installer_started"] = true; break;
            case "phase": outcome["phase"] = "installed"; break;
            case "time": outcome["updated_at"] = "2026-10-22"; break;
        }
        File.WriteAllText(path, outcome.ToJsonString());
        if (fault == "duplicate-field")
            File.WriteAllText(path, File.ReadAllText(path).Replace("\"version\":1", "\"version\":1,\"version\":1", StringComparison.Ordinal));
        Assert.Equal("update_recovery_invalid",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
    }

    [Fact]
    public void ACommittedFenceSurvivesAnUndurableOutcomeAndAReportedPrelaunchFailure()
    {
        var directory = Session();
        UpdateRuntimeState.Claim(directory, Manifest);
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        journal.Write("prepared", "update_worker_prepared");
        var path = Path.Combine(directory, UpdateWorkerJournal.Filename);
        File.SetAttributes(path, FileAttributes.ReadOnly);
        try { Assert.Throws<IOException>(() => journal.Write("committed", "update_worker_committed")); }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
        Assert.Equal("prepared", UpdateWorkerJournal.Read(directory)!.Phase);
        Assert.Equal("committed", UpdateRuntimeState.Read(directory).Phase);
        journal.Write("failed", "update_worker_outcome_failed");
        Assert.False(UpdateWorkerJournal.Read(directory)!.InstallerStarted);
        Assert.Equal("update_recovery_required",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
    }

    [Fact]
    public void AnUnusedMarkerCannotHideAnExistingOutcomeAndAnIntentCannotBeRewoundOrReused()
    {
        var directory = Session();
        var staged = File.ReadAllBytes(Path.Combine(directory, UpdateRuntimeState.Filename));
        UpdateRuntimeState.Claim(directory, Manifest);
        Assert.Equal("update_worker_used", Assert.Throws<UpdateHandoffException>(() => UpdateRuntimeState.Claim(directory, Manifest)).Code);
        var journal = new UpdateWorkerJournal(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        File.WriteAllBytes(Path.Combine(directory, UpdateRuntimeState.Filename), staged);
        Assert.Equal("update_recovery_invalid",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
        Assert.Equal("update_recovery_invalid",
            Assert.Throws<UpdateHandoffException>(() => UpdateRuntimeState.RecordIntent(directory, "installing")).Code);
    }

    [Fact]
    public void RejectsWeakStatePermissionsUnexpectedEntriesAndUnboundedSessionCounts()
    {
        var directory = Session();
        var file = new FileInfo(Path.Combine(directory, UpdateRuntimeState.Filename));
        var permissions = file.GetAccessControl();
        permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null),
            FileSystemRights.Read, AccessControlType.Allow));
        file.SetAccessControl(permissions);
        Assert.Equal("update_recovery_unavailable",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
        Directory.Delete(directory, recursive: true);
        File.WriteAllText(Path.Combine(Root, "unexpected"), "unrecognized");
        Assert.Equal("update_recovery_invalid",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
        File.Delete(Path.Combine(Root, "unexpected"));
        for (var index = 0; index <= UpdateStartupRecovery.MaximumSessions; index++) Session();
        Assert.Equal("update_recovery_limit",
            Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(Root)).Code);
    }

    [Fact]
    public void ClaimBindsTheActualExecutableManifestAndLeavesMismatchUnused()
    {
        var directory = Session();
        Assert.Equal("update_worker_source", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeState.Claim(directory, new string('b', 64))).Code);
        Assert.Equal("staged", UpdateRuntimeState.Read(directory).Phase);
        UpdateStartupRecovery.RequireSafe(Root);
    }

    [Fact]
    public void AbsentOrEmptyRuntimeRootsDoNotCreateStateOrTouchAnyOtherDirectory()
    {
        UpdateStartupRecovery.RequireSafe(Root);
        Directory.Delete(Root);
        UpdateStartupRecovery.RequireSafe(Root);
        Assert.False(Directory.Exists(Root));
        Assert.Empty(Directory.EnumerateFileSystemEntries(parent));
    }

    private string Session()
    {
        var directory = Path.Combine(Root, $"worker-{Guid.NewGuid():D}");
        new DirectoryInfo(directory).Create(UpdatePrivateDirectory.Security());
        UpdateRuntimeState.Stage(directory, Manifest);
        return directory;
    }

    public void Dispose() => Directory.Delete(parent, recursive: true);
}
