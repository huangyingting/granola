using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateRestartAdmission : IAsyncDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly string session;
    private int used;
    internal string Endpoint { get; }

    internal UpdateRestartAdmission(Guid session)
    {
        if (!UpdateRuntimeLease.ValidDirectoryName($"worker-{session:D}"))
            throw new UpdateHandoffException("update_restart_arguments");
        Endpoint = UpdateRestartProtocol.Endpoint(session, "RestartAuth");
        this.session = session.ToString("D");
        pipe = new(Endpoint, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            UpdateRestartHealth.MaximumMessageBytes, UpdateRestartHealth.MaximumMessageBytes);
    }

    internal async Task RunAsync(UpdateLaunchedProcess main, string application, UpdateWorkerPolicy policy,
        UpdateRestartChallenge binding, IEnumerable<SafeFileHandle> handles, CancellationToken token)
    {
        if (Interlocked.Exchange(ref used, 1) != 0) throw new UpdateHandoffException("update_restart_used");
        if (!UpdateRestartProtocol.ValidBinding(binding) || binding.Identity != main.Identity || binding.SessionId != session)
            throw new UpdateHandoffException("update_restart_arguments");
        try
        {
            await pipe.WaitForConnectionAsync(token);
            var helper = Path.Combine(Path.GetDirectoryName(application)!, "resources", "audio-host", "AudioHost.exe");
            using var bridge = OpenBridgePeer(pipe, main, helper);
            using var provenance = UpdateRuntimeProvenance.Open(Path.GetDirectoryName(helper)!, binding.ApplicationVersion,
                policy.CertificateSha256, policy.Publisher);
            await ExchangeAsync(pipe, main, bridge, binding, handles, token);
        }
        finally { await pipe.DisposeAsync(); }
    }

    internal static UpdateParentLease OpenBridgePeer(NamedPipeServerStream pipe, UpdateLaunchedProcess main, string helper)
    {
        if (!main.IsNativeLaunch || main.HasExited) throw new UpdateHandoffException("update_restart_main_exited");
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid))
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        if (pid is 0 or > int.MaxValue) throw new UpdateHandoffException("update_restart_bridge_peer");
        var result = UpdateParentLease.OpenObservedProcess((int)pid, out var bridge);
        if (!result.Matched || bridge is null) throw new UpdateHandoffException("update_restart_bridge_peer");
        try
        {
            if (!main.IsCreatorOf(bridge) || !UpdatePathLock.SameFile(bridge.Executable, helper))
                throw new UpdateHandoffException("update_restart_bridge_peer");
            return bridge;
        }
        catch { bridge.Dispose(); throw; }
    }

    internal static async Task ExchangeAsync(Stream pipe, UpdateLaunchedProcess main, UpdateParentLease bridge,
        UpdateRestartChallenge binding, IEnumerable<SafeFileHandle> handles, CancellationToken token)
    {
        RequireAlive(main, bridge);
        var challenge = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await FrameCodec.WriteJsonAsync(pipe, UpdateRestartProtocol.Message(binding, "update_restart_auth_challenge", challenge), token);
        var ready = await UpdateRestartProtocol.ReadAsync<UpdateRestartAuthentication>(pipe, token);
        if (!UpdateRestartProtocol.Matches(ready, binding, "update_restart_auth_ready", challenge))
            throw new UpdateHandoffException("update_restart_protocol");
        RequireAlive(main, bridge);
        token.ThrowIfCancellationRequested();
        using var remote = UpdateRemoteRuntimeLease.Open(main, handles);
        RequireAlive(main, bridge);
        remote.TransferToProcess();
        await FrameCodec.WriteJsonAsync(pipe, UpdateRestartProtocol.Message(binding, "update_restart_auth_admitted", challenge), token);
        var finished = await UpdateRestartProtocol.ReadAsync<UpdateRestartAuthentication>(pipe, token);
        if (!UpdateRestartProtocol.Matches(finished, binding, "update_restart_auth_finished", challenge))
            throw new UpdateHandoffException("update_restart_protocol");
    }

    private static void RequireAlive(UpdateLaunchedProcess main, UpdateParentLease bridge)
    {
        if (!main.IsCreatorOf(bridge)) throw new UpdateHandoffException("update_restart_bridge_peer");
    }

    public ValueTask DisposeAsync() => pipe.DisposeAsync();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
}
