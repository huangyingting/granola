using System.Text.Json.Nodes;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateHealthyResolutionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-healthy-resolution-{Guid.NewGuid():N}");
    private readonly string directory;
    private readonly UpdateWorkerJournal journal;
    private readonly UpdateRestartProof proof;

    public UpdateHealthyResolutionTests()
    {
        new DirectoryInfo(root).Create(UpdatePrivateDirectory.Security());
        var session = Guid.NewGuid();
        directory = Path.Combine(root, $"worker-{session:D}");
        new DirectoryInfo(directory).Create(UpdatePrivateDirectory.Security());
        UpdateRuntimeState.Stage(directory, new('a', 64));
        UpdateRuntimeState.Claim(directory, new('a', 64));
        journal = new(directory, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        journal.Write("prepared", "update_worker_prepared");
        journal.Write("committed", "update_worker_committed");
        journal.Write("installing", "update_installer_started", true, installerProcess: new(1234, "134000000000000001"));
        journal.Write("installed", "update_worker_installed", true, 0);
        proof = new(session.ToString("D"), new(5678, "134000000000000002"), "0.1.1", 8);
    }

    [Fact]
    public void OnlyOwnerCompletedHealthyResolutionAllowsSubsequentNormalStartupWithoutRewritingAnyFiles()
    {
        Assert.Equal("update_recovery_required", Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(root)).Code);
        journal.WriteHealthy(proof);
        var state = UpdateRuntimeState.Read(directory);
        Assert.Equal("healthy", state.Phase);
        Assert.Equal(proof, state.Health);
        Assert.NotNull(state.Resolution);
        Assert.DoesNotContain(proof.Identity.CreationFileTime, state.Resolution);
        Assert.Equal(proof, UpdateWorkerJournal.Read(directory)!.Restart);
        var snapshots = Directory.GetFiles(directory).ToDictionary(path => path, File.ReadAllBytes);
        UpdateStartupRecovery.RequireSafe(root);
        foreach (var (path, bytes) in snapshots) Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Throws<InvalidOperationException>(() => journal.WriteHealthy(proof));
        Assert.Throws<InvalidOperationException>(() => journal.Write("failed", "update_restart_timeout", true, 0));
        Assert.Equal("update_worker_used", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeState.Claim(directory, new('a', 64))).Code);
    }

    [Theory]
    [InlineData("missing-receipt")]
    [InlineData("invalid-receipt")]
    [InlineData("mutated-receipt")]
    [InlineData("manifest")]
    [InlineData("schema")]
    [InlineData("identity")]
    [InlineData("version")]
    [InlineData("timestamp")]
    [InlineData("installer")]
    [InlineData("session")]
    [InlineData("lost-outcome")]
    public void RejectsMetadataOnlyHealthAndEveryProtectedReceiptContextChange(string fault)
    {
        journal.WriteHealthy(proof);
        var statePath = Path.Combine(directory, UpdateRuntimeState.Filename);
        var outcomePath = Path.Combine(directory, UpdateWorkerJournal.Filename);
        var state = JsonNode.Parse(File.ReadAllText(statePath))!;
        var outcome = JsonNode.Parse(File.ReadAllText(outcomePath))!;
        var otherSession = Guid.NewGuid().ToString("D");
        switch (fault)
        {
            case "missing-receipt": state.AsObject().Remove("resolution"); break;
            case "invalid-receipt": state["resolution"] = "not a protected receipt"; break;
            case "mutated-receipt":
                var wrapped = Convert.FromBase64String(state["resolution"]!.GetValue<string>());
                wrapped[^1] ^= 1;
                state["resolution"] = Convert.ToBase64String(wrapped);
                break;
            case "manifest": state["runtime_sha256"] = new string('b', 64); break;
            case "schema":
                state["health"]!["storage_schema"] = 9;
                outcome["restart"]!["storage_schema"] = 9;
                break;
            case "identity":
                state["health"]!["identity"]!["creation_file_time"] = "134000000000000003";
                outcome["restart"]!["identity"]!["creation_file_time"] = "134000000000000003";
                break;
            case "version":
                state["health"]!["application_version"] = "0.1.2";
                outcome["offered_version"] = "0.1.2";
                outcome["restart"]!["application_version"] = "0.1.2";
                break;
            case "timestamp": outcome["updated_at"] = DateTime.UtcNow.AddMinutes(1).ToString("O"); break;
            case "installer": outcome["installer_process"]!["pid"] = 9999; break;
            case "session":
                state["session_id"] = otherSession;
                state["health"]!["session_id"] = otherSession;
                outcome["session_id"] = otherSession;
                outcome["restart"]!["session_id"] = otherSession;
                break;
        }
        File.WriteAllText(statePath, state.ToJsonString());
        File.WriteAllText(outcomePath, outcome.ToJsonString());
        if (fault == "lost-outcome") File.Delete(outcomePath);
        if (fault == "session") Directory.Move(directory, Path.Combine(root, $"worker-{otherSession}"));
        Assert.Equal("update_recovery_invalid", Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(root)).Code);
    }

    [Fact]
    public void AHealthyJournalWithoutTheDurableResolutionRemainsBlockedAndCannotBeCalledInstalledHealth()
    {
        var path = Path.Combine(directory, UpdateRuntimeState.Filename);
        File.SetAttributes(path, FileAttributes.ReadOnly);
        try { Assert.Throws<IOException>(() => journal.WriteHealthy(proof)); }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
        Assert.Equal("healthy", UpdateWorkerJournal.Read(directory)!.Phase);
        Assert.Equal("installing", UpdateRuntimeState.Read(directory).Phase);
        Assert.Equal("update_recovery_required", Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(root)).Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65_536)]
    public void InvalidSchemaCannotConsumeTheInstalledTransition(int schema)
    {
        Assert.Throws<InvalidOperationException>(() => journal.WriteHealthy(proof with { StorageSchema = schema }));
        Assert.Equal("installed", journal.Latest!.Phase);
        Assert.Equal("installing", UpdateRuntimeState.Read(directory).Phase);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
