using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Security;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateWorkerRequest(int ParentPid, string Application, string CurrentVersion, string OfferedVersion,
    string Installer, long Bytes, string Sha512, string RuntimeSha256)
{
    internal static UpdateWorkerRequest Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is 0 or > 16_384) throw new UpdateHandoffException("update_worker_arguments");
        UpdateWorkerRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<UpdateWorkerRequest>(bytes, new JsonSerializerOptions(AudioJson.Options)
            {
                AllowDuplicateProperties = false,
                RespectRequiredConstructorParameters = true,
                RespectNullableAnnotations = true,
                MaxDepth = 8
            });
        }
        catch (JsonException) { throw new UpdateHandoffException("update_worker_arguments"); }
        if (request is null || !UpdateInstallerWorker.ValidRequest(request))
            throw new UpdateHandoffException("update_worker_arguments");
        return request;
    }
}
public sealed record UpdateWorkerResult(int Version, bool Installed, string Code, UpdateWorkerOutcome? Outcome);

internal sealed record UpdateWorkerServices(Func<string, UpdateInstallationResult> Installation,
    Func<string, UpdateTrustResult> Application,
    Func<ProcessStartInfo, IEnumerable<SafeFileHandle>, UpdateInstallerProcess> Start, TimeSpan InstallerTimeout);

public static class UpdateInstallerWorker
{
    public static async Task<UpdateWorkerResult> RunAsync(UpdateWorkerRequest request, Stream input, Stream output,
        CancellationToken token = default)
    {
        if (!ValidRequest(request)) return new(1, false, "update_worker_arguments", null);
        UpdateParentLease? parent = null;
        UpdateRuntimeLease? runtime = null;
        UpdateWorkerJournal? journal = null;
        try
        {
            token.ThrowIfCancellationRequested();
            var identity = UpdateParentLease.Open(request.ParentPid, request.Application, out parent);
            if (!identity.Matched || parent is null) return new(1, false, identity.Code, null);
            var directory = Path.GetDirectoryName(request.Application)!;
            var location = Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
            UpdateStartupRecovery.RequireRuntimeLocation(location);
            runtime = UpdateRuntimeLease.Open(location, directory, request.RuntimeSha256, UpdateRuntimeStager.RequiredFiles);
            using var exclusive = UpdateOperationLock.Open();
            UpdateRuntimeState.Claim(location, request.RuntimeSha256);
            journal = new(location, request.CurrentVersion, request.OfferedVersion);
            journal.Write("preparing", "update_worker_preparing");
            var policy = UpdateWorkerPolicy.Read(request.Application);
            var services = new UpdateWorkerServices(
                version => UpdateInstallationVerifier.VerifyWorkerApplication(parent, version, policy.ProductName),
                version =>
                {
                    if (version == request.CurrentVersion && UpdateWorkerPolicy.Read(request.Application) != policy)
                        throw new UpdateHandoffException("update_policy_changed");
                    return UpdateTrustVerifier.Verify(request.Application, policy.Trust(version));
                },
                UpdateInstallerProcess.Start,
                TimeSpan.FromMinutes(10));
            VerifyApplication(services, request.CurrentVersion);
            RequireOutsideInstallation(request.Installer, directory);
            var verification = PreparedInstaller.Open(request.Installer, policy.Trust(request.OfferedVersion),
                request.CurrentVersion, request.Bytes, request.Sha512, out var installer);
            using (installer)
            {
                if (!verification.Verified || installer is null) throw new UpdateHandoffException(verification.Code);
                journal.Write("prepared", "update_worker_prepared");
                return await ExecutePreparedAsync(request, parent, installer, journal, input, output, services, token);
            }
        }
        catch (Exception error) when (Expected(error))
        {
            return Fail(journal, Code(error), false, null);
        }
        finally
        {
            runtime?.Dispose();
            parent?.Dispose();
        }
    }

