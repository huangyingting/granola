using System.Globalization;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateWorkerOutcome(int Version, string SessionId, string CurrentVersion, string OfferedVersion,
    string Phase, string Code, bool InstallerStarted, int? InstallerExitCode, UpdateParentIdentity? InstallerProcess, string UpdatedAt);

internal sealed class UpdateWorkerJournal
{
    internal const string Filename = "update-outcome.json";
    private const uint ReplaceExisting = 1;
    private const uint WriteThrough = 8;
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
        var temporary = Path.Combine(directory, $".outcome-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            {
                JsonSerializer.Serialize(stream, outcome, AudioJson.Options);
                stream.Flush(flushToDisk: true);
            }
            if (!MoveFile(temporary, Path.Combine(directory, Filename), WriteThrough | (Latest is null ? 0u : ReplaceExisting)))
                throw new IOException("The durable update state could not be committed.", new Win32Exception(Marshal.GetLastPInvokeError()));
            Latest = outcome;
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static bool Allowed(string? previous, string next) => (previous, next) switch
    {
        (null, "preparing") or ("preparing", "prepared") or ("prepared", "committed") or
        ("committed", "installing") or ("installing", "installed") => true,
        ("installing", "installing") => true,
        ("preparing" or "prepared" or "committed" or "installing", "failed") => true,
        _ => false
    };

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFile(string source, string destination, uint flags);
}
