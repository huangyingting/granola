using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public static class UpdateSessionMaintenance
{
    public static async Task<int> RunAsync(int pid, string application, string version, Stream output)
    {
        UpdateParentLease? parent = null;
        try
        {
            var identity = UpdateParentLease.Open(pid, application, out parent);
            if (!identity.Matched || parent is null) throw new UpdateHandoffException(identity.Code);
            UpdateStartupAdmission.RequireBundledApplication(application, version);
            // Retired directories cannot activate workers; their janitor must not compete with activation.
            using var maintenance = UpdateOperationLock.OpenCleanup();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            var counts = UpdateSessionRetention.Drain(UpdateSessionRetention.RetiredRoot, deadline.Token);
            await FrameCodec.WriteJsonAsync(output, new
            {
                Version = 1,
                Event = "update_cleanup_report",
                parent.Identity,
                Status = counts.Incomplete == 0 && counts.Rejected == 0 ? "complete" : "pending",
                counts.Retired,
                counts.Removed,
                counts.Incomplete,
                counts.Rejected
            }, deadline.Token);
            return 0;
        }
        catch (Exception error) when (UpdateSessionRetention.Expected(error) || error is OperationCanceledException)
        {
            var code = error is UpdateHandoffException handoff ? handoff.Code :
                error is OperationCanceledException ? "update_cleanup_timeout" : "update_cleanup_unavailable";
            try { await FrameCodec.WriteJsonAsync(output, new { Version = 1, Event = "update_cleanup_failed", Code = code }); }
            catch (IOException) { }
            return 2;
        }
        finally { parent?.Dispose(); }
    }
}
