using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

internal sealed class CaptureSession
{
    private readonly TrackSpec[] specs;
    private readonly Dictionary<Guid, string> endpoints = [];
    private readonly Dictionary<Guid, PcmChunkWriter> writers = [];
    private readonly List<CaptureTrack> captures = [];
    private readonly CaptureClock clock = new();
    private readonly string? captureClock;
    private readonly TaskCompletionSource<AudioException> failure = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly StorageBudget storage;
    private Guid captureEpoch;
    private PcmLiveBuffer? live;
    public RecordingStore Store { get; }
    public Task<AudioException> Failure => failure.Task;
    public double ElapsedSeconds => clock.Elapsed.TotalSeconds;

    public CaptureSession(string root, Guid recordingId, TrackSpec[] specs, IKeyProtector protector, StorageBudget storage,
        string? captureClock = null)
    {
        this.specs = specs;
        this.storage = storage;
        this.captureClock = captureClock;
        storage.EnsureCaptureCapacity();
        foreach (var spec in specs)
        {
            using var endpoint = DeviceCatalog.Resolve(spec);
            endpoints.Add(spec.TrackId, endpoint.ID);
        }
        Store = new RecordingStore(root, recordingId, specs, protector, endpoints, storage);
        foreach (var spec in specs)
            writers.Add(spec.TrackId, new PcmChunkWriter(Store, spec.TrackId));
    }

    public void StartEpoch()
    {
        storage.EnsureCaptureCapacity();
        var epoch = Guid.NewGuid();
        captureEpoch = epoch;
        Store.Transition("recording", "capture.started", clock.Elapsed.TotalMilliseconds, epoch, captureClock);
        foreach (var spec in specs)
        {
            writers[spec.TrackId].BeginEpoch(epoch);
            var endpoint = DeviceCatalog.Resolve(spec, endpoints[spec.TrackId]);
            try
            {
                captures.Add(new CaptureTrack(endpoint, spec.TrackId, spec.Kind, writers[spec.TrackId], clock, failure,
                    (sampleStart, bytes, startMs, endMs) =>
                        Volatile.Read(ref live)?.Append(spec.TrackId, epoch, sampleStart, bytes, startMs, endMs), captureClock));
            }
            catch
            {
                endpoint.Dispose();
                throw;
            }
        }
        foreach (var capture in captures) capture.Start();
    }

    public CaptureLevels ReadLevels()
    {
        var tracks = captures.Select(capture => capture.ReadLevel()).ToArray();
        return new CaptureLevels(captureEpoch, clock.Elapsed.TotalMilliseconds, tracks);
    }

    public LiveAudioBatch StartLive(int maxBufferedMs = 5000)
    {
        if (Store.Status().State != "recording")
            throw new AudioException("invalid_state", "Live preview requires an active recording.");
        if (live?.IsActive == true)
            throw new AudioException("live_preview_active", "Stop the existing live preview before starting another.");
        var preview = new PcmLiveBuffer(Store.RecordingId, captureEpoch, specs.Select(spec => spec.TrackId).ToArray(), maxBufferedMs);
        Interlocked.Exchange(ref live, preview)?.Dispose();
        return preview.Snapshot();
    }

    public LiveAudioBatch ReadLive(Guid previewId, bool stop = false, bool timed = false)
    {
        var preview = Volatile.Read(ref live);
        if (preview is null || preview.PreviewId != previewId)
            throw new AudioException("live_preview_not_found", "This process does not have the requested live preview.");
        if (stop) preview.Stop();
        var batch = preview.Read(clock.Elapsed.TotalMilliseconds);
        var observed = clock.Elapsed.TotalMilliseconds;
        return timed && observed <= 14_400_000 ? batch with { ObservedClockMs = observed } : batch;
    }

    public async Task PauseAsync()
    {
        await StopEpochAsync("capture_paused");
        if (failure.Task.IsCompleted)
            throw await failure.Task;
        Store.Transition("paused", "capture.paused", clock.Elapsed.TotalMilliseconds);
    }

    public async Task StopAsync(bool failed = false, string? code = null)
    {
        var propagateFailure = !failed;
        try
        {
            await StopEpochAsync();
        }
        catch (Exception error)
        {
            var failure = error as AudioException ??
                new AudioException("capture_failed", "Capture could not seal cleanly. Inspect the preserved recording.", inner: error);
            Store.Transition("failed", "capture.failed", clock.Elapsed.TotalMilliseconds, code: code ?? failure.Code);
            if (propagateFailure || error is not AudioException || failure.Code != code) throw failure;
            return;
        }
        if (failure.Task.IsCompleted)
        {
            failed = true;
            code ??= (await failure.Task).Code;
        }
        Store.Transition(failed ? "failed" : "sealed", failed ? "capture.failed" : "capture.stopped",
            clock.Elapsed.TotalMilliseconds, code: code);
        if (failure.Task.IsCompleted && propagateFailure)
            throw await failure.Task;
    }

    private async Task StopEpochAsync(string liveReason = "capture_stopped")
    {
        Volatile.Read(ref live)?.Stop(liveReason);
        try { await StopCapturesAsync(captures); }
        finally { captures.Clear(); }
    }

    internal static async Task StopCapturesAsync(IReadOnlyList<CaptureTrack> captures)
    {
        var errors = new List<Exception>();
        var stopping = Task.WhenAll(captures.Select(capture => capture.StopAsync()));
        try
        {
            await stopping;
        }
        catch (Exception error)
        {
            if (stopping.Exception is { } aggregate) errors.AddRange(aggregate.InnerExceptions);
            else errors.Add(error);
        }
        foreach (var capture in captures)
        {
            try { capture.Dispose(); }
            catch (Exception error) { errors.Add(error); }
        }
        if (errors.Count == 1)
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(errors[0]).Throw();
        if (errors.Count > 1)
            throw new AudioException("stop_failed", "Multiple endpoint shutdown operations failed; inspect the preserved recording.",
                inner: new AggregateException(errors));
    }
}
