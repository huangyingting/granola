using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateOperationLock(FileStream file, List<SafeFileHandle> directories) : IDisposable
{
    private bool disposed;
    internal IEnumerable<SafeFileHandle> Handles
    {
        get
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return directories.Append(file.SafeFileHandle);
        }
    }

    private static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WindowsAINotes.UpdateLocks");

    internal static UpdateOperationLock Open() => Open(Root, admission: false);
    internal static UpdateOperationLock OpenAdmission() => Open(Root, admission: true);

    internal static UpdateOperationLock Open(string root, bool admission)
    {
        if (!UpdateInstallationVerifier.CanonicalPath(root) || !UpdatePathLock.IsFixedDiskPath(root))
            throw new UpdateRuntimeException("update_worker_location");
        var directories = UpdatePathLock.OpenAncestors(Path.GetDirectoryName(root)!);
        FileStream? file = null;
        try
        {
            if (!Directory.Exists(root)) new DirectoryInfo(root).Create(UpdatePrivateDirectory.Security());
            directories.Add(UpdatePathLock.OpenDirectory(root));
            UpdatePrivateDirectory.Require(root);
            file = OpenFile(Path.Combine(root, $"{UpdateInstallationVerifier.ApplicationGuid}{(admission ? ".startup" : "")}.lock"));
            UpdatePrivateDirectory.RequireFile(file);
            return new(file, directories);
        }
        catch
        {
            file?.Dispose();
            for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
            throw;
        }
    }

    internal static FileStream OpenFile(string path)
    {
        var bytes = UpdatePrivateDirectory.LockSecurity().GetSecurityDescriptorBinaryForm();
        var descriptor = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length);
            var security = new SecurityAttributes { Size = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateFile(path, 0x80000000u | 0x40000000u, 0, ref security, 4, 0x00200000u, nint.Zero);
            try
            {
                if (handle.IsInvalid)
                {
                    var error = Marshal.GetLastPInvokeError();
                    if (error is 32 or 33) throw new WindowsAiNotes.Updates.UpdateHandoffException("update_worker_busy");
                    throw new Win32Exception(error);
                }
                UpdatePathLock.RequireSingleRegularFile(handle);
                return new FileStream(handle, FileAccess.ReadWrite);
            }
            catch { handle.Dispose(); throw; }
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
        {
            throw new WindowsAiNotes.Updates.UpdateHandoffException("update_worker_busy");
        }
        finally { Marshal.FreeHGlobal(descriptor); }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try { file.Dispose(); }
        finally
        {
            for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal uint Size;
        internal nint Descriptor;
        internal int Inherit;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, ref SecurityAttributes security,
        uint creation, uint flags, nint template);
}
