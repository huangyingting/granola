namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateOperationLock(FileStream file) : IDisposable
{
    internal static UpdateOperationLock Open()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WindowsAINotes.UpdateLocks");
        if (!UpdateInstallationVerifier.CanonicalPath(root) || !UpdatePathLock.IsFixedDiskPath(root))
            throw new UpdateRuntimeException("update_worker_location");
        UpdateInstallationVerifier.RequireRegularPath(Path.GetDirectoryName(root)!, directory: true);
        if (!Directory.Exists(root)) new DirectoryInfo(root).Create(UpdatePrivateDirectory.Security());
        UpdatePrivateDirectory.Require(root);
        return new(OpenFile(Path.Combine(root, $"{UpdateInstallationVerifier.ApplicationGuid}.lock")));
    }

    internal static FileStream OpenFile(string path)
    {
        try
        {
            if (File.Exists(path)) UpdateInstallationVerifier.RequireRegularPath(path, directory: false);
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
        {
            throw new WindowsAiNotes.Updates.UpdateHandoffException("update_worker_busy");
        }
    }

    public void Dispose() => file.Dispose();
}
