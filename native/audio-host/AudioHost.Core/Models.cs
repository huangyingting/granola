using System.Text.Json;
using System.Text.Json.Serialization;

namespace WindowsAiNotes.Audio;

public static class AudioJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        RespectNullableAnnotations = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
}

public sealed record TrackSpec(Guid TrackId, string Kind, string CaptureScope, string DeviceSelectionPolicy, string DeviceId);
public sealed record DeviceInfo(string DeviceId, string Name, string Kind, bool IsDefault);
public sealed record ChunkMetadata(
    int FormatVersion, Guid RecordingId, Guid TrackId, Guid ChunkId, Guid CaptureEpoch,
    int Sequence, long SampleStart, int SampleCount, int SampleRate, int Channels,
    int BitsPerSample, double ClockStartMs, double ClockEndMs, string PcmSha256);
public sealed record TimelineEvent(string EventType, double ClockMs, Guid? CaptureEpoch, string? Code);
public sealed record RecoveryIssue(string Code, string Message);
public sealed record RecoveryReport(string State, int VerifiedChunks, int RecoveredChunks, long TotalSamples, IReadOnlyList<RecoveryIssue> Issues);
public sealed record SavedTrack(Guid TrackId, long SavedSamples, string DeviceId, string Kind, string CaptureScope, string DeviceSelectionPolicy);
public sealed record RecordingStatus(string State, IReadOnlyList<SavedTrack> Tracks);
public sealed record ArchiveTrack(TrackSpec Spec, string ActualDeviceId, long SavedSamples, int ChunkCount);
public sealed record ManifestPage(int FormatVersion, Guid RecordingId, DateTimeOffset CreatedAt, string State,
    IReadOnlyList<ArchiveTrack> Tracks, int EventOffset, int EventCount, IReadOnlyList<TimelineEvent> Events, bool HasMore);
public sealed record UploadChunk(ChunkMetadata Chunk, int SizeBytes, string Sha256);
public sealed record ChunkPage(Guid TrackId, int SequenceStart, IReadOnlyList<UploadChunk> Chunks, bool HasMore);
public sealed record ChunkRange(UploadChunk Upload, int Offset, string DataBase64, bool EndOfChunk);

public sealed class TrackManifest
{
    public required TrackSpec Spec { get; init; }
    public required string ActualDeviceId { get; init; }
    public long SavedSamples { get; set; }
    public List<Guid> ChunkIds { get; init; } = [];
}

public sealed class RecordingManifest
{
    public int FormatVersion { get; init; } = 1;
    public required Guid RecordingId { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public string State { get; set; } = "recording";
    public required List<TrackManifest> Tracks { get; init; }
    public List<TimelineEvent> Events { get; init; } = [];
}

public sealed class AudioException(string code, string message, bool retryable = false, Exception? inner = null)
    : Exception(message, inner)
{
    public string Code { get; } = code;
    public bool Retryable { get; } = retryable;
}

public interface IKeyProtector
{
    byte[] Protect(byte[] key);
    byte[] Unprotect(byte[] wrappedKey);
}