    internal static async Task<UpdateWorkerResult> ExecutePreparedAsync(UpdateWorkerRequest request, UpdateParentLease parent,
        PreparedInstaller installer, UpdateWorkerJournal journal, Stream input, Stream output,
        UpdateWorkerServices services, CancellationToken token)
    {
        var started = false;
        int? exitCode = null;
        UpdateParentIdentity? installerProcess = null;
        try
        {
            await UpdateParentHandoff.WaitForCommittedExitAsync(parent, input, output, TimeSpan.FromSeconds(30),
                TimeSpan.FromMinutes(2), token, onCommitted: cancellation =>
                {
                    cancellation.ThrowIfCancellationRequested();
                    journal.Write("committed", "update_worker_committed");
                    return Task.CompletedTask;
                });
            token.ThrowIfCancellationRequested();
            using var admission = UpdateOperationLock.OpenAdmission();
            VerifyApplication(services, request.CurrentVersion);
            if (installer.IsDisposed) throw new UpdateHandoffException("update_installer_unavailable");
            journal.Write("installing", "update_installer_starting");
            using var process = services.Start(InstallerStart(installer.Path, Path.GetDirectoryName(request.Application)!),
                admission.Handles.Concat(installer.Handles));
            started = true;
            var outcomeUnavailable = false;
            try
            {
                try
                {
                    installerProcess = new(process.Id, process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture));
                    journal.Write("installing", "update_installer_started", true, installerProcess: installerProcess);
                }
                catch (Exception error) when (StorageFailure(error) || error is Win32Exception)
                {
                    outcomeUnavailable = true;
                    ReportOutcomeFailure();
                }
                // Once installation starts, never kill it or release its path leases on a deadline/caller cancellation.
                var exited = process.WaitForExitAsync(CancellationToken.None);
                try { await exited.WaitAsync(services.InstallerTimeout); }
                catch (TimeoutException)
                {
                    try { journal.Write("installing", "update_installer_timeout", true); }
                    catch (Exception error) when (StorageFailure(error))
                    {
                        outcomeUnavailable = true;
                        ReportOutcomeFailure();
                    }
                    await exited;
                }
                exitCode = process.ExitCode;
            }
            finally
            {
                if (!process.HasExited) await process.WaitForExitAsync(CancellationToken.None);
            }
            if (outcomeUnavailable) throw new UpdateHandoffException("update_worker_outcome_failed");
            if (exitCode != 0) throw new UpdateHandoffException("update_installer_failed");
            VerifyApplication(services, request.OfferedVersion);
            journal.Write("installed", "update_worker_installed", true, exitCode);
            return new(1, true, "update_worker_installed", journal.Latest);
        }
        catch (Exception error) when (Expected(error))
        {
            return Fail(journal, Code(error), started, exitCode, installerProcess);
        }
    }

    internal static ProcessStartInfo InstallerStart(string installer, string directory)
    {
        if (!UpdateInstallationVerifier.CanonicalPath(installer) || !installer.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
            !UpdateInstallationVerifier.CanonicalPath(directory))
            throw new UpdateHandoffException("update_worker_arguments");
        var start = new ProcessStartInfo(installer)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(installer)!,
            // NSIS consumes the complete unquoted /D= tail, including spaces.
            Arguments = $"/currentuser /S /D={directory}"
        };
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMFILES(X86)",
            "PROGRAMW6432", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA"
        };
        foreach (var key in start.Environment.Keys.Where(key => !allowed.Contains(key)).ToArray())
            start.Environment.Remove(key);
        return start;
    }

    private static void VerifyApplication(UpdateWorkerServices services, string version)
    {
        var installation = services.Installation(version);
        if (!installation.Registered) throw new UpdateHandoffException(installation.Code);
        if (installation.Installation is null) throw new UpdateHandoffException("update_worker_protocol");
        var application = services.Application(version);
        if (!application.Verified) throw new UpdateHandoffException(application.Code);
        if (application.Artifact is null) throw new UpdateHandoffException("update_worker_protocol");
    }

    private static void RequireOutsideInstallation(string path, string installation)
    {
        for (var ancestor = Path.GetDirectoryName(path); ancestor is not null; ancestor = Path.GetDirectoryName(ancestor))
            if (UpdatePathLock.SameDirectory(ancestor, installation))
                throw new UpdateHandoffException("update_worker_location");
    }

    internal static bool ValidRequest(UpdateWorkerRequest request) =>
        request.ParentPid > 0 && UpdateInstallationVerifier.CanonicalPath(request.Application) &&
        request.Application.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
        UpdateInstallationVerifier.CanonicalPath(request.Installer) &&
        request.Installer.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
        UpdateTrustVerifier.IsStableVersion(request.CurrentVersion) && UpdateTrustVerifier.IsStableVersion(request.OfferedVersion) &&
        System.Version.Parse(request.OfferedVersion) > System.Version.Parse(request.CurrentVersion) &&
        request.Bytes is > 0 and <= UpdateTrustVerifier.MaximumArtifactBytes && PreparedInstaller.ValidHash(request.Sha512) &&
        UpdateRuntimeLease.ValidManifest(request.RuntimeSha256);

    private static UpdateWorkerResult Fail(UpdateWorkerJournal? journal, string code, bool started, int? exitCode,
        UpdateParentIdentity? installerProcess = null)
    {
        if (journal is not null)
        {
            try { journal.Write("failed", code, started, exitCode, installerProcess); }
            catch (Exception error) when (StorageFailure(error))
            {
                ReportOutcomeFailure();
                return new(1, false, "update_worker_outcome_failed", journal.Latest);
            }
        }
        return new(1, false, code, journal?.Latest);
    }

    private static void ReportOutcomeFailure()
    {
        try { Console.Error.WriteLine("update_worker_outcome_failed: durable update state could not be written."); }
        // Main normally closes its inherited pipes on exit; the result still reports failure.
        catch (IOException) { }
    }
    private static bool StorageFailure(Exception error) => error is IOException or UnauthorizedAccessException or SecurityException;
    private static bool Expected(Exception error) => error is IOException or UnauthorizedAccessException or
        SecurityException or Win32Exception or ArgumentException or OperationCanceledException or BadImageFormatException;
    private static string Code(Exception error) => error switch
    {
        UpdateHandoffException handoff => handoff.Code,
        UpdateRuntimeException runtime => runtime.Code,
        OperationCanceledException => "update_worker_cancelled",
        _ => "update_worker_unavailable"
    };
}
