using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateRemoteRuntimeLease : IDisposable
{
    private const uint SameAccess = 2;
    private const uint CloseSource = 1;
    private static readonly nint CurrentProcess = new(-1);
    private readonly UpdateParentLease parent;
    private readonly List<nint> remote = [];

    private UpdateRemoteRuntimeLease(UpdateParentLease parent) => this.parent = parent;

    internal static UpdateRemoteRuntimeLease Open(UpdateParentLease parent, IEnumerable<SafeFileHandle> handles)
    {
        ObjectDisposedException.ThrowIf(parent.IsDisposed, parent);
        if (parent.HasExited) throw new UpdateHandoffException("update_parent_missing");
        var lease = new UpdateRemoteRuntimeLease(parent);
        try
        {
            foreach (var handle in handles)
            {
                // Main owns noninheritable duplicates; a stager crash cannot release its pre-load locks.
                if (!Send(CurrentProcess, handle, parent.ProcessHandle, out var retained, 0, false, SameAccess))
                    throw new Win32Exception(Marshal.GetLastPInvokeError());
                lease.remote.Add(retained);
            }

            if (parent.HasExited) throw new UpdateHandoffException("update_parent_missing");
            return lease;
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    // Startup admission belongs to Main until physical exit, not to the short-lived claiming helper.
    internal void TransferToParent()
    {
        if (parent.HasExited) throw new UpdateHandoffException("update_parent_missing");
        remote.Clear();
    }

    public void Dispose()
    {
        IOException? failure = null;
        for (var index = remote.Count - 1; index >= 0; index--)
        {
            if (parent.HasExited) { remote.Clear(); break; }
            var closed = Take(parent.ProcessHandle, remote[index], CurrentProcess, out var local, 0, false, SameAccess | CloseSource);
            var error = Marshal.GetLastPInvokeError();
            using (local)
            {
                // CLOSE_SOURCE closes even on error: never retry a possibly reused remote handle value.
                remote.RemoveAt(index);
                if (!closed && !parent.HasExited)
                    failure ??= new IOException("The Main-owned update runtime lease could not be released.", new Win32Exception(error));
            }
        }
        if (failure is not null) throw failure;
    }

    [DllImport("kernel32.dll", EntryPoint = "DuplicateHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Send(nint sourceProcess, SafeFileHandle source, SafeProcessHandle targetProcess,
        out nint target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);

    [DllImport("kernel32.dll", EntryPoint = "DuplicateHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Take(SafeProcessHandle sourceProcess, nint source, nint targetProcess,
        out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
}
