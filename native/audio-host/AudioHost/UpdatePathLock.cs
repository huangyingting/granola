using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdatePathInvalidException() : IOException("An update path is not a regular directory.");

internal static class UpdatePathLock
{
    internal static bool IsFixedDiskPath(string path) =>
        Path.GetPathRoot(path) is { } root && new DriveInfo(root).DriveType == DriveType.Fixed;

    internal static SafeFileHandle OpenDirectory(string path)
    {
        // Do not follow reparse points or share DELETE access.
        var handle = CreateFile(path, 0x80, 1 | 2, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
        try
        {
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var information))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            if ((information.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
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
    {
        using var left = OpenDirectory(first);
        using var right = OpenDirectory(second);
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
