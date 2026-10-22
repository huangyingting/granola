using System.IO.Pipes;
using System.Text.Json;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

[Collection("Update startup admission")]
public sealed class UpdateRestartHealthTests
{
    [Theory]
    [InlineData("valid", 8)]
    [InlineData("schema-min", 1)]
    [InlineData("schema-max", 65_535)]
    public async Task AuthenticatesTheActualNewChildAndConfirmsOnlyAfterDurableOwnerCompletionOnce(string mode, int schema)
    {
        await using var fixture = new Fixture(mode);
        var entered = new TaskCompletionSource<UpdateRestartProof>(TaskCreationOptions.RunContinuationsAsynchronously);
        var durable = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var pending = fixture.Health.RunAsync(fixture.Main, async (proof, token) =>
        {
            calls++;
            entered.SetResult(proof);
            await durable.Task.WaitAsync(token);
            File.WriteAllText(Path.Combine(fixture.Root, "durable"), proof.SessionId);
        }, fixture.Deadline.Token);
        try
        {
            var proof = await entered.Task.WaitAsync(fixture.Deadline.Token);
            Assert.Equal(fixture.Session.ToString("D"), proof.SessionId);
            Assert.Equal(fixture.Main.Identity, proof.Identity);
            Assert.Equal("0.1.1", proof.ApplicationVersion);
            Assert.Equal(schema, proof.StorageSchema);
            Assert.False(pending.IsCompleted);
            Assert.False(File.Exists(fixture.Acknowledgment));
            durable.SetResult();
            Assert.Equal(proof, await pending);
            await fixture.WaitForFile(fixture.Acknowledgment);
            using var acknowledgment = JsonDocument.Parse(File.ReadAllText(fixture.Acknowledgment));
            var message = acknowledgment.RootElement;
            Assert.Equal("update_restart_confirmed", message.GetProperty("event").GetString());
            Assert.Equal(proof.SessionId, message.GetProperty("session_id").GetString());
            Assert.Equal(proof.Identity.Pid, message.GetProperty("identity").GetProperty("pid").GetInt32());
            using var challenge = JsonDocument.Parse(File.ReadAllText(fixture.Challenge));
            Assert.Equal(challenge.RootElement.GetProperty("challenge").GetString(), message.GetProperty("challenge").GetString());
            Assert.True(File.Exists(Path.Combine(fixture.Root, "durable")));
            Assert.False(fixture.Main.HasExited);
            Assert.Equal("update_restart_used", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
                fixture.Health.RunAsync(fixture.Main, (_, _) => { calls++; return Task.CompletedTask; }))).Code);
            Assert.Equal(1, calls);
        }
        finally
        {
            durable.TrySetResult();
            await Observe(pending);
        }
    }

    [Fact]
    public async Task RejectsAnEarlierChallengeEvenForTheSameSessionAndAValidCurrentPeerIdentity()
    {
        await using var first = new Fixture();
        await first.Health.RunAsync(first.Main, (_, _) => Task.CompletedTask, first.Deadline.Token);
        using var original = JsonDocument.Parse(File.ReadAllText(first.Challenge));
        var stale = original.RootElement.GetProperty("challenge").GetString()!;
        await using var second = new Fixture("stale", session: first.Session, staleChallenge: stale);
        var calls = 0;
        Assert.Equal("update_restart_protocol", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            second.Health.RunAsync(second.Main, (_, _) => { calls++; return Task.CompletedTask; }, second.Deadline.Token))).Code);
        await second.WaitForFile(second.WireFinished);
        using var current = JsonDocument.Parse(File.ReadAllText(second.Challenge));
        Assert.NotEqual(stale, current.RootElement.GetProperty("challenge").GetString());
        Assert.Equal(second.Main.Id, current.RootElement.GetProperty("identity").GetProperty("pid").GetInt32());
        Assert.Equal(0, calls);
        Assert.False(File.Exists(second.Acknowledgment));
        Assert.False(second.Main.HasExited);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("event")]
    [InlineData("session")]
    [InlineData("challenge")]
    [InlineData("pid")]
    [InlineData("creation")]
    [InlineData("application")]
    [InlineData("identity-null")]
    [InlineData("schema-zero")]
    [InlineData("schema-large")]
    [InlineData("schema-fraction")]
    [InlineData("schema-string")]
    [InlineData("schema-null")]
    [InlineData("schema-missing")]
    [InlineData("extra")]
    [InlineData("extra-identity")]
    [InlineData("duplicate")]
    [InlineData("malformed")]
    [InlineData("empty")]
    [InlineData("oversized")]
    [InlineData("truncated-header")]
    [InlineData("truncated-body")]
    [InlineData("closed")]
    public async Task RejectsInvalidOrUnboundHealthWithoutOwnerPersistenceOrConfirmation(string mode)
    {
        await using var fixture = new Fixture(mode);
        var calls = 0;
        var error = await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            fixture.Health.RunAsync(fixture.Main, (_, _) => { calls++; return Task.CompletedTask; }, fixture.Deadline.Token));
        Assert.Contains(error.Code, new[] { "update_restart_protocol", "update_restart_unavailable" });
        await fixture.WaitForFile(fixture.WireFinished);
        Assert.Equal(0, calls);
        Assert.False(File.Exists(fixture.Acknowledgment));
        Assert.False(fixture.Main.HasExited);
    }

    [Fact]
    public async Task RejectsTheWrongOperatingSystemPeerBeforeEvenSendingAChallenge()
    {
        await using var fixture = new Fixture("idle");
        using var intruder = new NamedPipeClientStream(".", fixture.Health.Endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
        var calls = 0;
        var pending = fixture.Health.RunAsync(fixture.Main, (_, _) => { calls++; return Task.CompletedTask; }, fixture.Deadline.Token);
        await intruder.ConnectAsync(fixture.Deadline.Token);
        Assert.Equal("update_restart_peer", (await Assert.ThrowsAsync<UpdateHandoffException>(() => pending)).Code);
        var data = new byte[1];
        try { Assert.Equal(0, await intruder.ReadAsync(data, fixture.Deadline.Token)); }
        catch (IOException) { }
        Assert.Equal(0, calls);
        Assert.False(fixture.Main.HasExited);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeadlineAndCallerCancellationDoNotKillMainOrAllowReuse(bool cancel)
    {
        await using var fixture = new Fixture("idle", TimeSpan.FromMilliseconds(cancel ? 10_000 : 250));
        using var caller = new CancellationTokenSource();
        var pending = fixture.Health.RunAsync(fixture.Main, (_, _) => throw new InvalidOperationException("Unexpected health."), caller.Token);
        if (cancel) caller.Cancel();
        Assert.Equal(cancel ? "update_restart_cancelled" : "update_restart_timeout",
            (await Assert.ThrowsAsync<UpdateHandoffException>(() => pending)).Code);
        Assert.False(fixture.Main.HasExited);
        Assert.False(File.Exists(fixture.Acknowledgment));
        Assert.Equal("update_restart_used", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            fixture.Health.RunAsync(fixture.Main, (_, _) => Task.CompletedTask))).Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PersistenceFailuresNeverProduceConfirmation(bool synchronous)
    {
        await using var fixture = new Fixture();
        Assert.Equal("update_restart_outcome_failed",
            (await Assert.ThrowsAsync<UpdateHandoffException>(() => fixture.Health.RunAsync(fixture.Main,
                (_, _) => synchronous ? throw new IOException("Synthetic persistence failure.") :
                    Task.FromException(new IOException("Synthetic persistence failure.")), fixture.Deadline.Token))).Code);
        await fixture.WaitForFile(fixture.WireFinished);
        Assert.False(File.Exists(fixture.Acknowledgment));
        Assert.False(fixture.Main.HasExited);
    }

    [Fact]
    public async Task IndependentPersistenceCancellationIsAnOutcomeFailureNotAFalseDeadline()
    {
        await using var fixture = new Fixture();
        Assert.Equal("update_restart_outcome_failed", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            fixture.Health.RunAsync(fixture.Main, (_, _) => Task.FromCanceled(new CancellationToken(true)),
                fixture.Deadline.Token))).Code);
        await fixture.WaitForFile(fixture.WireFinished);
        Assert.False(File.Exists(fixture.Acknowledgment));
        Assert.False(fixture.Main.HasExited);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationClosesTheChannelButDrainsUncooperativeOwnerPersistenceBeforeReturning(bool timeout)
    {
        await using var fixture = new Fixture(timeout: timeout ? TimeSpan.FromSeconds(3) : null);
        using var caller = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = fixture.Health.RunAsync(fixture.Main, async (_, _) =>
        {
            entered.SetResult();
            await release.Task;
        }, caller.Token);
        try
        {
            await entered.Task.WaitAsync(fixture.Deadline.Token);
            if (!timeout) caller.Cancel();
            await fixture.WaitForFile(fixture.WireFinished);
            Assert.False(pending.IsCompleted);
            Assert.False(File.Exists(fixture.Acknowledgment));
            Assert.False(fixture.Main.HasExited);
            release.SetResult();
            Assert.Equal(timeout ? "update_restart_timeout" : "update_restart_cancelled",
                (await Assert.ThrowsAsync<UpdateHandoffException>(() => pending)).Code);
        }
        finally
        {
            release.TrySetResult();
            await Observe(pending);
        }
    }

    [Fact]
    public async Task ExactMainExitDuringPersistenceCancelsTheOwnerAndNeverConfirms()
    {
        await using var fixture = new Fixture("exit-persist");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = fixture.Health.RunAsync(fixture.Main, async (_, token) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
        }, fixture.Deadline.Token);
        await entered.Task.WaitAsync(fixture.Deadline.Token);
        File.WriteAllText(fixture.Finish, "exit");
        Assert.Equal("update_restart_main_exited", (await Assert.ThrowsAsync<UpdateHandoffException>(() => pending)).Code);
        Assert.True(fixture.Main.HasExited);
        Assert.False(File.Exists(fixture.Acknowledgment));
    }

    [Fact]
    public async Task AnAlreadyExitedRetainedChildIsNotFreshHealthAuthority()
    {
        await using var fixture = new Fixture("idle");
        File.WriteAllText(fixture.Finish, "exit");
        await fixture.Main.WaitForExitAsync(fixture.Deadline.Token);
        Assert.Equal("update_restart_main_exited", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            fixture.Health.RunAsync(fixture.Main, (_, _) => throw new InvalidOperationException("Unexpected health.")))).Code);
    }

    [Fact]
    public async Task RejectsBorrowedProcessesEvenWhenTheyHaveALivePid()
    {
        await using var health = new UpdateRestartHealth(Guid.NewGuid(), "0.1.1", TimeSpan.FromSeconds(10));
        using var borrowed = new UpdateLaunchedProcess(System.Diagnostics.Process.GetCurrentProcess());
        Assert.Equal("update_restart_arguments", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            health.RunAsync(borrowed, (_, _) => throw new InvalidOperationException("Unexpected health.")))).Code);
    }

    [Fact]
    public async Task EndpointIsUnpredictableExclusiveAndSeparateForEachReceiver()
    {
        var session = Guid.NewGuid();
        await using var first = new UpdateRestartHealth(session, "0.1.1", TimeSpan.FromSeconds(10));
        await using var second = new UpdateRestartHealth(session, "0.1.1", TimeSpan.FromSeconds(10));
        Assert.NotEqual(first.Endpoint, second.Endpoint);
        Assert.Throws<IOException>(() => new NamedPipeServerStream(first.Endpoint, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly));
    }

    [Theory]
    [InlineData("00000000-0000-0000-0000-000000000000", "0.1.1", 10)]
    [InlineData("11111111-1111-1111-8111-111111111111", "0.1.1", 10)]
    [InlineData("11111111-1111-4111-7111-111111111111", "0.1.1", 10)]
    [InlineData("11111111-1111-4111-8111-111111111111", "01.1.1", 10)]
    [InlineData("11111111-1111-4111-8111-111111111111", "0.1.1", 0)]
    [InlineData("11111111-1111-4111-8111-111111111111", "0.1.1", 121)]
    public void RejectsInvalidSessionVersionAndDeadline(string session, string version, int seconds) =>
        Assert.Equal("update_restart_arguments", Assert.Throws<UpdateHandoffException>(() =>
            new UpdateRestartHealth(Guid.Parse(session), version, TimeSpan.FromSeconds(seconds))).Code);

    private static async Task Observe(Task pending)
    {
        try { await pending; }
        catch (UpdateHandoffException) { }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly string Root = Path.Combine(Path.GetTempPath(), $"notes-restart-health-{Guid.NewGuid():D}");
        internal Guid Session { get; }
        internal readonly CancellationTokenSource Deadline = new(TimeSpan.FromSeconds(30));
        internal UpdateRestartHealth Health { get; }
        internal UpdateLaunchedProcess Main { get; }
        private readonly UpdateOperationLock admission;
        internal string Acknowledgment => Path.Combine(Root, "ack.json");
        internal string Challenge => Path.Combine(Root, "challenge.json");
        internal string WireFinished => Path.Combine(Root, "wire-finished");
        internal string Finish => Path.Combine(Root, "finish");

        internal Fixture(string mode = "valid", TimeSpan? timeout = null, Guid? session = null, string staleChallenge = "")
        {
            Session = session ?? Guid.NewGuid();
            Directory.CreateDirectory(Root);
            admission = UpdateOperationLock.Open(Path.Combine(Root, "locks"), admission: true);
            Health = new(Session, "0.1.1", timeout ?? TimeSpan.FromSeconds(10));
            try
            {
                var scriptPath = Path.Combine(Root, "synthetic-peer.ps1");
                var script = $$"""
                    $ErrorActionPreference='Stop'
                    $mode='{{mode}}'
                    $finish='{{Literal(Finish)}}'
                    if($mode -eq 'idle'){
                      while(![IO.File]::Exists($finish)){Start-Sleep -Milliseconds 10}
                      exit 0
                    }
                    $p=[IO.Pipes.NamedPipeClientStream]::new('.','{{Health.Endpoint}}',[IO.Pipes.PipeDirection]::InOut)
                    function Read-Bytes([int]$count){
                      $b=[byte[]]::new($count)
                      $offset=0
                      while($offset -lt $count){
                        $n=$p.Read($b,$offset,$count-$offset)
                        if($n -eq 0){throw 'Closed pipe'}
                        $offset+=$n
                      }
                      return ,$b
                    }
                    function Read-Frame {
                      $h=Read-Bytes 4
                      $n=[BitConverter]::ToUInt32($h,0)
                      if($n -eq 0 -or $n -gt 1024){throw 'Invalid frame'}
                      $b=Read-Bytes $n
                      return [Text.Encoding]::UTF8.GetString($b)
                    }
                    try {
                      $p.Connect(10000)
                      $raw=Read-Frame
                      [IO.File]::WriteAllText('{{Literal(Challenge)}}',$raw)
                      $r=$raw|ConvertFrom-Json
                      $r.event='update_restart_ready'
                      $r|Add-Member -NotePropertyName storage_schema -NotePropertyValue 8
                      switch($mode){
                        'version' {$r.version=2}
                        'event' {$r.event='update_restart_confirmed'}
                        'session' {$r.session_id=[Guid]::NewGuid().ToString('D')}
                        'challenge' {$r.challenge='F'*64}
                        'stale' {$r.challenge='{{Literal(staleChallenge)}}'}
                        'pid' {$r.identity.pid+=1}
                        'creation' {$r.identity.creation_file_time='1'}
                        'application' {$r.application_version='0.1.2'}
                        'identity-null' {$r.identity=$null}
                        'schema-zero' {$r.storage_schema=0}
                        'schema-min' {$r.storage_schema=1}
                        'schema-max' {$r.storage_schema=65535}
                        'schema-large' {$r.storage_schema=65536}
                        'schema-fraction' {$r.storage_schema=1.5}
                        'schema-string' {$r.storage_schema='8'}
                        'schema-null' {$r.storage_schema=$null}
                        'schema-missing' {$r.PSObject.Properties.Remove('storage_schema')}
                        'extra' {$r|Add-Member -NotePropertyName verified -NotePropertyValue $true}
                        'extra-identity' {$r.identity|Add-Member -NotePropertyName verified -NotePropertyValue $true}
                      }
                      $json=$r|ConvertTo-Json -Compress -Depth 8
                      if($mode -eq 'duplicate'){$json='{"version":1,'+$json.Substring(1)}
                      if($mode -eq 'malformed'){$json='{'}
                      $body=[Text.Encoding]::UTF8.GetBytes($json)
                      $size=$body.Length
                      if($mode -eq 'empty'){$size=0}
                      if($mode -eq 'oversized'){$size=1025}
                      if($mode -eq 'truncated-body'){$size=1024;$body=[Text.Encoding]::UTF8.GetBytes('{')}
                      $header=[BitConverter]::GetBytes([uint32]$size)
                      if($mode -eq 'closed'){$p.Dispose()}
                      elseif($mode -eq 'truncated-header'){$p.Write($header,0,2);$p.Dispose()}
                      else {
                        $p.Write($header,0,4)
                        if($mode -notin @('empty','oversized')){$p.Write($body,0,$body.Length)}
                        $p.Flush()
                        if($mode -eq 'truncated-body'){$p.Dispose()}
                        elseif($mode -eq 'exit-persist'){
                          while(![IO.File]::Exists($finish)){Start-Sleep -Milliseconds 10}
                          exit 0
                        }
                        else {
                          $ack=Read-Frame
                          [IO.File]::WriteAllText('{{Literal(Acknowledgment)}}.tmp',$ack)
                          [IO.File]::Move('{{Literal(Acknowledgment)}}.tmp','{{Literal(Acknowledgment)}}')
                        }
                      }
                    }
                    catch {[IO.File]::WriteAllText('{{Literal(Path.Combine(Root, "peer-error"))}}',$_.Exception.GetType().Name)}
                    finally {
                      $p.Dispose()
                      [IO.File]::WriteAllText('{{Literal(WireFinished)}}','finished')
                    }
                    while(![IO.File]::Exists($finish)){Start-Sleep -Milliseconds 10}
                    """;
                File.WriteAllText(scriptPath, script);
                var start = UpdateInstallerWorker.InstallerStart(UpdateTrustTests.Reference, Root);
                start.Arguments = $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"";
                Main = UpdateLaunchedProcess.Start(start, admission.Handles);
            }
            catch
            {
                Health.DisposeAsync().AsTask().GetAwaiter().GetResult();
                admission.Dispose();
                Deadline.Dispose();
                Directory.Delete(Root, recursive: true);
                throw;
            }
        }

        internal async Task WaitForFile(string path)
        {
            while (!File.Exists(path)) await Task.Delay(10, Deadline.Token);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await Health.DisposeAsync();
                File.WriteAllText(Finish, "exit");
                await Main.WaitForExitAsync(Deadline.Token);
            }
            finally
            {
                Main.Dispose();
                admission.Dispose();
                Deadline.Dispose();
                Directory.Delete(Root, recursive: true);
            }
        }

        private static string Literal(string value) => value.Replace("'", "''", StringComparison.Ordinal);
    }
}
