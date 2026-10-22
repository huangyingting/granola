using System.Globalization;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateWorkerOutcome(int Version, string SessionId, string CurrentVersion, string OfferedVersion,
    string Phase, string Code, bool InstallerStarted, int? InstallerExitCode, UpdateParentIdentity? InstallerProcess, string UpdatedAt);

internal sealed class UpdateWorkerJournal
{
    internal const string Filename = "update-outcome.json";
    private readonly string directory;
    private readonly string current;
    private readonly string offered;
    internal UpdateWorkerOutcome? Latest { get; private set; }

    internal UpdateWorkerJournal(string directory, string current, string offered)
    {
        if (!UpdateRuntimeLease.ValidDirectoryName(Path.GetFileName(directory)) ||
            !UpdateTrustVerifier.IsStableVersion(current) || !UpdateTrustVerifier.IsStableVersion(offered) ||
            System.Version.Parse(offered) <= System.Version.Parse(current))
            throw new UpdateHandoffException("update_worker_arguments");
        UpdatePrivateDirectory.Require(directory);
        this.directory = directory;
        this.current = current;
        this.offered = offered;
        if (File.Exists(Path.Combine(directory, Filename)))
            throw new UpdateHandoffException("update_worker_used");
        if (UpdateRuntimeState.Read(directory).Phase != "claimed")
            throw new UpdateHandoffException("update_worker_used");
    }

    internal void Write(string phase, string code, bool installerStarted = false, int? exitCode = null,
        UpdateParentIdentity? installerProcess = null)
    {
        installerProcess ??= Latest?.InstallerProcess;
        if (!Allowed(Latest?.Phase, phase) || code.Length is 0 or > 100 || code[0] is not (>= 'a' and <= 'z') ||
            code.Any(c => c is not (>= 'a' and <= 'z' or >= '0' and <= '9' or '_')) ||
            (Latest?.InstallerStarted == true && !installerStarted) || (exitCode is not null && !installerStarted) ||
            (phase is "preparing" or "prepared" or "committed" && (installerStarted || exitCode is not null)) ||
            (phase == "installing" && exitCode is not null) ||
            (!installerStarted && installerProcess is not null) ||
            (installerProcess is not null && (installerProcess.Pid <= 0 ||
                !long.TryParse(installerProcess.CreationFileTime, NumberStyles.None, CultureInfo.InvariantCulture, out var created) ||
                created <= 0 || created.ToString(CultureInfo.InvariantCulture) != installerProcess.CreationFileTime)) ||
            (Latest?.InstallerProcess is { } previous && installerProcess != previous) ||
            (phase == "installed" && (!installerStarted || exitCode != 0 || installerProcess is null)))
            throw new InvalidOperationException("An invalid update outcome transition was requested.");
        var outcome = new UpdateWorkerOutcome(1, Path.GetFileName(directory)[7..], current, offered, phase, code,
            installerStarted, exitCode, installerProcess, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        UpdateRuntimeState.RecordIntent(directory, phase);
        UpdateStateFile.Write(directory, Filename, outcome, replace: Latest is not null);
        Latest = outcome;
    }

    private static bool Allowed(string? previous, string next) => (previous, next) switch
    {
        (null, "preparing") or ("preparing", "prepared") or ("prepared", "committed") or
        ("committed", "installing") or ("installing", "installed") => true,
        ("installing", "installing") => true,
        ("preparing" or "prepared" or "committed" or "installing", "failed") => true,
        _ => false
    };

    internal static UpdateWorkerOutcome? Read(string directory)
    {
        if (!UpdateRuntimeLease.ValidDirectoryName(Path.GetFileName(directory)))
            throw new UpdateHandoffException("update_recovery_invalid");
        var outcome = UpdateStateFile.Read<UpdateWorkerOutcome>(directory, Filename);
        if (outcome is null) return null;
        if (outcome.Version != 1 || outcome.SessionId != Path.GetFileName(directory)[7..] ||
            !UpdateTrustVerifier.IsStableVersion(outcome.CurrentVersion) ||
            !UpdateTrustVerifier.IsStableVersion(outcome.OfferedVersion) ||
            System.Version.Parse(outcome.OfferedVersion) <= System.Version.Parse(outcome.CurrentVersion) ||
            outcome.Code.Length is 0 or > 100 || outcome.Code[0] is not (>= 'a' and <= 'z') ||
            outcome.Code.Any(c => c is not (>= 'a' and <= 'z' or >= '0' and <= '9' or '_')) ||
            !UpdateRuntimeState.ValidTime(outcome.UpdatedAt) ||
            (outcome.InstallerProcess is { } process && (process.Pid <= 0 ||
                !long.TryParse(process.CreationFileTime, NumberStyles.None, CultureInfo.InvariantCulture, out var created) ||
                created <= 0 || created.ToString(CultureInfo.InvariantCulture) != process.CreationFileTime)) ||
            (!outcome.InstallerStarted && (outcome.InstallerExitCode is not null || outcome.InstallerProcess is not null)) ||
            !ValidPhase(outcome))
            throw new UpdateHandoffException("update_recovery_invalid");
        return outcome;
    }

    private static bool ValidPhase(UpdateWorkerOutcome outcome) => outcome.Phase switch
    {
        "preparing" or "prepared" or "committed" => !outcome.InstallerStarted,
        "installing" => outcome.InstallerExitCode is null,
        "installed" => outcome.InstallerStarted && outcome.InstallerExitCode == 0 && outcome.InstallerProcess is not null,
        "failed" => true,
        _ => false
    };
}
