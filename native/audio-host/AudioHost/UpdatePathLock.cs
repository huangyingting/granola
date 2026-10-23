using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdatePathInvalidException() : IOException("An update path is not a regular file or directory.");

internal static class UpdatePathLock
{
    internal static bool IsFixedDiskPath(string path) =>
        Path.GetPathRoot(path) is { } root && new DriveInfo(root).DriveType == DriveType.Fixed;

    internal static SafeFileHandle OpenDirectory(string path)
        => Open(path, directory: true);

    internal static SafeFileHandle OpenFile(string path)
        => Open(path, directory: false);

    internal static SafeFileHandle OpenForRemoval(string path, bool directory)
    {
        var handle = Open(path, directory, remove: true);
        try
        {
            if (!directory) RequireSingleRegularFile(handle);
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    internal static void Rename(SafeFileHandle directory, string destination)
    {
        if (!UpdateInstallationVerifier.CanonicalPath(destination)) throw new UpdatePathInvalidException();
        var name = Encoding.Unicode.GetBytes(destination);
        var offset = Marshal.OffsetOf<RenameInformation>(nameof(RenameInformation.FirstCharacter)).ToInt32();
        var bytes = checked(offset + name.Length + 2);
        var buffer = Marshal.AllocHGlobal(bytes);
        try
        {
            Marshal.StructureToPtr(new RenameInformation { Length = (uint)name.Length }, buffer, false);
            Marshal.Copy(name, 0, buffer + offset, name.Length);
            Marshal.WriteInt16(buffer + offset + name.Length, 0);
            if (!SetInformation(directory, 3, buffer, (uint)bytes)) throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static void Delete(SafeFileHandle handle)
    {
        byte remove = 1;
        if (!SetDisposition(handle, 4, ref remove, 1)) throw new Win32Exception(Marshal.GetLastPInvokeError());
    }

    internal static List<SafeFileHandle> OpenAncestors(string path)
    {
        var handles = new List<SafeFileHandle>();
        try
        {
            var paths = new Stack<string>();
            for (var current = path; current is not null; current = Path.GetDirectoryName(current))
                paths.Push(current);
            foreach (var current in paths) handles.Add(OpenDirectory(current));
            return handles;
        }

        catch
        {
            for (var index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
            throw;
        }
    }

    internal static void RequireSingleRegularFile(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var information))
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        if ((information.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
            information.Links != 1)
            throw new UpdatePathInvalidException();
    }

    private static SafeFileHandle Open(string path, bool directory, bool remove = false)
    {
        // Do not follow reparse points or share DELETE access.
        var handle = CreateFile(path, (directory ? 0x80u : 0x80000000u) | (remove ? 0x10000u : 0u), directory ? 1u | 2u : 1u,
            IntPtr.Zero, 3, (directory ? 0x02000000u : 0u) | 0x00200000u, IntPtr.Zero);
        try
        {
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var information))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            if ((information.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) !=
                (directory ? FileAttributes.Directory : 0))
                throw new UpdatePathInvalidException();
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    internal static bool SameDirectory(string first, string second)
        => SameIdentity(first, second, directory: true);

    internal static bool SameFile(string first, string second)
        => SameIdentity(first, second, directory: false);

    private static bool SameIdentity(string first, string second, bool directory)
    {
        using var left = Open(first, directory);
        using var right = Open(second, directory);
        if (!GetFileInformationByHandleEx(left, 18, out var leftId, (uint)Marshal.SizeOf<FileIdentity>()) ||
            !GetFileInformationByHandleEx(right, 18, out var rightId, (uint)Marshal.SizeOf<FileIdentity>()))
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        return leftId.Volume == rightId.Volume && leftId.Low == rightId.Low && leftId.High == rightId.High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public FileAttributes Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access;
        public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdentity
    {
        public ulong Volume;
        public ulong Low;
        public ulong High;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RenameInformation
    {
        public uint Flags;
        public nint Root;
        public uint Length;
        public char FirstCharacter;
    }

    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformation(SafeFileHandle handle, int informationClass, nint information, uint size);
    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetDisposition(SafeFileHandle handle, int informationClass, ref byte information, uint size);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass,
        out FileIdentity information, uint size);
}
