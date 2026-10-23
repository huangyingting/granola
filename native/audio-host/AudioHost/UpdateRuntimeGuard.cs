using System.ComponentModel;
using System.Security;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public static class UpdateRuntimeGuard
{
    public static async Task<int> RunAsync(int pid, string application, string version, string product,
        Stream input, Stream output)
    {
        UpdateParentLease? parent = null;
        UpdateRemoteRuntimeLease? retained = null;
        var directories = new List<SafeFileHandle>();
        try
        {
            var identity = UpdateParentLease.Open(pid, application, out parent);
            if (!identity.Matched || parent is null) throw new UpdateHandoffException(identity.Code);
            var installation = UpdateInstallationVerifier.Verify(application, version, product);
            if (!installation.Registered || installation.Installation is null)
                throw new UpdateHandoffException(installation.Code);
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "WindowsAINotes.UpdateWorkers");
            if (!UpdateInstallationVerifier.CanonicalPath(root) || !UpdatePathLock.IsFixedDiskPath(root))
                throw new UpdateHandoffException("update_worker_location");
            directories.AddRange(UpdatePathLock.OpenAncestors(Path.GetDirectoryName(root)!));
            if (!Directory.Exists(root)) new DirectoryInfo(root).Create(UpdatePrivateDirectory.Security());
            directories.Add(UpdatePathLock.OpenDirectory(root));
            UpdatePrivateDirectory.Require(root);
            StagedUpdateRuntime runtime;
            using (UpdateOperationLock.Open())
            {
                _ = UpdateSessionRetention.Retire(root, UpdateSessionRetention.RetiredRoot);
                runtime = UpdateRuntimeStager.Copy(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory),
                    installation.Installation.Directory, root, UpdateRuntimeStager.RequiredFiles, staged =>
                    {
                        using var local = UpdateRuntimeLease.Open(staged.Directory, installation.Installation.Directory,
                            staged.Sha256, UpdateRuntimeStager.RequiredFiles);
                        retained = local.RetainForParent(parent);
                    });
            }
            await FrameCodec.WriteJsonAsync(output,
                new { Version = 1, Event = "update_runtime_held", parent.Identity, Runtime = runtime });
            using var stopping = new CancellationTokenSource();
            try
            {
                var release = FrameCodec.ReadAsync(input, UpdateHandoffChallenge.MaximumMessageBytes, stopping.Token);
                var exited = parent.WaitForExitAsync(stopping.Token);
                if (await Task.WhenAny(release, exited) == exited) await exited;
                else if (await release is not null) throw new UpdateHandoffException("update_worker_protocol");
            }
            finally { stopping.Cancel(); }
            retained?.Dispose();
            retained = null;
            return 0;
        }
        catch (Exception error) when (error is IOException or AudioException or UnauthorizedAccessException or SecurityException or
            Win32Exception or ArgumentException)
        {
            var code = error switch
            {
                UpdateHandoffException handoff => handoff.Code,
                UpdateRuntimeException runtime => runtime.Code,
                AudioException => "update_worker_protocol",
                _ => "update_worker_unavailable"
            };
            try { await FrameCodec.WriteJsonAsync(output, new { Version = 1, Event = "update_runtime_failed", Code = code }); }
            // Main may have exited; failure still has a nonzero process result.
            catch (IOException) { }
            return 2;
        }
        finally
        {
            try { retained?.Dispose(); }
            finally
            {
                for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
                parent?.Dispose();
            }
        }
    }
}
