using System.Diagnostics;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

internal sealed class CaptureSession
{
    private readonly TrackSpec[] specs;
    private readonly Dictionary<Guid, string> endpoints = [];
    private readonly Dictionary<Guid, PcmChunkWriter> writers = [];
    private readonly List<CaptureTrack> captures = [];
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly TaskCompletionSource<AudioException> failure = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Guid captureEpoch;
    public RecordingStore Store { get; }
    public Task<AudioException> Failure => failure.Task;
    public double ElapsedSeconds => clock.Elapsed.TotalSeconds;

    public CaptureSession(string root, Guid recordingId, TrackSpec[] specs, IKeyProtector protector)
    {
        this.specs = specs;
        foreach (var spec in specs)
        {
            using var endpoint = DeviceCatalog.Resolve(spec);
            endpoints.Add(spec.TrackId, endpoint.ID);
        }
        Store = new RecordingStore(root, recordingId, specs, protector, endpoints);
        foreach (var spec in specs)
            writers.Add(spec.TrackId, new PcmChunkWriter(Store, spec.TrackId));
    }

    public void StartEpoch()
    {
        var epoch = Guid.NewGuid();
        captureEpoch = epoch;
        Store.Transition("recording", "capture.started", clock.Elapsed.TotalMilliseconds, epoch);
        foreach (var spec in specs)
        {
            writers[spec.TrackId].BeginEpoch(epoch);
            var endpoint = DeviceCatalog.Resolve(spec, endpoints[spec.TrackId]);
            try
            {
                captures.Add(new CaptureTrack(endpoint, spec.TrackId, spec.Kind, writers[spec.TrackId], clock, failure));
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

    public async Task PauseAsync()
    {
        await StopEpochAsync();
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
            Store.Transition("failed", "capture.failed", clock.Elapsed.TotalMilliseconds, code: "capture_failed");
            throw new AudioException("capture_failed", "Capture could not seal cleanly. Inspect the preserved recording.", inner: error);
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

    private async Task StopEpochAsync()
    {
        try
        {
            await Task.WhenAll(captures.Select(capture => capture.StopAsync()));
        }
        finally
        {
            foreach (var capture in captures) capture.Dispose();
            captures.Clear();
        }
    }
}
