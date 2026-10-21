using System.Buffers.Binary;
using System.Text.Json;

namespace WindowsAiNotes.Audio;

public sealed record AudioRequest(int ProtocolVersion, Guid RequestId, string Command, Guid? RecordingId = null, TrackSpec[]? Tracks = null)
{
    public void Validate()
    {
        if (ProtocolVersion != 1 || RequestId == Guid.Empty)
            throw new AudioException("invalid_request", "Unsupported protocol version or invalid request ID.");
        if (Command == "list_devices")
        {
            if (RecordingId is not null || Tracks is not null)
                throw new AudioException("invalid_request", "Device enumeration does not accept recording fields.");
            return;
        }
        if (Command is not ("start_recording" or "pause_recording" or "resume_recording" or "stop_recording" or "inspect_recording")
            || RecordingId is null || RecordingId == Guid.Empty)
            throw new AudioException("invalid_request", "A supported command and recording ID are required.");
        if (Command != "start_recording")
        {
            if (Tracks is not null)
                throw new AudioException("invalid_request", "Only start_recording accepts tracks.");
            return;
        }
        if (Tracks is not { Length: >= 1 and <= 2 }
            || Tracks.Any(t => t is null)
            || Tracks.Select(t => t.TrackId).Distinct().Count() != Tracks.Length
            || Tracks.Select(t => t.Kind).Distinct().Count() != Tracks.Length)
            throw new AudioException("invalid_request", "Select one or two distinct capture tracks.");
        foreach (var track in Tracks)
        {
            if (track.TrackId == Guid.Empty || track.Kind is not ("microphone" or "loopback")
                || track.CaptureScope != "endpoint"
                || track.DeviceSelectionPolicy is not ("default" or "explicit")
                || string.IsNullOrEmpty(track.DeviceId) || track.DeviceId.Length > 1024
                || ((track.DeviceSelectionPolicy == "default") != (track.DeviceId == "default")))
                throw new AudioException("invalid_request", "Only explicitly declared endpoint capture is supported.");
        }
    }
}

public sealed record AudioEvent(int ProtocolVersion, Guid? RequestId, Guid? RecordingId, string EventType, object Payload);
public sealed record ErrorPayload(string Code, string Message, bool Retryable);

public static class FrameCodec
{
    public const int MaxControlBytes = 64 * 1024;

    public static async Task<byte[]?> ReadAsync(Stream stream, CancellationToken token = default)
    {
        var header = new byte[4];
        var read = await stream.ReadAsync(header.AsMemory(0, 4), token);
        if (read == 0) return null;
        await stream.ReadExactlyAsync(header.AsMemory(read), token);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > MaxControlBytes)
            throw new AudioException("invalid_frame", "Control frame length is invalid.");
        var payload = new byte[(int)length];
        await stream.ReadExactlyAsync(payload, token);
        return payload;
    }

    public static async Task WriteAsync(Stream stream, AudioEvent message, CancellationToken token = default)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(message, AudioJson.Options);
        if (body.Length > MaxControlBytes)
            throw new AudioException("message_too_large", "The response exceeds the protocol limit.");
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)body.Length);
        await stream.WriteAsync(header, token);
        await stream.WriteAsync(body, token);
        await stream.FlushAsync(token);
    }
}
