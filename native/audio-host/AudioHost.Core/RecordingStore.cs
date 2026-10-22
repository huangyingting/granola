using System.Security.Cryptography;
using System.Text.Json;

namespace WindowsAiNotes.Audio;

public sealed class RecordingStore
{
    private readonly object gate = new();
    private readonly IKeyProtector protector;
    private readonly string directory;
    private readonly RecordingManifest manifest;
    private readonly StorageBudget storage;

    public Guid RecordingId => manifest.RecordingId;
    public string DirectoryPath => directory;

    public RecordingStore(string root, Guid recordingId, IReadOnlyList<TrackSpec> tracks, IKeyProtector protector,
        IReadOnlyDictionary<Guid, string>? actualDevices = null, StorageBudget? storage = null)
    {
        new AudioRequest(1, Guid.NewGuid(), "start_recording", recordingId, tracks.ToArray()).Validate();
        this.protector = protector;
        directory = Path.Combine(Path.GetFullPath(root), recordingId.ToString("D"));
        Directory.CreateDirectory(root);
        this.storage = storage ?? new StorageBudget(root);
        if (Directory.Exists(directory))
            throw new AudioException("recording_exists", "This recording already exists; inspect it instead of overwriting it.");
        this.storage.EnsureCaptureCapacity();
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

    public RecordingManifest Snapshot()
    {
        lock (gate)
            return new RecordingManifest
            {
                FormatVersion = manifest.FormatVersion,
                RecordingId = manifest.RecordingId,
                CreatedAt = manifest.CreatedAt,
                State = manifest.State,
                Tracks = manifest.Tracks.Select(t => new TrackManifest
                {
                    Spec = t.Spec,
                    ActualDeviceId = t.ActualDeviceId,
                    SavedSamples = t.SavedSamples,
                    ChunkIds = [.. t.ChunkIds]
                }).ToList(),
                Events = [.. manifest.Events]
            };
    }

    public void Transition(string state, string eventType, double clockMs, Guid? epoch = null, string? code = null)
    {
        lock (gate)
        {
            if (manifest.Events.Count >= 10_000)
                throw new AudioException("storage_limit", "The recording timeline reached its supported event limit.");
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
            if (manifest.Tracks.Sum(t => t.ChunkIds.Count) >= 10_000)
                throw new AudioException("storage_limit", "The recording reached its supported chunk count.");
            RecordingArchive.ValidateChunk(metadata, pcm, RecordingId, metadata.ChunkId);
            var track = manifest.Tracks.Single(t => t.Spec.TrackId == metadata.TrackId);
            if (metadata.Sequence != track.ChunkIds.Count || metadata.SampleStart != track.SavedSamples)
                throw new InvalidDataException("Chunk sequence or sample range is inconsistent.");
            if (manifest.Tracks.Sum(t => t.SavedSamples) * 2L + pcm.Length > 5L * 1024 * 1024 * 1024)
                throw new AudioException("storage_limit", "The 5 GiB probe recording limit has been reached.");
            EncryptedFile.Write(Path.Combine(directory, metadata.ChunkId.ToString("D") + ".chunk"),
                RecordingId, "audio_chunk", metadata, pcm, protector, storage);
            track.ChunkIds.Add(metadata.ChunkId);
            track.SavedSamples += metadata.SampleCount;
            SaveManifest();
        }
    }

    private void SaveManifest() => EncryptedFile.Write(Path.Combine(directory, "manifest.enc"), RecordingId,
        "manifest", null, JsonSerializer.SerializeToUtf8Bytes(manifest, AudioJson.Options), protector, storage);

    public static RecoveryReport Inspect(string root, Guid recordingId, IKeyProtector protector) =>
        Scan(root, recordingId, protector).Report;

    public static RecoveryReport Recover(string root, Guid recordingId, IKeyProtector protector, bool acceptIncomplete,
        StorageBudget? storage = null)
    {
        if (!acceptIncomplete)
            throw new AudioException("confirmation_required", "Recovery requires accepting that the uncommitted audio tail may be missing.");
        var (manifest, chunks, report) = Scan(root, recordingId, protector);
        if (manifest is null || manifest.State == "sealed" || report.State == "key_unavailable"
            || report.Issues.Any(i => i.Code is not ("unsealed_tail" or "uncommitted_file")))
            throw new AudioException("recovery_unsafe",
                "Recovery requires an authenticated, unsealed manifest and unambiguous contiguous chunks. Original files were preserved.");
        if (report.RecoveredChunks == 0)
        {
            if (manifest.Events.LastOrDefault()?.EventType == "recovery.adopted")
                return report;
            throw new AudioException("nothing_to_recover", "No authenticated orphan chunks are available to recover.");
        }
        if (manifest.Events.Count >= 10_000 || report.TotalSamples * 2 > 5L * 1024 * 1024 * 1024)
            throw new AudioException("storage_limit", "Recovery would exceed the supported recording limits.");
        foreach (var track in manifest.Tracks)
        {
            var ordered = chunks.Where(c => c.TrackId == track.Spec.TrackId).OrderBy(c => c.Sequence).ToArray();
            track.ChunkIds.Clear();
            track.ChunkIds.AddRange(ordered.Select(c => c.ChunkId));
            track.SavedSamples = ordered.Sum(c => (long)c.SampleCount);
        }
        manifest.State = "failed";
        var clock = Math.Max(manifest.Events.Select(e => e.ClockMs).DefaultIfEmpty().Max(),
            chunks.Select(c => c.ClockEndMs).DefaultIfEmpty().Max());
        manifest.Events.Add(new TimelineEvent("recovery.adopted", clock, null, "unsealed_tail"));
        RecordingArchive.ValidateManifest(manifest, recordingId);
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(manifest, AudioJson.Options);
        try
        {
            EncryptedFile.Write(Path.Combine(Path.GetFullPath(root), recordingId.ToString("D"), "manifest.enc"),
                recordingId, "manifest", null, plaintext, protector, storage ?? new StorageBudget(root));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
        return Inspect(root, recordingId, protector);
    }

    private static (RecordingManifest? Manifest, List<ChunkMetadata> Chunks, RecoveryReport Report)
        Scan(string root, Guid recordingId, IKeyProtector protector)
    {
        var directory = Path.Combine(Path.GetFullPath(root), recordingId.ToString("D"));
        if (!Directory.Exists(directory))
            throw new AudioException("recording_not_found", "No local recording exists with this ID.");
        var issues = new List<RecoveryIssue>();
        RecordingManifest manifest;
        byte[]? manifestBytes = null;
        try
        {
            (_, manifestBytes) = EncryptedFile.Read(Path.Combine(directory, "manifest.enc"), recordingId, "manifest", protector);
            manifest = JsonSerializer.Deserialize<RecordingManifest>(manifestBytes, AudioJson.Options)
                ?? throw new InvalidDataException("Missing recording manifest.");
            RecordingArchive.ValidateManifest(manifest, recordingId);
        }
        catch (AudioException error) when (error.Code == "key_unavailable")
        {
            return (null, [], new RecoveryReport("key_unavailable", 0, 0, 0, [new(error.Code, error.Message)]));
        }
        catch (Exception error) when (IsDamagedFile(error))
        {
            return (null, [], new RecoveryReport("incomplete", 0, 0, 0,
                [new("manifest_unreadable", "The encrypted manifest is missing, damaged, or unauthenticated. No files were changed.")]));
        }
        finally
        {
            if (manifestBytes is not null) CryptographicOperations.ZeroMemory(manifestBytes);
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
            byte[]? pcm = null;
            try
            {
                EnvelopeHeader header;
                (header, pcm) = EncryptedFile.Read(path, recordingId, "audio_chunk", protector);
                var chunk = header.Chunk ?? throw new InvalidDataException("Missing chunk descriptor.");
                RecordingArchive.ValidateChunk(chunk, pcm, recordingId, chunk.ChunkId);
                if (Path.GetFileName(path) != chunk.ChunkId.ToString("D") + ".chunk"
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
            finally
            {
                if (pcm is not null) CryptographicOperations.ZeroMemory(pcm);
            }
        }
        var byId = verified.ToDictionary(c => c.ChunkId);
        var expected = manifest.Tracks.SelectMany(t => t.ChunkIds).ToHashSet();
        if (expected.Except(verified.Select(c => c.ChunkId)).Any())
            AddIssue("chunk_missing", "At least one manifest chunk is missing or failed verification.");
        var orphans = verified.Count(c => !expected.Contains(c.ChunkId));
        foreach (var track in manifest.Tracks)
        {
            long declaredPosition = 0;
            for (var i = 0; i < track.ChunkIds.Count; i++)
            {
                if (!byId.TryGetValue(track.ChunkIds[i], out var chunk)) continue;
                if (chunk.TrackId != track.Spec.TrackId || chunk.Sequence != i || chunk.SampleStart != declaredPosition)
                    AddIssue("manifest_mismatch", "The declared chunk order or ownership does not match its authenticated metadata.");
                declaredPosition += chunk.SampleCount;
            }
            if (declaredPosition != track.SavedSamples)
                AddIssue("manifest_mismatch", "The declared saved sample count does not match its authenticated chunks.");
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
        return (manifest, verified, new RecoveryReport(keyUnavailable ? "key_unavailable" : damaged ? "incomplete" :
            manifest.State == "sealed" ? "sealed" : "interrupted", verified.Count, orphans,
            verified.Sum(c => (long)c.SampleCount), issues));

        void AddIssue(string code, string message)
        {
            if (issues.Count < 100 && !issues.Any(i => i.Code == code))
                issues.Add(new RecoveryIssue(code, message));
        }
    }

    internal static bool IsDamagedFile(Exception error) =>
        error is IOException or InvalidDataException or CryptographicException or JsonException or FormatException or ArgumentException or UnauthorizedAccessException;
}
