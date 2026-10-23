using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateRestartServerLease : IDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly UpdateParentLease main;
    private readonly UpdateParentLease server;
    private readonly UpdateRuntimeProvenance runtime;
    private bool disposed;

    private UpdateRestartServerLease(NamedPipeClientStream pipe, UpdateParentLease main,
        UpdateParentLease server, UpdateRuntimeProvenance runtime)
    {
        this.pipe = pipe;
        this.main = main;
        this.server = server;
        this.runtime = runtime;
    }

    // Ownership of the connected pipe and exact Main lease transfers only on success.
    internal static UpdateRestartServerLease Open(NamedPipeClientStream pipe, UpdateParentLease main,
        Guid session, string version, UpdateWorkerPolicy policy)
    {
        if (!UpdateRuntimeLease.ValidDirectoryName($"worker-{session:D}") || !UpdateTrustVerifier.IsStableVersion(version))
            throw new UpdateHandoffException("update_restart_server_arguments");
        var server = OpenPeer(pipe, main);
        UpdateRuntimeProvenance? runtime = null;
        try
        {
            var directory = Path.GetDirectoryName(server.Executable)!;
            if (!string.Equals(Path.GetFileName(server.Executable), "AudioHost.exe", StringComparison.OrdinalIgnoreCase) ||
                !UpdatePathLock.SameFile(server.Executable, Path.Combine(directory, "AudioHost.exe")))
                throw new UpdateHandoffException("update_restart_server_identity");
            UpdateStartupRecovery.RequireRuntimeLocation(directory);
            UpdatePrivateDirectory.Require(directory);
            var state = UpdateRuntimeState.Read(directory);
            var outcome = RequireContext(state, UpdateWorkerJournal.Read(directory), session, version);
            runtime = UpdateRuntimeProvenance.Open(directory, outcome.CurrentVersion, policy.CertificateSha256, policy.Publisher);
            if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(state.RuntimeSha256), Convert.FromHexString(runtime.Manifest)))
                throw new UpdateHandoffException("update_worker_source");
            RequirePeer(pipe, main, server);
            return new(pipe, main, server, runtime);
        }
        catch
        {
            runtime?.Dispose();
            server.Dispose();
            throw;
        }
    }

    internal static UpdateParentLease OpenPeer(NamedPipeClientStream pipe, UpdateParentLease main)
    {
        UpdateParentLease? server = null;
        try
        {
            ObjectDisposedException.ThrowIf(main.IsDisposed, main);
            if (!pipe.IsConnected) throw new UpdateHandoffException("update_restart_server_pipe");
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            if (pid is 0 or > int.MaxValue) throw new UpdateHandoffException("update_restart_server_peer");
            var result = UpdateParentLease.OpenObservedProcess((int)pid, out server);
            if (!result.Matched || server is null) throw new UpdateHandoffException("update_restart_server_unavailable");
            RequirePeer(pipe, main, server);
            return server;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or
            Win32Exception or ArgumentException or InvalidOperationException)
        {
            server?.Dispose();
            if (error is UpdateHandoffException) throw;
            throw new UpdateHandoffException("update_restart_server_unavailable");
        }
    }

    internal static UpdateWorkerOutcome RequireContext(UpdateRuntimeState state, UpdateWorkerOutcome? outcome, Guid session, string version)
    {
        var identifier = session.ToString("D");
        if (state.SessionId != identifier || state.Phase != "installing" || outcome is null ||
            outcome.SessionId != identifier || outcome.Phase != "installed" || !outcome.InstallerStarted ||
            outcome.InstallerExitCode != 0 || outcome.InstallerProcess is null || outcome.OfferedVersion != version ||
            !UpdateTrustVerifier.IsStableVersion(outcome.CurrentVersion) || !UpdateTrustVerifier.IsStableVersion(version) ||
            System.Version.Parse(outcome.CurrentVersion) >= System.Version.Parse(version))
            throw new UpdateHandoffException("update_restart_server_context");
        return outcome;
    }

    internal void RequireAlive()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        RequirePeer(pipe, main, server);
    }

    private static void RequirePeer(NamedPipeClientStream pipe, UpdateParentLease main, UpdateParentLease server)
    {
        if (!pipe.IsConnected) throw new UpdateHandoffException("update_restart_server_pipe");
        if (!server.IsCreatorOf(main)) throw new UpdateHandoffException("update_restart_server_peer");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        pipe.Dispose();
        runtime.Dispose();
        server.Dispose();
        main.Dispose();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
}
