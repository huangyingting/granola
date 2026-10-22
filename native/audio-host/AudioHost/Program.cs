using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("platform_unsupported: AudioHost capture and DPAPI require Windows 11.");
    return 1;
}
if (args.Length > 0 && args[0] is "--verify-update" or "--verify-installer-update")
{
    var result = args.Length == 6
        ? args[0] == "--verify-installer-update"
            ? UpdateTrustVerifier.VerifyInstaller(args[1], new UpdateTrustPolicy(args[2], args[3], args[4], args[5]))
            : UpdateTrustVerifier.Verify(args[1], new UpdateTrustPolicy(args[2], args[3], args[4], args[5]))
        : UpdateTrustResult.Rejected("update_verification_arguments");
    Console.WriteLine(JsonSerializer.Serialize(result, AudioJson.Options));
    return result.Verified ? 0 : 2;
}
if (args.Length != 2 || args[0] != "--data-dir" || !Path.IsPathFullyQualified(args[1]))
{
    Console.Error.WriteLine("invalid_arguments: pass --data-dir with an absolute, current-user-owned directory.");
    return 1;
}

var root = Path.GetFullPath(args[1]);
FileStream? hostLock = null;
var protector = new DpapiKeyProtector();
var archive = new RecordingArchive(root, protector);
var storage = new StorageBudget(root);
CaptureSession? session = null;
await using var input = Console.OpenStandardInput();
await using var output = Console.OpenStandardOutput();
var exitCode = 0;
double lastStatusSeconds = 0;
double lastLevelsSeconds = 0;
double lastStorageSeconds = -5;
try
{
    Directory.CreateDirectory(root);
    hostLock = new FileStream(Path.Combine(root, "audio-host.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    var pending = FrameCodec.ReadAsync(input);
    while (true)
    {
        if (session?.Store.Status().State is "recording" or "paused")
        {
            var completed = session.Failure.IsCompleted ? session.Failure :
                await Task.WhenAny(pending, session.Failure,
                    Task.Delay(session.Store.Status().State == "recording" ? 250 : 1000));
            if (completed == session.Failure)
            {
                var failure = await session.Failure;
                await session.StopAsync(failed: true, failure.Code);
                await Emit("error", new ErrorPayload(failure.Code, failure.Message, failure.Retryable), recordingId: session.Store.RecordingId);
                continue;
            }
            if (session.ElapsedSeconds >= 3600)
            {
                await session.StopAsync();
                await Emit("recording.stopped", session.Store.Status(), recordingId: session.Store.RecordingId);
                continue;
            }
            if (session.ElapsedSeconds - lastStorageSeconds >= 5)
            {
                try
                {
                    await Emit("storage.status", storage.Read());
                    storage.EnsureCaptureCapacity();
                    lastStorageSeconds = session.ElapsedSeconds;
                }
                catch (AudioException error)
                {
                    await session.StopAsync(failed: true, error.Code);
                    await Emit("error", new ErrorPayload(error.Code, error.Message, error.Retryable),
                        recordingId: session.Store.RecordingId);
                    continue;
                }
            }
            if (session.ElapsedSeconds - lastStatusSeconds >= 1)
            {
                await Emit("recording.status", session.Store.Status(), recordingId: session.Store.RecordingId);
                lastStatusSeconds = session.ElapsedSeconds;
            }
            if (session.Store.Status().State == "recording" && session.ElapsedSeconds - lastLevelsSeconds >= 0.25)
            {
                await Emit("recording.levels", session.ReadLevels(), recordingId: session.Store.RecordingId);
                lastLevelsSeconds = session.ElapsedSeconds;
            }
            if (completed != pending)
            {
                continue;
            }
        }
        var payload = await pending;
        if (payload is null) break;
        AudioRequest? request = null;
        try
        {
            request = JsonSerializer.Deserialize<AudioRequest>(payload, AudioJson.Options)
                ?? throw new AudioException("invalid_request", "A request object is required.");
            request.Validate();
            switch (request.Command)
            {
                case "list_devices":
                    await Emit("devices", new { Devices = DeviceCatalog.List() }, request.RequestId);
                    break;
                case "check_storage":
                    await Emit("storage.status", storage.Read(request.StorageQuotaBytes), request.RequestId);
                    break;
                case "get_recording":
                    await Emit("recording.manifest", archive.Describe(request.RecordingId!.Value, request.Offset!.Value,
                        Snapshot(request.RecordingId.Value)), request.RequestId, request.RecordingId);
                    break;
                case "list_recording_chunks":
                    await Emit("recording.chunks", archive.List(request.RecordingId!.Value, request.TrackId!.Value,
                        request.SequenceStart!.Value, Snapshot(request.RecordingId.Value)), request.RequestId, request.RecordingId);
                    break;
                case "read_chunk":
                    await Emit("recording.chunk_range", archive.Read(request.RecordingId!.Value, request.ChunkId!.Value,
                        request.Offset!.Value, request.Length!.Value, Snapshot(request.RecordingId.Value)), request.RequestId, request.RecordingId);
                    break;
                case "inspect_recording":
                    if (session is not null && session.Store.RecordingId == request.RecordingId && session.Store.Status().State is "recording" or "paused")
                        throw new AudioException("invalid_state", "Stop the active recording before inspecting it.");
                    await Emit("recording.inspected", RecordingStore.Inspect(root, request.RecordingId!.Value, protector),
                        request.RequestId, request.RecordingId);
                    break;
                case "recover_recording":
                    if (session is not null)
                        throw new AudioException("invalid_state", "Use a fresh AudioHost process to recover an inactive recording.");
                    await Emit("recording.recovered", RecordingStore.Recover(root, request.RecordingId!.Value, protector,
                        request.AcceptIncomplete == true, storage), request.RequestId, request.RecordingId);
                    break;
                case "start_recording":
                    if (session is not null)
                        throw new AudioException("invalid_state", "Use a new AudioHost process for each recording.");
                    await Emit("storage.status", storage.Read(request.StorageQuotaBytes ?? StorageBudget.DefaultQuotaBytes));
                    session = new CaptureSession(root, request.RecordingId!.Value, request.Tracks!, protector, storage);
                    try
                    {
                        session.StartEpoch();
                    }
                    catch
                    {
                        await session.StopAsync(failed: true, "start_failed");
                        throw;
                    }
                    await Emit("recording.started", session.Store.Status(), request.RequestId, request.RecordingId);
                    break;
                default:
                    if (session is null || session.Store.RecordingId != request.RecordingId)
                        throw new AudioException("recording_not_found", "This process is not capturing the requested recording.");
                    var state = session.Store.Status().State;
                    if (request.Command == "start_live_preview")
                    {
                        await Emit("recording.live_started", session.StartLive(request.MaxBufferedMs ?? 5000), request.RequestId, request.RecordingId);
                    }
                    else if (request.Command is "read_live_audio" or "read_live_audio_timed" or "stop_live_preview")
                    {
                        await Emit(request.Command != "stop_live_preview" ? "recording.live_audio" : "recording.live_stopped",
                            session.ReadLive(request.PreviewId!.Value, request.Command == "stop_live_preview", request.Command == "read_live_audio_timed"),
                            request.RequestId, request.RecordingId);
                    }
                    else if (request.Command == "pause_recording" && state == "recording")
                    {
                        await session.PauseAsync();
                        await Emit("recording.paused", session.Store.Status(), request.RequestId, request.RecordingId);
                    }
                    else if (request.Command == "resume_recording" && state == "paused")
                    {
                        try
                        {
                            session.StartEpoch();
                        }
                        catch
                        {
                            await session.StopAsync(failed: true, "resume_failed");
                            throw;
                        }
                        await Emit("recording.resumed", session.Store.Status(), request.RequestId, request.RecordingId);
                    }
                    else if (request.Command == "stop_recording" && state is "recording" or "paused" or "sealed")
                    {
                        if (state != "sealed") await session.StopAsync();
                        await Emit("recording.stopped", session.Store.Status(), request.RequestId, request.RecordingId);
                    }
                    else
                        throw new AudioException("invalid_state", "The command is not valid in the current recording state.");
                    break;
            }
        }
        catch (AudioException error)
        {
            await Emit("error", new ErrorPayload(error.Code, error.Message, error.Retryable), request?.RequestId, request?.RecordingId);
        }
        catch (JsonException)
        {
            await Emit("error", new ErrorPayload("invalid_request", "The control message does not match the protocol.", false));
        }
        catch (COMException)
        {
            await Emit("error", new ErrorPayload("device_unavailable", "Windows could not open the selected audio endpoint.", true),
                request?.RequestId, request?.RecordingId);
        }
        pending = FrameCodec.ReadAsync(input);
    }
}
catch (Exception error) when (error is IOException or UnauthorizedAccessException or CryptographicException or AudioException or TimeoutException)
{
    Console.Error.WriteLine($"host_failed: {error.GetType().Name}; inspect the recording before considering its audio complete.");
    exitCode = 1;
}
finally
{
    if (session?.Store.Status().State is "recording" or "paused")
    {
        try
        {
            await session.StopAsync();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or CryptographicException or AudioException or TimeoutException)
        {
            Console.Error.WriteLine($"seal_failed: {error.GetType().Name}; saved chunks were not deleted.");
            exitCode = 1;
        }
    }
    hostLock?.Dispose();
}
return exitCode;

Task Emit(string eventType, object value, Guid? requestId = null, Guid? recordingId = null) =>
    FrameCodec.WriteAsync(output, new AudioEvent(1, requestId, recordingId, eventType, value));

RecordingManifest? Snapshot(Guid id) => session?.Store.RecordingId == id ? session.Store.Snapshot() : null;
