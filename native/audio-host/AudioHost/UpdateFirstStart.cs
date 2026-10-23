using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal static class UpdateFirstStart
{
    internal static async Task RunAsync(UpdateWorkerRequest request, UpdateWorkerPolicy policy, UpdateWorkerJournal journal,
        UpdateOperationLock admission)
    {
        var session = Guid.Parse(Path.GetFileName(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory))[7..]);
        await using var health = new UpdateRestartHealth(session, request.OfferedVersion, TimeSpan.FromSeconds(90));
        await using var authentication = new UpdateRestartAdmission(session);
        using var executable = UpdatePathLock.OpenFile(request.Application);
        UpdatePathLock.RequireSingleRegularFile(executable);
        var signature = UpdateTrustVerifier.Verify(request.Application, policy.Trust(request.OfferedVersion));
        if (!signature.Verified) throw new UpdateHandoffException(signature.Code);
        using var bundled = UpdateRuntimeProvenance.Open(
            Path.Combine(Path.GetDirectoryName(request.Application)!, "resources", "audio-host"),
            request.OfferedVersion, policy.CertificateSha256, policy.Publisher);
        var start = UpdateInstallerWorker.InstallerStart(request.Application, Path.GetDirectoryName(request.Application)!);
        start.Arguments = $"--update-restart={session:D} --update-health={health.Endpoint} --update-auth={authentication.Endpoint} " +
            $"\"--user-data-dir={request.UserData}\"";
        using var main = UpdateLaunchedProcess.StartIsolated(start);
        await health.RunAsync(main, (proof, token) =>
        {
            token.ThrowIfCancellationRequested();
            journal.WriteHealthy(proof);
            return Task.CompletedTask;
        }, admit: (binding, token) => authentication.RunAsync(main, request.Application, policy, binding, admission.Handles, token));
    }
}
