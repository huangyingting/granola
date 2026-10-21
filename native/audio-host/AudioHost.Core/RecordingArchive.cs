using System.Security.Cryptography;
using System.Text.Json;

namespace WindowsAiNotes.Audio;

public sealed class RecordingArchive(string root, IKeyProtector protector)
{
    public const int PageSize = 50;
    public const int MaxRangeBytes = 32 * 1024;

    public ManifestPage Describe(Guid recordingId, int eventOffset = 0, RecordingManifest? snapshot = null)
    {
        var manifest = Load(recordingId, snapshot);
        if (eventOffset < 0 || eventOffset > manifest.Events.Count)
            throw new AudioException("invalid_range", "The requested event page is outside this recording.");
        return new ManifestPage(1, recordingId, manifest.CreatedAt, manifest.State,
            manifest.Tracks.Select(t => new ArchiveTrack(t.Spec, t.ActualDeviceId, t.SavedSamples, t.ChunkIds.Count)).ToArray(),
            eventOffset, manifest.Events.Count, manifest.Events.Skip(eventOffset).Take(PageSize).ToArray(),
            eventOffset + PageSize < manifest.Events.Count);
    }

    public ChunkPage List(Guid recordingId, Guid trackId, int sequenceStart = 0, RecordingManifest? snapshot = null)
    {
        var manifest = Load(recordingId, snapshot);
        var track = manifest.Tracks.SingleOrDefault(t => t.Spec.TrackId == trackId)
            ?? throw new AudioException("track_not_found", "This recording does not contain the requested track.");
        if (sequenceStart < 0 || sequenceStart > track.ChunkIds.Count)
            throw new AudioException("invalid_range", "The requested chunk page is outside this track.");
        var chunks = track.ChunkIds.Skip(sequenceStart).Take(PageSize)
            .Select(id => WithChunk(manifest, id, (upload, _) => upload)).ToArray();
        return new ChunkPage(trackId, sequenceStart, chunks, sequenceStart + PageSize < track.ChunkIds.Count);
    }

    public ChunkRange Read(Guid recordingId, Guid chunkId, int offset, int length, RecordingManifest? snapshot = null)
    {
        if (offset < 0 || length is < 1 or > MaxRangeBytes)
            throw new AudioException("invalid_range", "Request a bounded range of this chunk's canonical WAV bytes.");
        var manifest = Load(recordingId, snapshot);
        return WithChunk(manifest, chunkId, (upload, wav) =>
        {
            if (offset >= wav.Length)
                throw new AudioException("invalid_range", "The requested byte offset is outside this chunk.");
            var count = Math.Min(length, wav.Length - offset);
            return new ChunkRange(upload, offset, Convert.ToBase64String(wav, offset, count), offset + count == wav.Length);
        });
    }

