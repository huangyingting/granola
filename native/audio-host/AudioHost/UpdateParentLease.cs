using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateParentIdentity(int Pid, string CreationFileTime);
public sealed record UpdateParentResult(int Version, bool Matched, string Code, UpdateParentIdentity? Parent)
{
    public static UpdateParentResult Rejected(string code) => new(1, false, code, null);
}

public sealed class UpdateParentLease : IDisposable
{
    private readonly Process process;
    public UpdateParentIdentity Identity { get; }
    internal string Executable { get; }
    internal SafeProcessHandle ProcessHandle
    {
        get { ObjectDisposedException.ThrowIf(IsDisposed, this); return process.SafeHandle; }
    }
    public bool IsDisposed { get; private set; }
    public bool HasExited
    {
        get { ObjectDisposedException.ThrowIf(IsDisposed, this); return process.HasExited; }
    }

    private UpdateParentLease(Process process, UpdateParentIdentity identity, string executable)
    {
        this.process = process;
        Identity = identity;
        Executable = executable;
    }

    public static UpdateParentResult Open(int expectedPid, string executable, out UpdateParentLease? lease)
    {
        lease = null;
        if (!ValidArguments(expectedPid, executable))
            return UpdateParentResult.Rejected("update_parent_arguments");
        if (!OperatingSystem.IsWindows())
            return UpdateParentResult.Rejected("update_parent_platform");
        try
        {
            if (ParentPid(Environment.ProcessId) != expectedPid)
                return UpdateParentResult.Rejected("update_parent_mismatch");
            var result = OpenProcess(expectedPid, executable, out lease);
            using var current = Process.GetCurrentProcess();
            if (lease is not null && lease.process.StartTime.ToUniversalTime() > current.StartTime.ToUniversalTime())
            {
                lease.Dispose();
                lease = null;
                return UpdateParentResult.Rejected("update_parent_mismatch");
            }
            return result;
        }
        catch (Exception error) when (Unavailable(error))
        {
            lease?.Dispose();
            lease = null;
            return UpdateParentResult.Rejected("update_parent_unavailable");
        }
    }

    internal static UpdateParentResult OpenProcess(int pid, string executable, out UpdateParentLease? lease)
    {
        lease = null;
        if (!ValidArguments(pid, executable))
            return UpdateParentResult.Rejected("update_parent_arguments");
        return OpenProcessCore(pid, executable, out lease);
    }

    internal static UpdateParentResult OpenObservedProcess(int pid, out UpdateParentLease? lease)
    {
        lease = null;
        if (pid <= 0) return UpdateParentResult.Rejected("update_parent_arguments");
        return OpenProcessCore(pid, null, out lease);
    }

    private static UpdateParentResult OpenProcessCore(int pid, string? executable, out UpdateParentLease? lease)
    {
        lease = null;
        if (!OperatingSystem.IsWindows()) return UpdateParentResult.Rejected("update_parent_platform");
        Process? candidate = null;
        try
        {
            try { candidate = Process.GetProcessById(pid); }
            catch (ArgumentException) { return UpdateParentResult.Rejected("update_parent_missing"); }
            // Cache the kernel handle before inspecting identity or waiting; never re-open by PID.
            var handle = candidate.SafeHandle;
            if (candidate.HasExited)
                return UpdateParentResult.Rejected("update_parent_missing");
            using var current = Process.GetCurrentProcess();
            if (candidate.SessionId != current.SessionId)
                return UpdateParentResult.Rejected("update_parent_mismatch");
            var opened = OpenProcessToken(handle, 8, out var token);
            using (token)
            {
                if (!opened)
                    throw new Win32Exception(Marshal.GetLastPInvokeError());
                using var owner = new WindowsIdentity(token.DangerousGetHandle());
                using var identity = WindowsIdentity.GetCurrent();
                if (identity.User is not { } sid || owner.User is not { } ownerSid || !sid.Equals(ownerSid))
                    return UpdateParentResult.Rejected("update_parent_mismatch");
            }
            var image = new StringBuilder(2048);
            uint size = 2048;
            if (!QueryFullProcessImageName(handle, 0, image, ref size))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            var actual = image.ToString();
            if (!ValidArguments(pid, actual))
                return UpdateParentResult.Rejected("update_parent_mismatch");
            UpdateInstallationVerifier.RequireRegularPath(actual, directory: false);
            if (executable is not null)
            {
                UpdateInstallationVerifier.RequireRegularPath(executable, directory: false);
                if (!UpdatePathLock.SameFile(actual, executable))
                    return UpdateParentResult.Rejected("update_parent_mismatch");
            }
            var parent = new UpdateParentIdentity(pid,
                candidate.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture));
            if (candidate.HasExited)
                return UpdateParentResult.Rejected("update_parent_missing");
            lease = new(candidate, parent, executable ?? actual);
            candidate = null;
            return new(1, true, "update_parent_matched", parent);
        }
        catch (Exception error) when (Unavailable(error))
        {
            return UpdateParentResult.Rejected("update_parent_unavailable");
        }
        finally { candidate?.Dispose(); }
    }

    public Task WaitForExitAsync(CancellationToken token)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        return process.WaitForExitAsync(token);
    }

    internal bool IsCreatorOf(UpdateParentLease child)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        ObjectDisposedException.ThrowIf(child.IsDisposed, child);
        if (HasExited || child.HasExited || Identity.Pid == child.Identity.Pid) return false;
        var matches = process.StartTime.ToUniversalTime() <= child.process.StartTime.ToUniversalTime() &&
            ParentPid(child.Identity.Pid) == Identity.Pid;
        // Both cached kernel handles must still be live after the PID-based snapshot.
        return matches && !HasExited && !child.HasExited;
    }

    public void Dispose()
    {
        if (IsDisposed) return;
        IsDisposed = true;
        process.Dispose();
    }

    private static bool ValidArguments(int pid, string executable) => pid > 0 &&
        UpdateInstallationVerifier.CanonicalPath(executable) && executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);

    private static bool Unavailable(Exception error) => error is IOException or UnauthorizedAccessException or
        Win32Exception or ArgumentException or InvalidOperationException or System.Security.SecurityException;

    private static int ParentPid(int pid)
    {
        using var snapshot = CreateToolhelp32Snapshot(2, 0);
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Executable = "" };
        if (snapshot.IsInvalid || !Process32First(snapshot, ref entry))
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        do
        {
            if (entry.Pid == (uint)pid)
                return entry.ParentPid <= int.MaxValue ? (int)entry.ParentPid : 0;
        } while (Process32Next(snapshot, ref entry));
        if (Marshal.GetLastPInvokeError() != 18)
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        return 0;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, Pid;
        public UIntPtr Heap;
        public uint Module, Threads, ParentPid;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Executable;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder image, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
}
