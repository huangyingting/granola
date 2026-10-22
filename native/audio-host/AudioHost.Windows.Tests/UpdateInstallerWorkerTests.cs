using System.Diagnostics;
using System.Security.Cryptography;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateInstallerWorkerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-installer-worker-{Guid.NewGuid():D}");
    private readonly string runtime;
    private readonly string candidate;

    public UpdateInstallerWorkerTests()
    {
        Directory.CreateDirectory(root);
        runtime = Path.Combine(root, $"worker-{Guid.NewGuid():D}");
        new DirectoryInfo(runtime).Create(UpdatePrivateDirectory.Security());
        candidate = Path.Combine(root, "signed runtime fixture.exe");
        File.Copy(UpdateTrustTests.Reference, candidate);
    }

    [Theory]
    [InlineData("success", "update_worker_installed", true)]
    [InlineData("cancel", "update_handoff_cancelled", false)]
    [InlineData("stale", "update_handoff_challenge", false)]
    [InlineData("changed-current", "update_installation_mismatch", false)]
    [InlineData("exit-error", "update_installer_failed", false)]
    [InlineData("changed-installed", "update_installation_mismatch", false)]
    [InlineData("signature-error", "update_signature_invalid", false)]
    public async Task ComposesDurableCommitExactParentExitLockedLaunchAndFreshPostInstallChecks(
        string scenario, string code, bool installed)
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var prepared = PrepareFixture();
        var request = Request(fixture.Parent.Identity.Pid);
        var journal = Journal();
        var observations = new List<string>();
        var launched = false;
        var services = new UpdateWorkerServices(version =>
        {
            observations.Add($"registration:{version}");
            return (scenario == "changed-current" && version == "0.1.0") ||
                (scenario == "changed-installed" && version == "0.1.1")
                ? UpdateInstallationResult.Rejected("update_installation_mismatch")
                : new(1, true, "update_installation_verified",
                    new(root, request.Application, version, "Synthetic product", "x64"));
        }, version =>
        {
            observations.Add($"signature:{version}");
            return scenario == "signature-error" && version == "0.1.1"
                ? UpdateTrustResult.Rejected("update_signature_invalid")
                : new(1, true, "update_verified", prepared.Artifact);
        }, start =>
        {
            Assert.True(fixture.Parent.HasExited);
            Assert.False(prepared.IsDisposed);
            Assert.Equal("installing", journal.Latest!.Phase);
            Assert.Equal(candidate, start.FileName);
            Assert.Equal($"/currentuser /S /D={root}", start.Arguments);
            Assert.Throws<IOException>(() => { using var overwrite = File.OpenWrite(candidate); });
            launched = true;
            observations.Add("launch");
            return Surrogate(scenario == "exit-error" ? 2 : 0);
        }, TimeSpan.FromSeconds(10));
        var pending = UpdateInstallerWorker.ExecutePreparedAsync(request, fixture.Parent, prepared, journal,
            fixture.Worker, fixture.Worker, services, fixture.Deadline.Token);
        fixture.Track(pending);
        var ready = await fixture.ReadAsync<UpdateParentReady>();
        Assert.Equal("prepared", journal.Latest!.Phase);
        Assert.False(launched);
        await fixture.DecideAsync(new UpdateHandoffDecision(1, scenario == "cancel" ? "cancel" : "commit",
            scenario == "stale" ? new UpdateHandoffChallenge().Value : ready.Challenge));
        if (scenario is not ("cancel" or "stale"))
        {
            await fixture.ReadAsync<UpdateParentCommitted>();
            Assert.Equal("committed", journal.Latest!.Phase);
            Assert.False(launched);
            await fixture.ExitParentAsync();
        }
        var result = await pending;
        Assert.Equal(installed, result.Installed);
        Assert.Equal(code, result.Code);
        Assert.Equal(installed ? "installed" : "failed", journal.Latest!.Phase);
        Assert.Equal(scenario is not ("cancel" or "stale" or "changed-current"), launched);
        Assert.False(prepared.IsDisposed);
        if (scenario == "success")
        {
            Assert.Equal(["registration:0.1.0", "signature:0.1.0", "launch", "registration:0.1.1", "signature:0.1.1"], observations);
            Assert.NotNull(journal.Latest.InstallerProcess);
            Assert.True(journal.Latest.InstallerProcess.Pid > 0);
            Assert.True(long.Parse(journal.Latest.InstallerProcess.CreationFileTime, System.Globalization.CultureInfo.InvariantCulture) > 0);
        }
    }

    [Fact]
    public async Task DoesNotKillAnInstallerOrReleaseItsLeaseWhenItsDeadlineOrCallerCancellationOccursAfterLaunch()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var prepared = PrepareFixture();
        using var cancellation = new CancellationTokenSource();
        var request = Request(fixture.Parent.Identity.Pid);
        var journal = Journal();
        StreamWriter? release = null;
        var services = new UpdateWorkerServices(
            version => new(1, true, "update_installation_verified", new(root, request.Application, version, "Synthetic", "x64")),
            _ => new(1, true, "update_verified", prepared.Artifact),
            _ =>
            {
                var process = Surrogate(0, waitForInput: true);
                release = process.StandardInput;
                cancellation.Cancel();
                return process;
            }, TimeSpan.FromMilliseconds(25));
        var pending = UpdateInstallerWorker.ExecutePreparedAsync(request, fixture.Parent, prepared, journal,
            fixture.Worker, fixture.Worker, services, cancellation.Token);
        fixture.Track(pending);
        try
        {
            var ready = await fixture.ReadAsync<UpdateParentReady>();
            await fixture.DecideAsync(new UpdateHandoffDecision(1, "commit", ready.Challenge));
            await fixture.ReadAsync<UpdateParentCommitted>();
            await fixture.ExitParentAsync();
            while (journal.Latest?.Code != "update_installer_timeout")
                await Task.Delay(10, fixture.Deadline.Token);
            Assert.False(pending.IsCompleted);
            Assert.False(prepared.IsDisposed);
            Assert.Throws<IOException>(() => File.Delete(candidate));
        }
        finally { release?.Dispose(); }
        Assert.True((await pending).Installed);
    }

    [Fact]
    public async Task WaitsForAnAlreadyStartedInstallerEvenWhenDurableOutcomeWritesFail()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var prepared = PrepareFixture();
        var request = Request(fixture.Parent.Identity.Pid);
        var journal = Journal();
        var pathname = Path.Combine(runtime, UpdateWorkerJournal.Filename);
        var services = new UpdateWorkerServices(
            version => new(1, true, "update_installation_verified", new(root, request.Application, version, "Synthetic", "x64")),
            _ => new(1, true, "update_verified", prepared.Artifact),
            _ => { File.SetAttributes(pathname, FileAttributes.ReadOnly); return Surrogate(0, 500); }, TimeSpan.FromSeconds(10));
        var pending = UpdateInstallerWorker.ExecutePreparedAsync(request, fixture.Parent, prepared, journal,
            fixture.Worker, fixture.Worker, services, fixture.Deadline.Token);
        fixture.Track(pending);
        try
        {
            var ready = await fixture.ReadAsync<UpdateParentReady>();
            await fixture.DecideAsync(new UpdateHandoffDecision(1, "commit", ready.Challenge));
            await fixture.ReadAsync<UpdateParentCommitted>();
            await fixture.ExitParentAsync();
            var result = await pending;
            Assert.False(result.Installed);
            Assert.Equal("update_worker_outcome_failed", result.Code);
            Assert.False(prepared.IsDisposed);
            Assert.Equal("installing", journal.Latest!.Phase);
        }
        finally { File.SetAttributes(pathname, FileAttributes.Normal); }
    }

    [Fact]
    public async Task DoesNotAcknowledgeAnUndurableCommitOrLaunchWhileTheParentIsStillAlive()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var prepared = PrepareFixture();
        var request = Request(fixture.Parent.Identity.Pid);
        var journal = Journal();
        var pathname = Path.Combine(runtime, UpdateWorkerJournal.Filename);
        var services = new UpdateWorkerServices(
            _ => throw new InvalidOperationException("No application inspection should run before committed parent exit."),
            _ => throw new InvalidOperationException("No trust inspection should run before committed parent exit."),
            _ => throw new InvalidOperationException("No installer may start without a durable acknowledged commit."),
            TimeSpan.FromSeconds(10));
        var pending = UpdateInstallerWorker.ExecutePreparedAsync(request, fixture.Parent, prepared, journal,
            fixture.Worker, fixture.Worker, services, fixture.Deadline.Token);
        fixture.Track(pending);
        try
        {
            var ready = await fixture.ReadAsync<UpdateParentReady>();
            File.SetAttributes(pathname, FileAttributes.ReadOnly);
            await fixture.DecideAsync(new UpdateHandoffDecision(1, "commit", ready.Challenge));
            Assert.Equal("update_worker_outcome_failed", (await pending).Code);
            Assert.False(fixture.Process.HasExited);
            Assert.Equal("prepared", journal.Latest!.Phase);
            using var noAcknowledgment = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                WindowsAiNotes.Audio.FrameCodec.ReadAsync(fixture.Main, noAcknowledgment.Token));
        }
        finally { File.SetAttributes(pathname, FileAttributes.Normal); }
    }

    private PreparedInstaller PrepareFixture()
    {
        // Internal generic signed-runtime coverage, never a production first-party installer bypass.
        var result = PreparedInstaller.OpenArtifact(candidate, UpdateTrustTests.ReferencePolicy(), new FileInfo(candidate).Length,
            Convert.ToBase64String(SHA512.HashData(File.ReadAllBytes(candidate))), installer: false, out var prepared);
        Assert.True(result.Verified, result.Code);
        Assert.NotNull(prepared);
        return prepared;
    }

    private UpdateWorkerRequest Request(int parent) => new(parent, Path.Combine(root, "Synthetic.exe"), "0.1.0", "0.1.1",
        candidate, new FileInfo(candidate).Length, Convert.ToBase64String(SHA512.HashData(File.ReadAllBytes(candidate))), new string('a', 64));

    private UpdateWorkerJournal Journal()
    {
        var journal = new UpdateWorkerJournal(runtime, "0.1.0", "0.1.1");
        journal.Write("preparing", "update_worker_preparing");
        journal.Write("prepared", "update_worker_prepared");
        return journal;
    }

    private static Process Surrogate(int exitCode, int delay = 0, bool waitForInput = false)
    {
        var start = new ProcessStartInfo(UpdateTrustTests.Reference)
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = waitForInput };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            waitForInput ? $"[Console]::In.ReadLine() | Out-Null; exit {exitCode}" :
                $"Start-Sleep -Milliseconds {delay}; exit {exitCode}" }) start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new InvalidOperationException("The test-only installer surrogate did not start.");
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