    private RecordingManifest Load(Guid recordingId, RecordingManifest? snapshot)
    {
        if (recordingId == Guid.Empty)
            throw new AudioException("invalid_request", "A nonempty recording ID is required.");
        byte[]? plaintext = null;
        try
        {
            if (snapshot is not null)
            {
                ValidateManifest(snapshot, recordingId);
                return snapshot;
            }
            var directory = DirectoryFor(recordingId);
            if (!Directory.Exists(directory))
                throw new AudioException("recording_not_found", "No local recording exists with this ID.");
            (_, plaintext) = EncryptedFile.Read(Path.Combine(directory, "manifest.enc"), recordingId, "manifest", protector);
            var manifest = JsonSerializer.Deserialize<RecordingManifest>(plaintext, AudioJson.Options)
                ?? throw new InvalidDataException("Missing recording manifest.");
            ValidateManifest(manifest, recordingId);
            return manifest;
        }
        catch (Exception error) when (RecordingStore.IsDamagedFile(error))
        {
            throw new AudioException("manifest_unreadable",
                "The recording manifest is missing, damaged, or unauthenticated. Original files were preserved.", inner: error);
        }
        finally
        {
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private T WithChunk<T>(RecordingManifest manifest, Guid chunkId, Func<UploadChunk, byte[], T> read)
    {
        var track = manifest.Tracks.SingleOrDefault(t => t.ChunkIds.Contains(chunkId))
            ?? throw new AudioException("chunk_not_found", "This recording does not declare the requested chunk.");
        byte[]? pcm = null;
        byte[]? wav = null;
        try
        {
            var path = Path.Combine(DirectoryFor(manifest.RecordingId), chunkId.ToString("D") + ".chunk");
            EnvelopeHeader header;
            // Authenticate the complete envelope before exposing any plaintext byte range.
            (header, pcm) = EncryptedFile.Read(path, manifest.RecordingId, "audio_chunk", protector);
            var chunk = header.Chunk ?? throw new InvalidDataException("Missing chunk descriptor.");
            ValidateChunk(chunk, pcm, manifest.RecordingId, chunkId);
            if (chunk.TrackId != track.Spec.TrackId || chunk.Sequence != track.ChunkIds.IndexOf(chunkId)
                || chunk.SampleStart + chunk.SampleCount > track.SavedSamples
                || (chunk.Sequence == 0 && chunk.SampleStart != 0)
                || (chunk.Sequence == track.ChunkIds.Count - 1 && chunk.SampleStart + chunk.SampleCount != track.SavedSamples))
                throw new InvalidDataException("The chunk does not match its authenticated manifest.");
            wav = PcmChunkWriter.ToWav(pcm);
            var upload = new UploadChunk(chunk, wav.Length, Convert.ToHexStringLower(SHA256.HashData(wav)));
            return read(upload, wav);
        }
        catch (Exception error) when (RecordingStore.IsDamagedFile(error))
        {
            throw new AudioException("chunk_unreadable",
                "The declared chunk is missing, damaged, or unauthenticated. Original files were preserved.", inner: error);
        }
        finally
        {
            if (pcm is not null) CryptographicOperations.ZeroMemory(pcm);
            if (wav is not null) CryptographicOperations.ZeroMemory(wav);
        }
    }

    private string DirectoryFor(Guid recordingId) => Path.Combine(Path.GetFullPath(root), recordingId.ToString("D"));

    internal static void ValidateManifest(RecordingManifest manifest, Guid recordingId)
    {
        if (manifest.FormatVersion != 1 || manifest.RecordingId != recordingId
            || manifest.State is not ("recording" or "paused" or "sealed" or "failed")
            || manifest.Tracks is null || manifest.Events is null
            || manifest.Tracks.Any(t => t is null || t.Spec is null || t.ChunkIds is null)
            || manifest.Events.Any(e => e is null))
            throw new InvalidDataException("Invalid recording manifest.");
        try
        {
            new AudioRequest(1, Guid.NewGuid(), "start_recording", recordingId, manifest.Tracks.Select(t => t.Spec).ToArray()).Validate();
        }
        catch (AudioException error)
        {
            throw new InvalidDataException("Invalid recording tracks.", error);
        }
        var ids = manifest.Tracks.SelectMany(t => t.ChunkIds).ToArray();
        if (ids.Length > 10_000 || ids.Any(id => id == Guid.Empty) || ids.Distinct().Count() != ids.Length
            || manifest.Events.Count > 10_000
            || manifest.Tracks.Any(t => string.IsNullOrEmpty(t.ActualDeviceId) || t.ActualDeviceId.Length > 1024
                || t.SavedSamples < t.ChunkIds.Count || t.SavedSamples > (long)t.ChunkIds.Count * PcmChunkWriter.MaxSamples)
            || manifest.Events.Any(e => string.IsNullOrEmpty(e.EventType) || e.EventType.Length > 80
                || !double.IsFinite(e.ClockMs) || e.ClockMs < 0 || e.CaptureEpoch == Guid.Empty || e.Code?.Length > 80))
            throw new InvalidDataException("Invalid recording manifest bounds.");
    }

    internal static void ValidateChunk(ChunkMetadata chunk, ReadOnlySpan<byte> pcm, Guid recordingId, Guid chunkId)
    {
        if (chunk.FormatVersion != 1 || chunk.RecordingId != recordingId || chunk.ChunkId != chunkId
            || chunk.ChunkId == Guid.Empty || chunk.TrackId == Guid.Empty || chunk.CaptureEpoch == Guid.Empty
            || chunk.Sequence is < 0 or >= 10_000 || chunk.SampleStart < 0
            || chunk.SampleStart > 9_007_199_254_740_991L - chunk.SampleCount
            || chunk.SampleRate != 16_000 || chunk.Channels != 1 || chunk.BitsPerSample != 16
            || chunk.SampleCount is <= 0 or > PcmChunkWriter.MaxSamples || pcm.Length != chunk.SampleCount * 2
            || !double.IsFinite(chunk.ClockStartMs) || !double.IsFinite(chunk.ClockEndMs)
            || chunk.ClockStartMs < 0 || chunk.ClockEndMs < chunk.ClockStartMs
            || Convert.ToHexStringLower(SHA256.HashData(pcm)) != chunk.PcmSha256)
            throw new InvalidDataException("Invalid chunk metadata or checksum.");
    }
}
