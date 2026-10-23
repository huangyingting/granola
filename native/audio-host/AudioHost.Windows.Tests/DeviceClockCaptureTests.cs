using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioTests;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class DeviceClockCaptureTests
{
    private sealed record Input(int Frames = 800, long Position = 0, long Qpc = 31_250_000,
        AudioClientBufferFlags Flags = 0);

    private sealed class Reader(params Input[] input) : IDevicePacketReader
    {
        private readonly Queue<Input> packets = new(input);
        private IntPtr pointer;
        private int heldFrames;
        public WaveFormat WaveFormat { get; } = new(16_000, 16, 1);
        public readonly ConcurrentQueue<(string Operation, int Thread)> Calls = new();
        public int Releases { get; private set; }
        public int Disposals { get; private set; }
        public bool Started { get; private set; }
        public bool FailStart { get; init; }
        public bool FailStop { get; init; }
        public bool FailRelease { get; init; }
        public bool FailDispose { get; init; }
        public bool HasLease => pointer != IntPtr.Zero;
        private void Call(string operation) => Calls.Enqueue((operation, Environment.CurrentManagedThreadId));
        public void Start()
        {
            Call("start");
            if (FailStart) throw new IOException("Synthetic start failure.");
            Started = true;
        }
        public void Stop()
        {
            Call("stop");
            Started = false;
            if (FailStop) throw new IOException("Synthetic stop failure.");
        }
        public int GetNextPacketSize()
        {
            Call("next");
            return packets.TryPeek(out var next) ? Math.Max(1, next.Frames) : 0;
        }
        public DevicePacket GetBuffer()
        {
            Call("get");
            Assert.False(HasLease);
            var item = packets.Dequeue();
            if (item.Frames == 0)
                return new DevicePacket(new IntPtr(1), 0, (AudioClientBufferFlags)int.MaxValue, -1, -1);
            heldFrames = Math.Max(0, item.Frames);
            pointer = Marshal.AllocHGlobal(1600);
            Marshal.Copy(Enumerable.Repeat((byte)0x31, 1600).ToArray(), 0, pointer, 1600);
            return new DevicePacket(item.Flags.HasFlag(AudioClientBufferFlags.Silent) ? IntPtr.Zero : pointer,
                item.Frames, item.Flags, item.Position, item.Qpc);
        }
        public void ReleaseBuffer(int frames)
        {
            Call("release");
            Assert.True(HasLease);
            Assert.Equal(heldFrames, frames);
            Marshal.FreeHGlobal(pointer);
            pointer = IntPtr.Zero;
            Releases++;
            if (FailRelease) throw new IOException("Synthetic release failure.");
        }
        public void Dispose()
        {
            Call("dispose");
            if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
            pointer = IntPtr.Zero;
            Disposals++;
            if (FailDispose) throw new IOException("Synthetic disposal failure.");
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CopiesActualFramesAndReleasesNativeLeaseBeforeCallbackOnOneDedicatedThread(bool silent)
    {
        var reader = new Reader(new Input(Flags: silent ? AudioClientBufferFlags.Silent : AudioClientBufferFlags.DataDiscontinuity));
        using var source = Source(reader);
        var stopped = ObserveStop(source);
        byte[]? borrowed = null;
        source.DataAvailable += (_, args) =>
        {
            Assert.False(reader.HasLease);
            Assert.Equal(1, reader.Releases);
            var packet = Assert.IsType<DeviceClockPacketArgs>(args);
            Assert.Equal(new CaptureClockRange(125, 175), packet.Clock);
            Assert.Equal(1600, args.BytesRecorded);
            Assert.All(args.Buffer, value => Assert.Equal(silent ? 0 : 0x31, value));
            borrowed = args.Buffer;
            source.StopRecording();
        };
        source.StartRecording();
        Assert.Null(await stopped.WaitAsync(TimeSpan.FromSeconds(5)));
        source.Dispose();
        Assert.NotNull(borrowed);
        Assert.All(borrowed, value => Assert.Equal(0, value));
        Assert.Equal(1, reader.Disposals);
        Assert.All(reader.Calls, call => Assert.Equal(reader.Calls.First().Thread, call.Thread));
        Assert.NotEqual(Environment.CurrentManagedThreadId, reader.Calls.First().Thread);
    }

    [Fact]
    public async Task EmptyBuffersIgnoreUnwrittenOutputsAndDoNotReleaseOrAdvanceTheClock()
    {
        var reader = new Reader(new Input(Frames: 0), new Input());
        using var source = Source(reader);
        var stopped = ObserveStop(source);
        var count = 0;
        source.DataAvailable += (_, args) =>
        {
            count++;
            Assert.Equal(125, Assert.IsType<DeviceClockPacketArgs>(args).Clock.StartMs);
            source.StopRecording();
        };
        source.StartRecording();
        Assert.Null(await stopped.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(1, count);
        Assert.Equal(1, reader.Releases);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CallbackFailureClearsUnclaimedBytesButNotExplicitlyTransferredOwnership(bool transfer)
    {
        var reader = new Reader(new Input());
        using var source = Source(reader);
        var stopped = ObserveStop(source);
        byte[]? observed = null;
        source.DataAvailable += (_, args) =>
        {
            var packet = Assert.IsType<DeviceClockPacketArgs>(args);
            observed = transfer ? packet.TakeBytes() : packet.Buffer;
            if (transfer) Assert.Throws<InvalidOperationException>(() => packet.TakeBytes());
            throw new IOException("Synthetic callback failure.");
        };
        source.StartRecording();
        Assert.IsType<IOException>(await stopped.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.NotNull(observed);
        Assert.All(observed, value => Assert.Equal(transfer ? 0x31 : 0, value));
        CryptographicOperations.ZeroMemory(observed);
        Assert.Equal(1, reader.Releases);
        Assert.Equal(1, reader.Disposals);
    }

    [Theory]
    [InlineData(-1, 0, 31_250_000, 0, "capture_overrun")]
    [InlineData(524_289, 0, 31_250_000, 0, "capture_overrun")]
    [InlineData(800, 0, 31_250_000, 8, "capture_overrun")]
    [InlineData(800, 0, 31_250_000, 4, "capture_clock_invalid")]
    [InlineData(800, -1, 31_250_000, 0, "capture_clock_invalid")]
    [InlineData(800, 0, 29_999_999, 0, "capture_clock_invalid")]
    [InlineData(800, 0, 50_000_000, 0, "capture_clock_invalid")]
    public async Task InvalidPacketsReleaseWithoutPublishingOrRestarting(int frames, long position, long qpc, int flags, string code)
    {
        var reader = new Reader(new Input(frames, position, qpc, (AudioClientBufferFlags)flags));
        using var source = Source(reader);
        var stopped = ObserveStop(source);
        var callbacks = 0;
        source.DataAvailable += (_, _) => callbacks++;
        source.StartRecording();
        var error = Assert.IsType<AudioException>(await stopped.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(code, error.Code);
        Assert.Equal(0, callbacks);
        Assert.Equal(1, reader.Releases);
        Assert.Equal(1, reader.Calls.Count(call => call.Operation == "start"));
    }

    [Fact]
    public async Task MidStreamGlitchPreservesTheGoodPacketAndDoesNotInventReplacementSilence()
    {
        var reader = new Reader(new Input(), new Input(Position: 800, Qpc: 31_750_000,
            Flags: AudioClientBufferFlags.DataDiscontinuity));
        using var source = Source(reader);
        var stopped = ObserveStop(source);
        var callbacks = 0;
        source.DataAvailable += (_, _) => callbacks++;
        source.StartRecording();
        Assert.Equal("capture_discontinuity",
            Assert.IsType<AudioException>(await stopped.WaitAsync(TimeSpan.FromSeconds(5))).Code);
        Assert.Equal(1, callbacks);
        Assert.Equal(2, reader.Releases);
        Assert.Equal(1, reader.Disposals);
    }

    [Theory]
    [InlineData(32_250_000)]
    [InlineData(31_500_000)]
    [InlineData(601_000_000)]
    public async Task UnflaggedTimestampGapsAndOverlapReleaseTheLeaseWithoutPublishingUnaccountedMedia(long qpc)
    {
        var reader = new Reader(new Input(), new Input(Position: 800, Qpc: qpc));
        var observations = 0;
        using var source = Source(reader, () =>
        {
            Assert.True(reader.HasLease);
            observations++;
            return 4_000_000;
        });
        var stopped = ObserveStop(source);
        var callbacks = 0;
        source.DataAvailable += (_, _) => callbacks++;
        source.StartRecording();
        Assert.Equal("capture_discontinuity",
            Assert.IsType<AudioException>(await stopped.WaitAsync(TimeSpan.FromSeconds(5))).Code);
        Assert.Equal(1, callbacks);
        Assert.Equal(2, observations);
        Assert.Equal(2, reader.Releases);
        Assert.Equal(1, reader.Disposals);
        Assert.All(reader.Calls, call => Assert.Equal(reader.Calls.First().Thread, call.Thread));
    }

    [Fact]
    public async Task EachNonemptyPacketRequiresANewObservationOnTheLeaseThread()
    {
        var reader = new Reader(new Input(), new Input(Position: 800, Qpc: 31_750_000));
        var observations = 0;
        using var source = Source(reader, () =>
        {
            Assert.True(reader.HasLease);
            return ++observations == 1 ? 4_000_000 : 3_999_999;
        });
        var stopped = ObserveStop(source);
        var callbacks = 0;
        source.DataAvailable += (_, _) => callbacks++;
        source.StartRecording();
        Assert.Equal("capture_clock_invalid",
            Assert.IsType<AudioException>(await stopped.WaitAsync(TimeSpan.FromSeconds(5))).Code);
        Assert.Equal(2, observations);
        Assert.Equal(1, callbacks);
        Assert.Equal(2, reader.Releases);
    }

    [Theory]
    [InlineData(64)]
    [InlineData(65)]
    public async Task StopTailDrainIsBoundedAndNeverDropsAnExcessPacketAsSuccessfulCapture(int packetCount)
    {
        var reader = new Reader(Enumerable.Range(0, packetCount)
            .Select(index => new Input(Position: index * 800, Qpc: 31_250_000 + index * 500_000)).ToArray());
        using var source = Source(reader, () => 7_000_000);
        var stopped = ObserveStop(source);
        var buffers = new List<byte[]>();
        source.DataAvailable += (_, args) =>
        {
            buffers.Add(args.Buffer);
            source.StopRecording();
        };
        source.StartRecording();
        var error = await stopped.WaitAsync(TimeSpan.FromSeconds(5));
        if (packetCount == 64) Assert.Null(error);
        else Assert.Equal("capture_overrun", Assert.IsType<AudioException>(error).Code);
        Assert.Equal(64, buffers.Count);
        Assert.Equal(64, reader.Releases);
        Assert.Equal(1, reader.Disposals);
        foreach (var bytes in buffers) Assert.Equal(-1, bytes.AsSpan().IndexOfAnyExcept((byte)0));
        Assert.Equal(1, reader.Calls.Count(call => call.Operation == "start"));
        Assert.Equal(1, reader.Calls.Count(call => call.Operation == "stop"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InvalidClockConstructionDisposesTheReaderAndSurfacesAnyCleanupFailure(bool failDispose)
    {
        var reader = new Reader { FailDispose = failDispose };
        if (failDispose)
            Assert.Throws<IOException>(() => new DeviceClockCapture(reader, -1, 1_000_000, () => 4_000_000));
        else
            Assert.Throws<ArgumentOutOfRangeException>(() => new DeviceClockCapture(reader, -1, 1_000_000, () => 4_000_000));
        Assert.Equal(1, reader.Disposals);
        Assert.DoesNotContain(reader.Calls, call => call.Operation == "start");
    }

    [Theory]
    [InlineData("start")]
    [InlineData("stop")]
    [InlineData("release")]
    public async Task NativeLifecycleErrorsAreExplicitAndDisposeWithoutAutomaticRetry(string phase)
    {
        var reader = new Reader(new Input())
        {
            FailStart = phase == "start",
            FailStop = phase == "stop",
            FailRelease = phase == "release"
        };
        using var source = Source(reader);
        var stopped = ObserveStop(source);
        var callbacks = 0;
        source.DataAvailable += (_, _) => { callbacks++; source.StopRecording(); };
        source.StartRecording();
        Assert.IsType<IOException>(await stopped.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(phase == "stop" ? 1 : 0, callbacks);
        Assert.Equal(1, reader.Disposals);
        Assert.Equal(1, reader.Calls.Count(call => call.Operation == "start"));
        Assert.Equal(phase == "start" ? 0 : 1, reader.Calls.Count(call => call.Operation == "stop"));
    }

    [Fact]
    public void NeverStartedSourceCanBeDisposedWithoutStartingOrLeakingTheReader()
    {
        var reader = new Reader();
        var source = Source(reader);
        source.Dispose();
        source.Dispose();
        source.StopRecording();
        Assert.Equal(1, reader.Disposals);
        Assert.Throws<ObjectDisposedException>(source.StartRecording);
        Assert.DoesNotContain(reader.Calls, call => call.Operation == "start");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualCaptureConsumerPreservesMappedClocksAndClearsTransferredPcmOnSuccessOrFailure(bool failConsumer)
    {
        var root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-device-clock", Guid.NewGuid().ToString("D"));
        var protector = new TestKeyProtector();
        try
        {
            var id = Guid.NewGuid();
            var track = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic");
            var epoch = Guid.NewGuid();
            var store = new RecordingStore(root, id, [track], protector);
            store.Transition("recording", "capture.started", 0, epoch, "wasapi_qpc_v1");
            var writer = new PcmChunkWriter(store, track.TrackId);
            writer.BeginEpoch(epoch);
            using var preview = new PcmLiveBuffer(id, epoch, [track.TrackId]);
            var reader = new Reader(new Input());
            var source = Source(reader);
            byte[]? transferred = null;
            source.DataAvailable += (_, args) => transferred = args.Buffer;
            var failure = new TaskCompletionSource<AudioException>(TaskCreationOptions.RunContinuationsAsynchronously);
            var processed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var endpoint = new MemoryStream();
            using var capture = new CaptureTrack(endpoint, source, track.TrackId, writer, new CaptureClock(), failure,
                (start, bytes, startMs, endMs) =>
                {
                    Assert.Equal(0, start);
                    Assert.Equal(125, startMs);
                    Assert.Equal(175, endMs);
                    Assert.All(bytes.ToArray(), value => Assert.Equal(0x31, value));
                    processed.TrySetResult();
                    if (failConsumer) throw new IOException("Synthetic live consumer failure.");
                    preview.Append(track.TrackId, epoch, start, bytes, startMs, endMs);
                });
            capture.Start();
            await processed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (failConsumer)
            {
                Assert.Equal("capture_failed",
                    (await failure.Task.WaitAsync(TimeSpan.FromSeconds(5))).Code);
                Assert.Equal("capture_failed", (await Assert.ThrowsAsync<AudioException>(capture.StopAsync)).Code);
            }
            else
            {
                await capture.StopAsync();
                Assert.False(failure.Task.IsCompleted);
                var live = Assert.Single(preview.Read(200).Frames);
                Assert.Equal(125, live.ClockStartMs);
                Assert.Equal(175, live.ClockEndMs);
                var path = Assert.Single(Directory.GetFiles(store.DirectoryPath, "*.chunk"));
                var (header, pcm) = EncryptedFile.Read(path, id, "audio_chunk", protector);
                Assert.Equal(800, header.Chunk!.SampleCount);
                Assert.Equal(125, header.Chunk.ClockStartMs);
                Assert.Equal(175, header.Chunk.ClockEndMs);
                Assert.All(pcm, value => Assert.Equal(0x31, value));
                CryptographicOperations.ZeroMemory(pcm);
                Assert.Equal("wasapi_qpc_v1", Assert.Single(store.Snapshot().Events).Code);
            }
            Assert.NotNull(transferred);
            Assert.All(transferred, value => Assert.Equal(0, value));
            Assert.Equal(1, reader.Releases);
            Assert.Equal(1, reader.Disposals);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private static Task<Exception?> ObserveStop(DeviceClockCapture source)
    {
        var stopped = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
        source.RecordingStopped += (_, args) => stopped.TrySetResult(args.Exception);
        return stopped.Task;
    }

    [Fact]
    public async Task ActualEncryptedArchiveAndLiveFramesPreserveOnlyTheGoodPrefixAfterAnUnflaggedGap()
    {
        var root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-device-clock", Guid.NewGuid().ToString("D"));
        var protector = new TestKeyProtector();
        try
        {
            var id = Guid.NewGuid();
            var spec = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic");
            var epoch = Guid.NewGuid();
            var store = new RecordingStore(root, id, [spec], protector);
            store.Transition("recording", "capture.started", 0, epoch, "wasapi_qpc_v1");
            var writer = new PcmChunkWriter(store, spec.TrackId);
            writer.BeginEpoch(epoch);
            using var preview = new PcmLiveBuffer(id, epoch, [spec.TrackId]);
            var reader = new Reader(new Input(), new Input(Position: 800, Qpc: 32_250_000));
            var source = Source(reader);
            byte[]? transferred = null;
            source.DataAvailable += (_, args) => transferred = args.Buffer;
            var failure = new TaskCompletionSource<AudioException>(TaskCreationOptions.RunContinuationsAsynchronously);
            using var endpoint = new MemoryStream();
            using var capture = new CaptureTrack(endpoint, source, spec.TrackId, writer, new CaptureClock(), failure,
                (start, bytes, startMs, endMs) => preview.Append(spec.TrackId, epoch, start, bytes, startMs, endMs));
            capture.Start();
            var error = await failure.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("capture_discontinuity", error.Code);
            await capture.StopAsync();
            store.Transition("failed", "capture.failed", 300, code: error.Code);
            var frame = Assert.Single(preview.Read(300).Frames);
            Assert.Equal(800, frame.SampleCount);
            Assert.Equal(125, frame.ClockStartMs);
            Assert.Equal(175, frame.ClockEndMs);
            var path = Assert.Single(Directory.GetFiles(store.DirectoryPath, "*.chunk"));
            var (header, pcm) = EncryptedFile.Read(path, id, "audio_chunk", protector);
            Assert.Equal(800, header.Chunk!.SampleCount);
            Assert.Equal(125, header.Chunk.ClockStartMs);
            Assert.Equal(175, header.Chunk.ClockEndMs);
            Assert.All(pcm, value => Assert.Equal(0x31, value));
            CryptographicOperations.ZeroMemory(pcm);
            var manifest = new RecordingArchive(root, protector).Describe(id);
            Assert.Equal("failed", manifest.State);
            Assert.Equal(800, Assert.Single(manifest.Tracks).SavedSamples);
            Assert.Equal("capture_discontinuity", manifest.Events.Last().Code);
            var report = RecordingStore.Inspect(root, id, protector);
            Assert.Equal(1, report.VerifiedChunks);
            Assert.Equal(800, report.TotalSamples);
            Assert.NotEqual("sealed", report.State);
            Assert.NotNull(transferred);
            Assert.Equal(-1, transferred.AsSpan().IndexOfAnyExcept((byte)0));
            Assert.Equal(2, reader.Releases);
            Assert.Equal(1, reader.Disposals);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DualTrackShutdownDisposesBothEndpointsDespiteProcessingOrDisposalFailure(bool failConsumers)
    {
        var root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-device-clock", Guid.NewGuid().ToString("D"));
        var endpoints = new[] { new Endpoint(!failConsumers), new Endpoint(false) };
        var captures = new List<CaptureTrack>();
        try
        {
            var id = Guid.NewGuid();
            var specs = new[]
            {
                new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic-microphone"),
                new TrackSpec(Guid.NewGuid(), "loopback", "endpoint", "explicit", "synthetic-loopback")
            };
            var store = new RecordingStore(root, id, specs, new TestKeyProtector());
            var processed = new[]
            {
                new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously),
                new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)
            };
            var readers = new[] { new Reader(new Input()), new Reader(new Input()) };
            for (var index = 0; index < 2; index++)
            {
                var selected = index;
                var writer = new PcmChunkWriter(store, specs[index].TrackId);
                writer.BeginEpoch(Guid.NewGuid());
                var source = Source(readers[index]);
                var failure = new TaskCompletionSource<AudioException>(TaskCreationOptions.RunContinuationsAsynchronously);
                captures.Add(new CaptureTrack(endpoints[index], source, specs[index].TrackId, writer, new CaptureClock(), failure,
                    (_, _, _, _) =>
                    {
                        processed[selected].TrySetResult();
                        if (failConsumers) throw new IOException("Synthetic dual-track processing failure.");
                    }));
            }
            foreach (var capture in captures) capture.Start();
            await Task.WhenAll(processed.Select(item => item.Task)).WaitAsync(TimeSpan.FromSeconds(5));
            var error = await Assert.ThrowsAsync<AudioException>(() => CaptureSession.StopCapturesAsync(captures));
            Assert.Equal("stop_failed", error.Code);
            if (failConsumers) Assert.Equal(2, Assert.IsType<AggregateException>(error.InnerException).InnerExceptions.Count);
            Assert.All(endpoints, endpoint => Assert.True(endpoint.Disposed));
            Assert.All(readers, reader => Assert.Equal(1, reader.Disposals));
            Assert.All(readers, reader => Assert.Equal(1, reader.Calls.Count(call => call.Operation == "stop")));
        }
        finally
        {
            var cleanupErrors = new List<Exception>();
            try
            {
                foreach (var capture in captures)
                {
                    try { capture.Dispose(); }
                    catch (Exception error) { cleanupErrors.Add(error); }
                }
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
            if (cleanupErrors.Count > 0) throw new AggregateException(cleanupErrors);
        }
    }

    private sealed class Endpoint(bool fail) : IDisposable
    {
        public bool Disposed { get; private set; }
        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            if (fail) throw new AudioException("stop_failed", "Synthetic endpoint disposal failure.");
        }
    }

    private static DeviceClockCapture Source(Reader reader, Func<long>? observe = null) =>
        new(reader, 3_000_000, 1_000_000, observe ?? (() => 4_000_000));
}
