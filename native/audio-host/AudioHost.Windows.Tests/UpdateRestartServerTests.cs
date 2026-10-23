using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

[Collection("Update startup admission")]
public sealed class UpdateRestartServerTests
{
    [Fact]
    public async Task ObservesTheConnectedWindowsServerAndRetainsTheExactLiveCreatorWithoutReopeningItsPid()
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        using var server = UpdateRestartServerLease.OpenPeer(pipe, fixture.Main);
        Assert.Equal(fixture.Server.Id, server.Identity.Pid);
        Assert.Equal(fixture.Server.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture),
            server.Identity.CreationFileTime);
        Assert.True(UpdatePathLock.SameFile(UpdateTrustTests.Reference, server.Executable));
        Assert.True(server.IsCreatorOf(fixture.Main));
        Assert.False(fixture.Main.IsCreatorOf(server));
        Assert.False(server.IsCreatorOf(server));
        var handle = server.ProcessHandle;
        Assert.Same(handle, server.ProcessHandle);
        Assert.Equal(73, await ReadByte(pipe, fixture.Deadline.Token));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => server.WaitForExitAsync(cancelled.Token));
        Assert.False(server.HasExited);
        Assert.False(fixture.Main.HasExited);
        server.Dispose();
        server.Dispose();
        Assert.True(handle.IsClosed);
        Assert.False(fixture.Server.HasExited);
        Assert.False(fixture.Main.HasExited);
        Assert.True(pipe.IsConnected);
        Assert.Throws<ObjectDisposedException>(() => server.IsCreatorOf(fixture.Main));
    }

    [Fact]
    public async Task RejectsAnotherLiveServersChildEvenWithTheSameExecutableAndUser()
    {
        await using var first = await Fixture.StartAsync();
        await using var second = await Fixture.StartAsync();
        using var pipe = await first.ConnectAsync();
        Assert.Equal("update_restart_server_peer", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.OpenPeer(pipe, second.Main)).Code);
        Assert.False(first.Server.HasExited);
        Assert.False(first.Main.HasExited);
        Assert.False(second.Main.HasExited);
        Assert.True(pipe.IsConnected);
    }

    [Fact]
    public async Task RejectsTheServerItselfAsTheClaimedRestartedMain()
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        var result = UpdateParentLease.OpenObservedProcess(fixture.Server.Id, out var self);
        Assert.True(result.Matched, result.Code);
        using (self)
        {
            Assert.NotNull(self);
            Assert.Equal("update_restart_server_peer", Assert.Throws<UpdateHandoffException>(() =>
                UpdateRestartServerLease.OpenPeer(pipe, self)).Code);
        }
        Assert.False(fixture.Server.HasExited);
        Assert.False(fixture.Main.HasExited);
    }

    [Fact]
    public async Task RejectsAPipeCreatedByTheBridgeRatherThanTheActualMainCreator()
    {
        await using var fixture = await Fixture.StartAsync();
        var name = $"notes-wrong-restart-server-{Guid.NewGuid():N}";
        using var intruder = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance);
        using var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        var connected = intruder.WaitForConnectionAsync(fixture.Deadline.Token);
        await pipe.ConnectAsync(fixture.Deadline.Token);
        await connected;
        Assert.Equal("update_restart_server_peer", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.OpenPeer(pipe, fixture.Main)).Code);
        Assert.False(fixture.Main.HasExited);
        Assert.False(fixture.Server.HasExited);
    }

    [Fact]
    public async Task RejectsAnExitedMainWithoutTerminatingItsStillLiveCreator()
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        await fixture.StopMainAsync();
        Assert.Equal("update_restart_server_peer", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.OpenPeer(pipe, fixture.Main)).Code);
        Assert.False(fixture.Server.HasExited);
    }

    [Fact]
    public async Task RetainedServerExitInvalidatesCreatorProofWithoutKillingOrReopeningMain()
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        using var server = UpdateRestartServerLease.OpenPeer(pipe, fixture.Main);
        var exited = server.WaitForExitAsync(fixture.Deadline.Token);
        Assert.False(exited.IsCompleted);
        await fixture.StopServerAsync();
        await exited;
        Assert.True(server.HasExited);
        Assert.False(server.IsCreatorOf(fixture.Main));
        Assert.False(fixture.Main.HasExited);
        var error = Assert.Throws<UpdateHandoffException>(() => UpdateRestartServerLease.OpenPeer(pipe, fixture.Main));
        Assert.Contains(error.Code, new[] { "update_restart_server_unavailable", "update_restart_server_pipe" });
        Assert.False(fixture.Main.HasExited);
    }

    [Theory]
    [InlineData("unconnected")]
    [InlineData("disposed-pipe")]
    [InlineData("disposed-main")]
    [InlineData("disconnected")]
    public async Task RejectsMissingOrClosedTransportAndDisposedIdentityWithoutStoppingEitherProcess(string mode)
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = mode == "unconnected"
            ? new NamedPipeClientStream(".", fixture.Endpoint, PipeDirection.InOut, PipeOptions.Asynchronous)
            : await fixture.ConnectAsync();
        if (mode == "disposed-pipe") pipe.Dispose();
        if (mode == "disposed-main") fixture.Main.Dispose();
        if (mode == "disconnected")
        {
            Assert.Equal(73, await ReadByte(pipe, fixture.Deadline.Token));
            File.WriteAllText(Path.Combine(fixture.Root, "disconnect"), "close");
            await fixture.WaitForFile(Path.Combine(fixture.Root, "disconnected"));
            Assert.Equal(-1, await ReadByte(pipe, fixture.Deadline.Token));
        }
        var error = Assert.Throws<UpdateHandoffException>(() => UpdateRestartServerLease.OpenPeer(pipe, fixture.Main));
        Assert.Contains(error.Code, new[] { "update_restart_server_pipe", "update_restart_server_unavailable" });
        Assert.False(fixture.Server.HasExited);
        Assert.False(fixture.Child.HasExited);
    }

    [Fact]
    public async Task ARealTrustedMicrosoftCreatorIsNotAFirstPartyWorkerAndCannotGainProductionAuthorization()
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        var policy = new UpdateWorkerPolicy(1, "https://updates.example.test/feed.json", new('a', 64),
            "Synthetic publisher", "Windows AI Notes");
        Assert.Equal("update_restart_server_identity", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.Open(pipe, fixture.Main, Guid.NewGuid(), "0.1.1", policy)).Code);
        Assert.False(fixture.Main.IsDisposed);
        Assert.False(fixture.Main.HasExited);
        Assert.False(fixture.Server.HasExited);
        Assert.True(pipe.IsConnected);
        Assert.Equal(73, await ReadByte(pipe, fixture.Deadline.Token));
    }

    [Theory]
    [InlineData("bad")]
    [InlineData("0.1.1-preview")]
    [InlineData("65536.1.1")]
    public async Task InvalidTargetVersionsCannotConsumeThePipeOrMainLease(string version)
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        Assert.Equal("update_restart_server_arguments", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.Open(pipe, fixture.Main, Guid.NewGuid(), version,
                new(1, "https://updates.example.test/feed.json", new('a', 64), "Synthetic publisher", "Windows AI Notes"))).Code);
        Assert.False(fixture.Main.IsDisposed);
        Assert.True(pipe.IsConnected);
        Assert.False(fixture.Main.HasExited);
    }

    [Fact]
    public async Task NonVersionFourSessionsCannotConsumeThePipeOrMainLease()
    {
        await using var fixture = await Fixture.StartAsync();
        using var pipe = await fixture.ConnectAsync();
        Assert.Equal("update_restart_server_arguments", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.Open(pipe, fixture.Main, Guid.Empty, "0.1.1",
                new(1, "https://updates.example.test/feed.json", new('a', 64), "Synthetic publisher", "Windows AI Notes"))).Code);
        Assert.False(fixture.Main.IsDisposed);
        Assert.True(pipe.IsConnected);
    }

    [Theory]
    [InlineData("state-session")]
    [InlineData("staged")]
    [InlineData("claimed")]
    [InlineData("committed")]
    [InlineData("missing-outcome")]
    [InlineData("outcome-session")]
    [InlineData("preparing")]
    [InlineData("prepared")]
    [InlineData("installing")]
    [InlineData("failed")]
    [InlineData("not-started")]
    [InlineData("nonzero-exit")]
    [InlineData("missing-exit")]
    [InlineData("missing-installer")]
    [InlineData("offered-version")]
    [InlineData("current-version")]
    [InlineData("no-upgrade")]
    [InlineData("downgrade")]
    public void RejectsInconsistentSavedContextWithoutTreatingItAsLiveAuthority(string mode)
    {
        var session = Guid.NewGuid();
        var state = State(session);
        UpdateWorkerOutcome? outcome = Outcome(session);
        switch (mode)
        {
            case "state-session": state = state with { SessionId = Guid.NewGuid().ToString("D") }; break;
            case "staged" or "claimed" or "committed": state = state with { Phase = mode }; break;
            case "missing-outcome": outcome = null; break;
            case "outcome-session": outcome = outcome with { SessionId = Guid.NewGuid().ToString("D") }; break;
            case "preparing" or "prepared" or "installing" or "failed": outcome = outcome with { Phase = mode }; break;
            case "not-started": outcome = outcome with { InstallerStarted = false }; break;
            case "nonzero-exit": outcome = outcome with { InstallerExitCode = 1 }; break;
            case "missing-exit": outcome = outcome with { InstallerExitCode = null }; break;
            case "missing-installer": outcome = outcome with { InstallerProcess = null }; break;
            case "offered-version": outcome = outcome with { OfferedVersion = "0.1.2" }; break;
            case "current-version": outcome = outcome with { CurrentVersion = "bad" }; break;
            case "no-upgrade": outcome = outcome with { CurrentVersion = "0.1.1" }; break;
            case "downgrade": outcome = outcome with { CurrentVersion = "0.1.2" }; break;
        }
        Assert.Equal("update_restart_server_context", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRestartServerLease.RequireContext(state, outcome, session, "0.1.1")).Code);
    }

    [Fact]
    public void ValidInstalledMetadataOnlySuppliesConsistencyAndDoesNotClearTheInstallingFence()
    {
        var session = Guid.NewGuid();
        var state = State(session);
        var outcome = Outcome(session);
        Assert.Same(outcome, UpdateRestartServerLease.RequireContext(state, outcome, session, "0.1.1"));
        Assert.Equal("installing", state.Phase);
        Assert.Equal("installed", outcome.Phase);
    }

    private static UpdateRuntimeState State(Guid session) => new(1, session.ToString("D"), new('a', 64), "installing",
        DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));

    private static UpdateWorkerOutcome Outcome(Guid session) => new(1, session.ToString("D"), "0.1.0", "0.1.1",
        "installed", "update_worker_installed", true, 0, new(1, "1"), DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));

    private static async Task<int> ReadByte(Stream pipe, CancellationToken token)
    {
        var data = new byte[1];
        return await pipe.ReadAsync(data, token) == 0 ? -1 : data[0];
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private UpdateParentLease? main;
        private Process? child;
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), $"notes-restart-server-{Guid.NewGuid():N}");
        internal string Endpoint { get; } = $"notes-restart-server-{Guid.NewGuid():N}";
        internal CancellationTokenSource Deadline { get; } = new(TimeSpan.FromSeconds(30));
        internal Process Server { get; }
        internal Process Child => child ?? throw new InvalidOperationException("The child fixture is not ready.");
        internal UpdateParentLease Main => main ?? throw new InvalidOperationException("The Main fixture is not ready.");

        private Fixture()
        {
            Directory.CreateDirectory(Root);
            var childPath = Path.Combine(Root, "child.ps1");
            File.WriteAllText(childPath, $$"""
                $ErrorActionPreference='Stop'
                [IO.File]::WriteAllText('{{Literal(Path.Combine(Root, "child-ready"))}}.tmp',$PID.ToString())
                [IO.File]::Move('{{Literal(Path.Combine(Root, "child-ready"))}}.tmp','{{Literal(Path.Combine(Root, "child-ready"))}}')
                while(![IO.File]::Exists('{{Literal(Path.Combine(Root, "child-finish"))}}')){Start-Sleep -Milliseconds 10}
                """);
            var serverPath = Path.Combine(Root, "server.ps1");
            File.WriteAllText(serverPath, $$"""
                $ErrorActionPreference='Stop'
                $p=[IO.Pipes.NamedPipeServerStream]::new('{{Endpoint}}',[IO.Pipes.PipeDirection]::InOut,1,
                    [IO.Pipes.PipeTransmissionMode]::Byte,
                    [IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::CurrentUserOnly)
                try {
                  $start=[Diagnostics.ProcessStartInfo]::new('{{Literal(UpdateTrustTests.Reference)}}')
                  $start.UseShellExecute=$false
                  $start.CreateNoWindow=$true
                  foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{{Literal(childPath)}}')){
                    $start.ArgumentList.Add($arg)
                  }
                  $child=[Diagnostics.Process]::Start($start)
                  try {
                    $connected=$p.WaitForConnectionAsync()
                    $finish='{{Literal(Path.Combine(Root, "server-finish"))}}'
                    while(!$connected.IsCompleted -and ![IO.File]::Exists($finish)){Start-Sleep -Milliseconds 10}
                    if($connected.IsCompleted){
                      $connected.GetAwaiter().GetResult()
                      $p.WriteByte(73)
                      $p.Flush()
                      [IO.File]::WriteAllText('{{Literal(Path.Combine(Root, "connected"))}}','connected')
                      $closed=$false
                      while(![IO.File]::Exists($finish)){
                        if(!$closed -and [IO.File]::Exists('{{Literal(Path.Combine(Root, "disconnect"))}}')){
                          $p.Dispose()
                          $closed=$true
                          [IO.File]::WriteAllText('{{Literal(Path.Combine(Root, "disconnected"))}}','closed')
                        }
                        Start-Sleep -Milliseconds 10
                      }
                    }
                  }
                  finally {
                    if([IO.File]::Exists('{{Literal(Path.Combine(Root, "child-finish"))}}')){
                      if(!$child.WaitForExit(10000)){throw 'The child fixture did not exit.'}
                    }
                    $child.Dispose()
                  }
                }
                finally {$p.Dispose()}
                """);
            var start = new ProcessStartInfo(UpdateTrustTests.Reference) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", serverPath })
                start.ArgumentList.Add(argument);
            Server = Process.Start(start) ?? throw new InvalidOperationException("The server fixture did not start.");
        }

        internal static async Task<Fixture> StartAsync()
        {
            var fixture = new Fixture();
            try
            {
                var ready = Path.Combine(fixture.Root, "child-ready");
                await fixture.WaitForFile(ready);
                fixture.child = Process.GetProcessById(int.Parse(File.ReadAllText(ready), CultureInfo.InvariantCulture));
                var result = UpdateParentLease.OpenProcess(fixture.child.Id, UpdateTrustTests.Reference, out fixture.main);
                Assert.True(result.Matched, result.Code);
                Assert.NotNull(fixture.main);
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }

        internal async Task<NamedPipeClientStream> ConnectAsync()
        {
            var pipe = new NamedPipeClientStream(".", Endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await pipe.ConnectAsync(Deadline.Token);
                await WaitForFile(Path.Combine(Root, "connected"));
                return pipe;
            }
            catch
            {
                pipe.Dispose();
                throw;
            }
        }

        internal async Task WaitForFile(string path)
        {
            while (!File.Exists(path))
            {
                if (Server.HasExited)
                    throw new InvalidOperationException($"The server fixture exited with code {Server.ExitCode} before {Path.GetFileName(path)}.");
                await Task.Delay(10, Deadline.Token);
            }
        }

        internal async Task StopMainAsync()
        {
            File.WriteAllText(Path.Combine(Root, "child-finish"), "finish");
            await Child.WaitForExitAsync(Deadline.Token);
        }

        internal async Task StopServerAsync()
        {
            File.WriteAllText(Path.Combine(Root, "server-finish"), "finish");
            await Server.WaitForExitAsync(Deadline.Token);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                File.WriteAllText(Path.Combine(Root, "server-finish"), "finish");
                File.WriteAllText(Path.Combine(Root, "child-finish"), "finish");
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                await Server.WaitForExitAsync(cleanup.Token);
                Assert.Equal(0, Server.ExitCode);
                if (child is not null)
                {
                    await child.WaitForExitAsync(cleanup.Token);
                    Assert.Equal(0, child.ExitCode);
                }
            }
            finally
            {
                main?.Dispose();
                child?.Dispose();
                Server.Dispose();
                Deadline.Dispose();
                Directory.Delete(Root, recursive: true);
            }
        }

        private static string Literal(string value) => value.Replace("'", "''", StringComparison.Ordinal);
    }
}
