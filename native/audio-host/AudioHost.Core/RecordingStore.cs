using System.Security.Cryptography;
using System.Text.Json;

namespace WindowsAiNotes.Audio;

public sealed class RecordingStore
{
    private readonly object gate = new();
    private readonly IKeyProtector protector;
    private readonly string directory;
    private readonly RecordingManifest manifest;

    public Guid RecordingId => manifest.RecordingId;
    public string DirectoryPath => directory;

    public RecordingStore(string root, Guid recordingId, IReadOnlyList<TrackSpec> tracks, IKeyProtector protector,
        IReadOnlyDictionary<Guid, string>? actualDevices = null)
    {
        new AudioRequest(1, Guid.NewGuid(), "start_recording", recordingId, tracks.ToArray()).Validate();
        this.protector = protector;
        directory = Path.Combine(Path.GetFullPath(root), recordingId.ToString("D"));
        Directory.CreateDirectory(root);
        if (Directory.Exists(directory))
            throw new AudioException("recording_exists", "This recording already exists; inspect it instead of overwriting it.");
        Directory.CreateDirectory(directory);
        manifest = new RecordingManifest
        {
            RecordingId = recordingId,
            CreatedAt = DateTimeOffset.UtcNow,
            Tracks = tracks.Select(spec => new TrackManifest
            {
                Spec = spec,
                ActualDeviceId = actualDevices is null ? spec.DeviceId : actualDevices[spec.TrackId]
            }).ToList()
        };
        SaveManifest();
    }

    public RecordingStatus Status()
    {
        lock (gate)
            return new RecordingStatus(manifest.State, manifest.Tracks.Select(t => new SavedTrack(t.Spec.TrackId,
                t.SavedSamples, t.ActualDeviceId, t.Spec.Kind, t.Spec.CaptureScope, t.Spec.DeviceSelectionPolicy)).ToArray());
    }

    public void Transition(string state, string eventType, double clockMs, Guid? epoch = null, string? code = null)
    {
        lock (gate)
        {
            manifest.State = state;
            manifest.Events.Add(new TimelineEvent(eventType, clockMs, epoch, code));
            SaveManifest();
        }
    }

    public void Commit(ChunkMetadata metadata, ReadOnlySpan<byte> pcm)
    {
        lock (gate)
        {
            if (manifest.State != "recording")
                throw new AudioException("invalid_state", "Audio cannot be appended to an inactive recording.");
            var track = manifest.Tracks.Single(t => t.Spec.TrackId == metadata.TrackId);
            if (metadata.Sequence != track.ChunkIds.Count || metadata.SampleStart != track.SavedSamples)
                throw new InvalidDataException("Chunk sequence or sample range is inconsistent.");
            if (manifest.Tracks.Sum(t => t.SavedSamples) * 2L + pcm.Length > 5L * 1024 * 1024 * 1024)
                throw new AudioException("storage_limit", "The 5 GiB probe recording limit has been reached.");
            var drive = new DriveInfo(Path.GetPathRoot(directory)!);
            if (drive.AvailableFreeSpace < 64L * 1024 * 1024)
                throw new AudioException("disk_full", "Less than 64 MiB is available; recording must stop.");
            EncryptedFile.Write(Path.Combine(directory, metadata.ChunkId.ToString("D") + ".chunk"),
                RecordingId, "audio_chunk", metadata, pcm, protector);
            track.ChunkIds.Add(metadata.ChunkId);
            track.SavedSamples += metadata.SampleCount;
            SaveManifest();
        }
    }

    private void SaveManifest() => EncryptedFile.Write(Path.Combine(directory, "manifest.enc"), RecordingId,
        "manifest", null, JsonSerializer.SerializeToUtf8Bytes(manifest, AudioJson.Options), protector);

