using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateParentHandoffTests
{
    [Fact]
    public async Task RequiresAFreshCommitAcknowledgesItAndWaitsForTheRetainedProcessToExit()
    {
        await using var fixture = await Fixture.OpenAsync();
        var ready = await fixture.StartAsync();
        Assert.Equal(fixture.Parent.Identity, ready.Parent);
        Assert.Equal("update_parent_ready", ready.Event);
        Assert.Matches("^[0-9a-f]{64}$", ready.Challenge);
        Assert.False(fixture.Pending!.IsCompleted);
        await fixture.DecideAsync(new UpdateHandoffDecision(1, "commit", ready.Challenge));
        var committed = await fixture.ReadAsync<UpdateParentCommitted>();
        Assert.Equal(new UpdateParentCommitted(1, "update_parent_committed", ready.Parent), committed);
        Assert.False(fixture.Pending.IsCompleted);
        Assert.False(fixture.Process.HasExited);
        await fixture.ExitParentAsync();
        await fixture.Pending;
        Assert.True(fixture.Parent.HasExited);
        Assert.False(fixture.Parent.IsDisposed);
    }

    [Theory]
    [InlineData("cancel", "update_handoff_cancelled")]
    [InlineData("stale", "update_handoff_challenge")]
    [InlineData("extra", "update_handoff_protocol")]
    [InlineData("closed", "update_handoff_closed")]
    public async Task RejectsUncommittedAndMalformedSessionsWithoutTerminatingTheParent(string scenario, string code)
    {
        await using var fixture = await Fixture.OpenAsync();
        var ready = await fixture.StartAsync();
        if (scenario == "closed") await fixture.Main.DisposeAsync();
        else if (scenario == "extra")
            await fixture.DecideAsync(new { version = 1, operation = "commit", challenge = ready.Challenge, installer = "other.exe" });
        else
            await fixture.DecideAsync(new UpdateHandoffDecision(1, scenario == "cancel" ? "cancel" : "commit",
                scenario == "stale" ? new UpdateHandoffChallenge().Value : ready.Challenge));
        Assert.Equal(code, (await Assert.ThrowsAsync<UpdateHandoffException>(() => fixture.Pending!)).Code);
        Assert.False(fixture.Process.HasExited);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BoundsBothTheDecisionAndThePostCommitExitWaitWithoutKillingTheParent(bool commit)
    {
        await using var fixture = await Fixture.OpenAsync();
        var ready = await fixture.StartAsync(commit ? TimeSpan.FromSeconds(10) : TimeSpan.FromMilliseconds(500),
            TimeSpan.FromMilliseconds(500));
        if (commit)
        {
            await fixture.DecideAsync(new UpdateHandoffDecision(1, "commit", ready.Challenge));
            await fixture.ReadAsync<UpdateParentCommitted>();
        }
        Assert.Equal("update_handoff_timeout",
            (await Assert.ThrowsAsync<UpdateHandoffException>(() => fixture.Pending!)).Code);
        Assert.False(fixture.Process.HasExited);
    }

    [Fact]
    public async Task DoesNotAcceptACommitAfterTheObservedParentHasExited()
    {
        await using var fixture = await Fixture.OpenAsync();
        var ready = await fixture.StartAsync();
        await fixture.ExitParentAsync();
        await fixture.DecideAsync(new UpdateHandoffDecision(1, "commit", ready.Challenge));
        Assert.Equal("update_parent_missing",
            (await Assert.ThrowsAsync<UpdateHandoffException>(() => fixture.Pending!)).Code);
    }

    [Fact]
    public async Task PropagatesCallerCancellationAndCancelsThePendingPipeRead()
    {
        await using var fixture = await Fixture.OpenAsync();
        await fixture.StartAsync();
        fixture.Deadline.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Pending!);
        Assert.False(fixture.Process.HasExited);
    }

    [Fact]
    public async Task DoesNotHangWhenTheBorrowedInputIgnoresCancellation()
    {
        await using var fixture = await Fixture.OpenAsync();
        using var input = new UncooperativeInput();
        await fixture.StartAsync(TimeSpan.FromMilliseconds(500), input: input);
        Assert.Equal("update_handoff_timeout",
            (await Assert.ThrowsAsync<UpdateHandoffException>(() => fixture.Pending!)).Code);
        Assert.False(fixture.Process.HasExited);
    }

    internal sealed class Fixture(NamedPipeServerStream worker, NamedPipeClientStream main) : IAsyncDisposable
    {
        internal readonly CancellationTokenSource Deadline = new(TimeSpan.FromSeconds(30));
        private UpdateParentLease? parent;
        private Process? process;
        internal NamedPipeClientStream Main => main;
        internal Stream Worker => worker;
        internal UpdateParentLease Parent => parent ?? throw new InvalidOperationException("No fixture lease was opened.");
        internal Process Process => process ?? throw new InvalidOperationException("No fixture process was started.");
        internal Task? Pending { get; private set; }
        internal void Track(Task task)
        {
            if (Pending is not null) throw new InvalidOperationException("A fixture session is already running.");
            Pending = task;
        }

        internal static async Task<Fixture> OpenAsync()
        {
            var name = $"notes-update-handoff-{Guid.NewGuid():N}";
            var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            Fixture? fixture = null;
            try
            {
                fixture = new(server, new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous));
                await Task.WhenAll(server.WaitForConnectionAsync(fixture.Deadline.Token),
                    fixture.Main.ConnectAsync(fixture.Deadline.Token));
                fixture.process = UpdateParentTests.StartFixture();
                var result = UpdateParentLease.OpenProcess(fixture.Process.Id, UpdateTrustTests.Reference, out fixture.parent);
                Assert.True(result.Matched, result.Code);
                Assert.NotNull(fixture.parent);
                return fixture;
            }
            catch
            {
                if (fixture is not null) await fixture.DisposeAsync();
                else await server.DisposeAsync();
                throw;
            }
        }

        internal async Task<UpdateParentReady> StartAsync(TimeSpan? prepare = null, TimeSpan? exit = null, Stream? input = null)
        {
            Pending = UpdateParentHandoff.WaitForCommittedExitAsync(Parent, input ?? worker, worker,
                prepare ?? TimeSpan.FromSeconds(10), exit ?? TimeSpan.FromSeconds(10), Deadline.Token);
            return await ReadAsync<UpdateParentReady>();
        }

        internal Task DecideAsync<T>(T decision) => FrameCodec.WriteJsonAsync(main, decision, Deadline.Token);

        internal async Task<T> ReadAsync<T>()
        {
            var bytes = await FrameCodec.ReadAsync(main, UpdateHandoffChallenge.MaximumMessageBytes, Deadline.Token);
            Assert.NotNull(bytes);
            var value = JsonSerializer.Deserialize<T>(bytes, AudioJson.Options);
            Assert.NotNull(value);
            return value;
        }

        internal async Task ExitParentAsync()
        {
            await Process.StandardInput.WriteLineAsync("exit");
            await Process.WaitForExitAsync(Deadline.Token);
        }

        public async ValueTask DisposeAsync()
        {
            Deadline.Cancel();
            try
            {
                await main.DisposeAsync();
                await worker.DisposeAsync();
                if (Pending is not null)
                {
                    try { await Pending; }
                    catch (OperationCanceledException) when (Deadline.IsCancellationRequested) { }
                    catch (UpdateHandoffException) { }
                }
            }
            finally
            {
                parent?.Dispose();
                try
                {
                    if (process is not null)
                    {
                        if (!process.HasExited) process.Kill(entireProcessTree: true);
                        await process.WaitForExitAsync();
                        process.Dispose();
                    }
                }
                finally { Deadline.Dispose(); }
            }
        }
    }

    private sealed class UncooperativeInput : Stream
    {
        private readonly TaskCompletionSource<int> read = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => new(read.Task);
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing) read.TrySetResult(0);
            base.Dispose(disposing);
        }
    }
}
