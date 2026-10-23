using System.ComponentModel;
using System.IO.Pipes;
using System.Security;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public static class UpdateRestartBridge
{
    public static async Task<int> RunAsync(int pid, string application, string version, Stream input, Stream output)
    {
        UpdateParentLease? main = null;
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var result = UpdateParentLease.Open(pid, application, out main);
            if (!result.Matched || main is null) throw new UpdateHandoffException(result.Code);
            UpdateStartupAdmission.RequireBundledApplication(application, version, requirePolicy: true);
            var policy = UpdateWorkerPolicy.Read(application);
            using var bundled = UpdateRuntimeProvenance.Open(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory),
                version, policy.CertificateSha256, policy.Publisher);
            var request = await UpdateRestartProtocol.ReadAsync<UpdateRestartBridgeRequest>(input, deadline.Token).WaitAsync(deadline.Token);
            var binding = new UpdateRestartChallenge(request.Version, "update_restart_challenge", request.SessionId,
                request.Challenge, request.Identity, request.ApplicationVersion);
            if (request.Event != "update_restart_authenticate" || !UpdateRestartProtocol.ValidBinding(binding) ||
                request.Identity != main.Identity || request.ApplicationVersion != version ||
                !UpdateRestartProtocol.ValidEndpoint(request.Endpoint, Guid.Parse(request.SessionId), "RestartAuth"))
                throw new UpdateHandoffException("update_restart_protocol");
            using var pipe = new NamedPipeClientStream(".", request.Endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(deadline.Token);
            using var server = UpdateRestartServerLease.Open(pipe, main, Guid.Parse(request.SessionId), version, policy);
            var challenge = await UpdateRestartProtocol.ReadAsync<UpdateRestartAuthentication>(pipe, deadline.Token);
            if (!UpdateRestartProtocol.Matches(challenge, binding, "update_restart_auth_challenge"))
                throw new UpdateHandoffException("update_restart_protocol");
            server.RequireAlive();
            await FrameCodec.WriteJsonAsync(pipe, UpdateRestartProtocol.Message(binding, "update_restart_auth_ready", challenge.AuthChallenge), deadline.Token);
            var admitted = await UpdateRestartProtocol.ReadAsync<UpdateRestartAuthentication>(pipe, deadline.Token);
            if (!UpdateRestartProtocol.Matches(admitted, binding, "update_restart_auth_admitted", challenge.AuthChallenge))
                throw new UpdateHandoffException("update_restart_protocol");
            server.RequireAlive();
            await FrameCodec.WriteJsonAsync(pipe, UpdateRestartProtocol.Message(binding, "update_restart_auth_finished", challenge.AuthChallenge), deadline.Token);
            await FrameCodec.WriteJsonAsync(output, binding with { Event = "update_restart_admitted" }, deadline.Token);
            return 0;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or
            Win32Exception or ArgumentException or BadImageFormatException or OperationCanceledException or AudioException)
        {
            var code = error switch
            {
                UpdateHandoffException handoff => handoff.Code,
                UpdateRuntimeException runtime => runtime.Code,
                OperationCanceledException => "update_restart_timeout",
                AudioException => "update_restart_protocol",
                _ => "update_restart_unavailable"
            };
            try { await FrameCodec.WriteJsonAsync(output, new { Version = 1, Event = "update_restart_failed", Code = code }); }
            catch (IOException) { }
            return 2;
        }
        finally { main?.Dispose(); }
    }
}
