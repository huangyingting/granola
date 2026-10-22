using System.ComponentModel;
using System.Security;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal static class UpdateStartupRecovery
{
    internal const int MaximumSessions = 128;
    internal static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WindowsAINotes.UpdateWorkers");

    internal static void RequireRuntimeLocation(string directory)
    {
        try
        {
            UpdatePrivateDirectory.Require(Root);
            if (!UpdatePathLock.SameDirectory(Path.GetDirectoryName(directory)!, Root))
                throw new UpdateHandoffException("update_worker_location");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or
            Win32Exception or ArgumentException)
        {
            throw new UpdateHandoffException("update_worker_location");
        }
    }

    internal static void RequireSafe(string root)
    {
        var directories = new List<SafeFileHandle>();
        try
        {
            if (!UpdateInstallationVerifier.CanonicalPath(root) || !UpdatePathLock.IsFixedDiskPath(root))
                throw new UpdateHandoffException("update_recovery_invalid");
            directories.AddRange(UpdatePathLock.OpenAncestors(Path.GetDirectoryName(root)!));
            try { _ = File.GetAttributes(root); }
            catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { return; }
            directories.Add(UpdatePathLock.OpenDirectory(root));
            UpdatePrivateDirectory.Require(root);
            var count = 0;
            foreach (var directory in Directory.EnumerateFileSystemEntries(root))
            {
                if (++count > MaximumSessions) throw new UpdateHandoffException("update_recovery_limit");
                if (!UpdateRuntimeLease.ValidDirectoryName(Path.GetFileName(directory)))
                    throw new UpdateHandoffException("update_recovery_invalid");
                using var retained = UpdatePathLock.OpenDirectory(directory);
                UpdatePrivateDirectory.Require(directory);
                var state = UpdateRuntimeState.Read(directory);
                var outcome = UpdateWorkerJournal.Read(directory);
                if (state.Phase is "committed" or "installing")
                    throw new UpdateHandoffException("update_recovery_required");
                if (state.Phase == "staged")
                {
                    if (outcome is not null) throw new UpdateHandoffException("update_recovery_invalid");
                    continue;
                }
                if (outcome is null) throw new UpdateHandoffException("update_recovery_required");
                if (outcome.InstallerStarted || outcome.Phase is not ("preparing" or "prepared" or "failed"))
                    throw new UpdateHandoffException("update_recovery_invalid");
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or
            Win32Exception or ArgumentException)
        {
            if (error is UpdateHandoffException) throw;
            throw new UpdateHandoffException("update_recovery_unavailable");
        }
        finally
        {
            for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
        }
    }
}
