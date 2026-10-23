using System.Globalization;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateSessionInspectionEntry(string Location, string? SessionId, string Status,
    string? CurrentVersion, string? OfferedVersion, string? UpdatedAt, string Code);
internal sealed record UpdateSessionInspectionReport(string CheckedAt, string Status, int Active, int Retired,
    int Unverifiable, bool Limited, int Omitted, UpdateSessionInspectionEntry[] Sessions);

public static class UpdateSessionInspection
{
    internal const int MaximumEntries = 32;

    public static async Task<int> RunAsync(int pid, string application, string version, Stream output)
    {
        UpdateParentLease? parent = null;
        try
        {
            var identity = UpdateParentLease.Open(pid, application, out parent);
            if (!identity.Matched || parent is null) throw new UpdateHandoffException(identity.Code);
            UpdateStartupAdmission.RequireBundledApplication(application, version);
            using var operation = UpdateOperationLock.Open();
            using var maintenance = UpdateOperationLock.OpenCleanup();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var report = Read(UpdateStartupRecovery.Root, UpdateSessionRetention.RetiredRoot, deadline.Token);
            await FrameCodec.WriteJsonAsync(output,
                new { Version = 1, Event = "update_inspection_report", parent.Identity, Report = report }, deadline.Token);
            return 0;
        }
        catch (Exception error) when (UpdateSessionRetention.Expected(error) || error is OperationCanceledException)
        {
            var code = error is UpdateHandoffException handoff ? handoff.Code :
                error is OperationCanceledException ? "update_inspection_timeout" : "update_inspection_unavailable";
            try { await FrameCodec.WriteJsonAsync(output, new { Version = 1, Event = "update_inspection_failed", Code = code }); }
            catch (IOException) { }
            return 2;
        }
        finally { parent?.Dispose(); }
    }

    internal static UpdateSessionInspectionReport Read(string active, string retired, CancellationToken token = default)
    {
        var sessions = new List<UpdateSessionInspectionEntry>();
        var held = new List<SafeFileHandle>();
        var limited = false;
        try
        {
            var activeCount = Scan(active, "active");
            var retiredCount = Scan(retired, "retired");
            var unverifiable = sessions.Count(item => item.Status == "unverifiable");
            var displayed = sessions.OrderBy(item => item.Status switch
            {
                "recovery_required" => 0,
                "unverifiable" => 1,
                "retired" => 2,
                "uncommitted" => 3,
                _ => 4
            }).ThenBy(item => item.Location, StringComparer.Ordinal)
                .ThenBy(item => item.SessionId ?? "", StringComparer.Ordinal).Take(MaximumEntries).ToArray();
            return new(DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                limited || unverifiable > 0 ? "partial" : "complete", activeCount, retiredCount,
                unverifiable, limited, activeCount + retiredCount - displayed.Length, displayed);
        }
        finally { for (var index = held.Count - 1; index >= 0; index--) held[index].Dispose(); }

        int Scan(string root, string location)
        {
            token.ThrowIfCancellationRequested();
            if (!UpdateSessionRetention.OpenRoot(root, held, create: false)) return 0;
            var entries = Directory.EnumerateFileSystemEntries(root).Take(UpdateStartupRecovery.MaximumSessions + 1).ToArray();
            limited |= entries.Length > UpdateStartupRecovery.MaximumSessions;
            foreach (var directory in entries.Take(UpdateStartupRecovery.MaximumSessions))
            {
                token.ThrowIfCancellationRequested();
                var name = Path.GetFileName(directory);
                var validName = UpdateRuntimeLease.ValidDirectoryName(name);
                try
                {
                    if (!validName) throw new UpdateHandoffException("update_recovery_invalid");
                    using var original = UpdatePathLock.OpenDirectory(directory);
                    UpdatePrivateDirectory.Require(directory);
                    sessions.Add(location == "active" ? Active(directory) : Retired(directory));
                }
                catch (Exception error) when (UpdateSessionRetention.Expected(error))
                {
                    sessions.Add(new(location, validName ? name[7..] : null, "unverifiable", null, null, null,
                        error is UpdateHandoffException handoff ? handoff.Code : "update_recovery_unavailable"));
                }
            }
            return entries.Length;
        }
    }

    private static UpdateSessionInspectionEntry Active(string directory)
    {
        var state = UpdateRuntimeState.Read(directory);
        var outcome = UpdateWorkerJournal.Read(directory);
        var status = state.Phase == "healthy" ? "healthy" : "uncommitted";
        try { UpdateStartupRecovery.RequireSafe(state, outcome); }
        catch (UpdateHandoffException error) when (error.Code == "update_recovery_required") { status = "recovery_required"; }
        return new("active", state.SessionId, status, outcome?.CurrentVersion, outcome?.OfferedVersion,
            outcome?.UpdatedAt ?? state.UpdatedAt, status == "recovery_required" ? "update_recovery_required" :
                outcome?.Code ?? "update_runtime_staged");
    }

    private static UpdateSessionInspectionEntry Retired(string directory)
    {
        var receipt = UpdateStateFile.Read<UpdateRetiredReceipt>(directory, UpdateSessionRetention.ReceiptFilename);
        if (receipt is null)
        {
            if (Directory.EnumerateFileSystemEntries(directory).Any()) throw new UpdateHandoffException("update_cleanup_invalid");
            return new("retired", Path.GetFileName(directory)[7..], "retired", null, null, null, "update_cleanup_pending");
        }
        UpdateSessionRetention.RequireReceipt(receipt, directory);
        var state = UpdateStateFile.Read<UpdateRuntimeState>(directory, UpdateRuntimeState.Filename);
        var outcome = UpdateStateFile.Read<UpdateWorkerOutcome>(directory, UpdateWorkerJournal.Filename);
        if ((state is not null && state != receipt.State) || (outcome is not null && outcome != receipt.Outcome))
            throw new UpdateHandoffException("update_cleanup_invalid");
        return new("retired", receipt.State.SessionId, "retired", receipt.Outcome.CurrentVersion,
            receipt.Outcome.OfferedVersion, receipt.Outcome.UpdatedAt, "update_cleanup_pending");
    }
}
