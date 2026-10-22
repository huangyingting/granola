using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateLaunchedProcess : IDisposable
{
    private readonly SafeProcessHandle? handle;
    private readonly Process? surrogate;
    private Task? exited;
    internal int Id { get; }
    internal bool IsNativeLaunch => handle is not null;
    internal UpdateParentIdentity Identity => new(Id,
        StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture));
    internal DateTime StartTime => surrogate?.StartTime ?? CreationTime();
    internal bool HasExited => surrogate?.HasExited ?? Signaled(0);
    internal int ExitCode
    {
        get
        {
            if (surrogate is not null) return surrogate.ExitCode;
            if (!HasExited) throw new InvalidOperationException("The child process has not exited.");
            if (!GetExitCodeProcess(handle!, out var code)) throw LastError();
            return unchecked((int)code);
        }
    }

    internal UpdateLaunchedProcess(Process surrogate)
    {
        this.surrogate = surrogate;
        Id = surrogate.Id;
    }

    private UpdateLaunchedProcess(SafeProcessHandle handle, int id)
    {
        this.handle = handle;
        Id = id;
    }

    internal Task WaitForExitAsync(CancellationToken token) =>
        (exited ??= surrogate?.WaitForExitAsync(CancellationToken.None) ?? Task.Run(() => Signaled(uint.MaxValue))).WaitAsync(token);

    internal static UpdateLaunchedProcess Start(ProcessStartInfo start, IEnumerable<SafeFileHandle> retained)
    {
        if (start.UseShellExecute || start.RedirectStandardInput || start.RedirectStandardOutput ||
            start.RedirectStandardError || start.ArgumentList.Count != 0 ||
            !UpdateInstallationVerifier.CanonicalPath(start.FileName) || start.FileName.Contains('"') ||
            start.Arguments.Contains('\0') || !UpdateInstallationVerifier.CanonicalPath(start.WorkingDirectory))
            throw new ArgumentException("A direct executable, argument string and explicit working directory are required.");
        var inherited = new List<SafeFileHandle>();
        nint attributes = 0, values = 0, environment = 0;
        var initialized = false;
        try
        {
            foreach (var source in retained)
            {
                if (inherited.Count >= 1024) throw new ArgumentException("Too many inherited update leases.");
                if (!DuplicateHandle(new(-1), source, new(-1), out var copy, 0, true, 2))
                {
                    var error = Marshal.GetLastPInvokeError();
                    copy.Dispose();
                    throw new Win32Exception(error);
                }
                inherited.Add(copy);
            }
            if (inherited.Count == 0) throw new ArgumentException("An inherited startup admission lease is required.");
            nuint size = 0;
            if (InitializeProcThreadAttributeList(0, 1, 0, ref size) || Marshal.GetLastPInvokeError() != 122 ||
                size is 0 or > 65_536) throw LastError();
            attributes = Marshal.AllocHGlobal(checked((int)size));
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw LastError();
            initialized = true;
            values = Marshal.AllocHGlobal(checked(inherited.Count * nint.Size));
            for (var index = 0; index < inherited.Count; index++)
                Marshal.WriteIntPtr(values, index * nint.Size, inherited[index].DangerousGetHandle());
            if (!UpdateProcThreadAttribute(attributes, 0, new(0x00020002), values,
                (nuint)(inherited.Count * nint.Size), 0, 0)) throw LastError();
            var entries = start.Environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => $"{pair.Key}={pair.Value}");
            environment = Marshal.StringToHGlobalUni(string.Join('\0', entries) + "\0\0");
            var startup = new StartupInfoEx { Startup = new() { Size = (uint)Marshal.SizeOf<StartupInfoEx>() }, Attributes = attributes };
            // Only the explicit lease list is inherited, never private protocol pipes or other handles.
            if (!CreateProcess(start.FileName, new StringBuilder($"\"{start.FileName}\" {start.Arguments}"),
                0, 0, true, 0x00080000u | 0x00000400u | (start.CreateNoWindow ? 0x08000000u : 0u),
                environment, start.WorkingDirectory, ref startup, out var process)) throw LastError();
            using var thread = new SafeWaitHandle(process.Thread, ownsHandle: true);
            return new(new SafeProcessHandle(process.Process, ownsHandle: true), checked((int)process.Pid));
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != 0) Marshal.FreeHGlobal(attributes);
            if (values != 0) Marshal.FreeHGlobal(values);
            if (environment != 0) Marshal.FreeHGlobal(environment);
            foreach (var copy in inherited) copy.Dispose();
        }
    }

    private DateTime CreationTime()
    {
        if (!GetProcessTimes(handle!, out var created, out _, out _, out _)) throw LastError();
        return DateTime.FromFileTimeUtc(created);
    }

    private bool Signaled(uint milliseconds)
    {
        var result = WaitForSingleObject(handle!, milliseconds);
        return result switch { 0 => true, 258 => false, _ => throw LastError() };
    }

    public void Dispose()
    {
        surrogate?.Dispose();
        handle?.Dispose();
    }

    private static Win32Exception LastError() => new(Marshal.GetLastPInvokeError());

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Size;
        internal nint Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        internal ushort Show, ReservedSize;
        internal nint ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { internal StartupInfo Startup; internal nint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { internal nint Process, Thread; internal uint Pid, ThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(nint sourceProcess, SafeFileHandle source, nint targetProcess,
        out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(nint list, int count, uint flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(nint list, uint flags, nint attribute, nint value,
        nuint size, nint previous, nint returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(nint list);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string application, StringBuilder command, nint processSecurity,
        nint threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, nint environment,
        string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited,
        out long kernel, out long user);
}