    public static RecoveryReport Inspect(string root, Guid recordingId, IKeyProtector protector)
    {
        var directory = Path.Combine(Path.GetFullPath(root), recordingId.ToString("D"));
        if (!Directory.Exists(directory))
            throw new AudioException("recording_not_found", "No local recording exists with this ID.");
        var issues = new List<RecoveryIssue>();
        RecordingManifest manifest;
        try
        {
            var (_, plaintext) = EncryptedFile.Read(Path.Combine(directory, "manifest.enc"), recordingId, "manifest", protector);
            manifest = JsonSerializer.Deserialize<RecordingManifest>(plaintext, AudioJson.Options)
                ?? throw new InvalidDataException("Missing recording manifest.");
            if (manifest.FormatVersion != 1 || manifest.RecordingId != recordingId)
                throw new InvalidDataException("Invalid recording manifest.");
        }
        catch (AudioException error) when (error.Code == "key_unavailable")
        {
            return new RecoveryReport("key_unavailable", 0, 0, 0, [new(error.Code, error.Message)]);
        }
        catch (Exception error) when (IsDamagedFile(error))
        {
            return new RecoveryReport("incomplete", 0, 0, 0,
                [new("manifest_unreadable", "The encrypted manifest is missing, damaged, or unauthenticated. No files were changed.")]);
        }
        var verified = new List<ChunkMetadata>();
        var keyUnavailable = false;
        foreach (var path in Directory.EnumerateFiles(directory, "*.chunk").Take(10_001))
        {
            if (verified.Count >= 10_000)
            {
                AddIssue("storage_limit", "The recording exceeds the supported chunk count.");
                break;
            }
            try
            {
                var (header, pcm) = EncryptedFile.Read(path, recordingId, "audio_chunk", protector);
                var chunk = header.Chunk ?? throw new InvalidDataException("Missing chunk descriptor.");
                if (chunk.FormatVersion != 1 || chunk.RecordingId != recordingId
                    || Path.GetFileName(path) != chunk.ChunkId.ToString("D") + ".chunk"
                    || chunk.SampleRate != 16_000 || chunk.Channels != 1 || chunk.BitsPerSample != 16
                    || chunk.SampleCount is <= 0 or > PcmChunkWriter.MaxSamples
                    || pcm.Length != chunk.SampleCount * 2
                    || !double.IsFinite(chunk.ClockStartMs) || !double.IsFinite(chunk.ClockEndMs)
                    || chunk.ClockStartMs < 0 || chunk.ClockEndMs < chunk.ClockStartMs
                    || Convert.ToHexStringLower(SHA256.HashData(pcm)) != chunk.PcmSha256
                    || !manifest.Tracks.Any(t => t.Spec.TrackId == chunk.TrackId))
                    throw new InvalidDataException("Invalid chunk metadata or checksum.");
                verified.Add(chunk);
            }
            catch (AudioException error) when (error.Code == "key_unavailable")
            {
                keyUnavailable = true;
                AddIssue(error.Code, "A chunk key cannot be unlocked. The original files were preserved.");
            }
            catch (Exception error) when (IsDamagedFile(error))
            {
                AddIssue("chunk_corrupt", "A chunk is truncated, damaged, or unauthenticated.");
            }
        }
        var expected = manifest.Tracks.SelectMany(t => t.ChunkIds).ToHashSet();
        if (expected.Except(verified.Select(c => c.ChunkId)).Any())
            AddIssue("chunk_missing", "At least one manifest chunk is missing or failed verification.");
        var orphans = verified.Count(c => !expected.Contains(c.ChunkId));
        foreach (var track in manifest.Tracks)
        {
            long position = 0;
            var chunks = verified.Where(c => c.TrackId == track.Spec.TrackId).OrderBy(c => c.Sequence).ToArray();
            for (var i = 0; i < chunks.Length; i++)
            {
                if (chunks[i].Sequence != i || chunks[i].SampleStart != position)
                    AddIssue("sample_gap", "The chunk sequence or sample ranges contain a gap or overlap.");
                position += chunks[i].SampleCount;
            }
            if (manifest.State == "sealed" && position != track.SavedSamples)
                AddIssue("end_mismatch", "The sealed track length does not match its authenticated chunks.");
        }
        if (Directory.EnumerateFiles(directory, "*.partial").Any())
            AddIssue("uncommitted_file", "An unfinished encrypted file exists and is not counted as saved audio.");
        if (manifest.State != "sealed")
            AddIssue("unsealed_tail", "The recording did not seal successfully; its uncommitted tail may be missing.");
        var damaged = issues.Any(i => i.Code != "unsealed_tail");
        return new RecoveryReport(keyUnavailable ? "key_unavailable" : damaged ? "incomplete" :
            manifest.State == "sealed" ? "sealed" : "interrupted", verified.Count, orphans,
            verified.Sum(c => (long)c.SampleCount), issues);

        void AddIssue(string code, string message)
        {
            if (issues.Count < 100 && !issues.Any(i => i.Code == code))
                issues.Add(new RecoveryIssue(code, message));
        }
    }

    private static bool IsDamagedFile(Exception error) =>
        error is IOException or InvalidDataException or CryptographicException or JsonException or FormatException or ArgumentException;
}
