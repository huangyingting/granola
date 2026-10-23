using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal static class UpdateRuntimeResource
{
    private const int Type = 10;
    private const int Name = 0x5741;

    internal static byte[]? Read(string executable)
    {
        // Read data/resources only; never execute the image or resolve its imports.
        using var module = LoadLibraryEx(executable, 0, 0x20 | 0x40);
        if (module.IsInvalid) throw Error();
        var resource = FindResourceEx(module, new(Type), new(Name), 0);
        if (resource == 0)
        {
            var error = Marshal.GetLastPInvokeError();
            if (error is 1812 or 1813 or 1814 or 1815) return null;
            throw new Win32Exception(error);
        }
        var size = SizeofResource(module, resource);
        if (size is 0 or > UpdateRuntimeSeal.MaximumBytes)
            throw new UpdateHandoffException("update_runtime_seal_invalid");
        var loaded = LoadResource(module, resource);
        var pointer = loaded == 0 ? 0 : LockResource(loaded);
        if (pointer == 0) throw Error();
        var bytes = new byte[size];
        Marshal.Copy(pointer, bytes, 0, bytes.Length);
        return bytes;
    }

    internal static void WriteNew(string executable, byte[] bytes)
    {
        _ = UpdateRuntimeSeal.Parse(bytes);
        if (Read(executable) is not null) throw new UpdateHandoffException("update_runtime_already_sealed");
        var update = BeginUpdateResource(executable, false);
        if (update == 0) throw Error();
        try
        {
            if (!UpdateResource(update, new(Type), new(Name), 0, bytes, (uint)bytes.Length)) throw Error();
            var ending = update;
            update = 0;
            if (!EndUpdateResource(ending, false)) throw Error();
        }
        finally
        {
            if (update != 0 && !EndUpdateResource(update, true)) throw Error();
        }
    }

    private static Win32Exception Error() => new(Marshal.GetLastPInvokeError());
    private sealed class Module : SafeHandleZeroOrMinusOneIsInvalid
    {
        public Module() : base(true) { }
        protected override bool ReleaseHandle() => FreeLibrary(handle);
    }

    [DllImport("kernel32.dll", EntryPoint = "LoadLibraryExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern Module LoadLibraryEx(string file, nint reserved, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "FindResourceExW", SetLastError = true)]
    private static extern nint FindResourceEx(Module module, nint type, nint name, ushort language);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(Module module, nint resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint LoadResource(Module module, nint resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint LockResource(nint resource);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(nint module);
    [DllImport("kernel32.dll", EntryPoint = "BeginUpdateResourceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint BeginUpdateResource(string file, [MarshalAs(UnmanagedType.Bool)] bool delete);
    [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateResource(nint update, nint type, nint name, ushort language, byte[] bytes, uint count);
    [DllImport("kernel32.dll", EntryPoint = "EndUpdateResourceW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndUpdateResource(nint update, [MarshalAs(UnmanagedType.Bool)] bool discard);
}
