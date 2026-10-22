using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateRestartProof(string SessionId, UpdateParentIdentity Identity, string ApplicationVersion, int StorageSchema);
internal sealed record UpdateRestartReady(int Version, string Event, string SessionId, string Challenge,
    UpdateParentIdentity Identity, string ApplicationVersion, int StorageSchema);

internal sealed class UpdateRestartHealth : IAsyncDisposable
{
    internal const int MaximumMessageBytes = 1024;
    private static readonly JsonSerializerOptions Options = new(AudioJson.Options)
    {
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        MaxDepth = 4
    };
    private readonly NamedPipeServerStream pipe;
    private readonly string session;
    private readonly string version;
    private readonly TimeSpan timeout;
    private int used;
    internal string Endpoint { get; }

    internal UpdateRestartHealth(Guid session, string version, TimeSpan timeout)
    {
        var identifier = session.ToString("D");
        if (identifier[14] != '4' || identifier[19] is not ('8' or '9' or 'a' or 'b') ||
            !UpdateTrustVerifier.IsStableVersion(version) ||
            timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(2))
            throw new UpdateHandoffException("update_restart_arguments");
        this.session = identifier;
        this.version = version;
        this.timeout = timeout;
        Endpoint = $"WindowsAINotes.Restart.{session:N}.{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))}";
        pipe = new(Endpoint, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            MaximumMessageBytes, MaximumMessageBytes);
    }

    internal async Task<UpdateRestartProof> RunAsync(UpdateLaunchedProcess main,
        Func<UpdateRestartProof, CancellationToken, Task> persist, CancellationToken token = default)
    {
        if (Interlocked.Exchange(ref used, 1) != 0) throw new UpdateHandoffException("update_restart_used");
        ArgumentNullException.ThrowIfNull(persist);
        if (!main.IsNativeLaunch) throw new UpdateHandoffException("update_restart_arguments");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(timeout);
        Task? pending = null;
        Task? writing = null;
        var confirmed = false;
        try
        {
            RequireAlive(main);
            var identity = main.Identity;
            var exited = main.WaitForExitAsync(CancellationToken.None);
            pending = pipe.WaitForConnectionAsync(deadline.Token);
            await WhileAlive(pending, main, exited, deadline.Token);
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var peer))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            if (peer != (uint)main.Id) throw new UpdateHandoffException("update_restart_peer");
            RequireAlive(main);
            var challenge = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            pending = FrameCodec.WriteJsonAsync(pipe,
                new { Version = 1, Event = "update_restart_challenge", SessionId = session, Challenge = challenge, Identity = identity, ApplicationVersion = version },
                deadline.Token);
            await WhileAlive(pending, main, exited, deadline.Token);
            var reading = FrameCodec.ReadAsync(pipe, MaximumMessageBytes, deadline.Token);
            pending = reading;
            await WhileAlive(reading, main, exited, deadline.Token);
            var bytes = await reading ?? throw new UpdateHandoffException("update_restart_protocol");
            UpdateRestartReady? ready;
            try { ready = JsonSerializer.Deserialize<UpdateRestartReady>(bytes, Options); }
            catch (JsonException) { throw new UpdateHandoffException("update_restart_protocol"); }
            if (ready is null || ready.Version != 1 || ready.Event != "update_restart_ready" ||
                ready.SessionId != session || ready.Challenge != challenge || ready.Identity != identity ||
                ready.ApplicationVersion != version || ready.StorageSchema is < 1 or > 65_535)
                throw new UpdateHandoffException("update_restart_protocol");
            RequireAlive(main);
            var proof = new UpdateRestartProof(session, identity, version, ready.StorageSchema);
            try
            {
                deadline.Token.ThrowIfCancellationRequested();
                writing = persist(proof, deadline.Token);
                await WhileAlive(writing, main, exited, deadline.Token);
            }
            catch (OperationCanceledException) when (!deadline.IsCancellationRequested)
            {
                throw new UpdateHandoffException("update_restart_outcome_failed");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or Win32Exception)
            {
                if (error is UpdateHandoffException) throw;
                throw new UpdateHandoffException("update_restart_outcome_failed");
            }
            RequireAlive(main);
            pending = FrameCodec.WriteJsonAsync(pipe,
                new { Version = 1, Event = "update_restart_confirmed", SessionId = session, Challenge = challenge, Identity = identity, ApplicationVersion = version },
                deadline.Token);
            await WhileAlive(pending, main, exited, deadline.Token);
            confirmed = true;
            return proof;
        }
        catch (OperationCanceledException)
        {
            throw new UpdateHandoffException(token.IsCancellationRequested ? "update_restart_cancelled" : "update_restart_timeout");
        }
        catch (Exception error) when (error is IOException or AudioException or UnauthorizedAccessException or
            SecurityException or Win32Exception)
        {
            if (error is UpdateHandoffException) throw;
            throw new UpdateHandoffException(error is AudioException ? "update_restart_protocol" : "update_restart_unavailable");
        }
        finally
        {
            deadline.Cancel();
            await pipe.DisposeAsync();
            if (pending is not null) await Drain(pending);
            if (writing is not null)
            {
                try { await writing; }
                catch (Exception error) when (!confirmed && error is OperationCanceledException or IOException or
                    UnauthorizedAccessException or SecurityException or Win32Exception)
                {
                    if (error is not OperationCanceledException)
                        Console.Error.WriteLine("update_restart_outcome_failed: health persistence did not complete successfully.");
                }
            }
        }
    }

    private static async Task WhileAlive(Task work, UpdateLaunchedProcess main, Task exited, CancellationToken token)
    {
        if (await Task.WhenAny(work, exited).WaitAsync(token) == exited)
            throw new UpdateHandoffException("update_restart_main_exited");
        await work.WaitAsync(token);
        RequireAlive(main);
    }

    private static void RequireAlive(UpdateLaunchedProcess main)
    {
        if (main.HasExited) throw new UpdateHandoffException("update_restart_main_exited");
    }

    private static async Task Drain(Task work)
    {
        try { await work; }
        // The selected failure already reports closed/cancelled native transport.
        catch (Exception error) when (error is OperationCanceledException or IOException or AudioException or ObjectDisposedException) { }
    }

    public ValueTask DisposeAsync() => pipe.DisposeAsync();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
}
