using System.IO.Pipes;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

[Collection("Update startup admission")]
public sealed class UpdateFirstStartTests
{
    [Fact]
    public async Task BindsBothRealChannelsTransfersExactMainOwnershipAndPersistsProtectedHealthBeforeConfirmation()
    {
        await using var fixture = new Fixture("valid");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var durable = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = fixture.RunAsync(async (proof, token) =>
        {
            entered.SetResult();
            await durable.Task.WaitAsync(token);
            fixture.Journal.WriteHealthy(proof);
        });
        try
        {
            await entered.Task.WaitAsync(fixture.Deadline.Token);
            Assert.True(File.Exists(fixture.Storage));
            Assert.False(File.Exists(fixture.Confirmed));
            Assert.False(fixture.Main.HasExited);
            Assert.Equal("installing", UpdateRuntimeState.Read(fixture.Runtime).Phase);
            Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
            durable.SetResult();
            var proof = await pending;
            Assert.Equal(8, proof.StorageSchema);
            Assert.Equal(fixture.Main.Identity, proof.Identity);
            await fixture.WaitForFile(fixture.Confirmed);
            Assert.Equal("healthy", UpdateRuntimeState.Read(fixture.Runtime).Phase);
            UpdateStartupRecovery.RequireSafe(fixture.Workers);
            Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
            await fixture.StopMainAsync();
            using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
        }
        finally { durable.TrySetResult(); }
    }

    [Theory]
    [InlineData("auth-challenge")]
    [InlineData("health-challenge")]
    [InlineData("session")]
    [InlineData("identity")]
    [InlineData("version")]
    [InlineData("extra")]
    [InlineData("missing")]
    [InlineData("image")]
    public async Task UnboundOrWrongBridgeCannotTransferAdmissionOpenStorageOrResolveTheFence(string mode)
    {
        await using var fixture = new Fixture(mode);
        var error = await Assert.ThrowsAsync<UpdateHandoffException>(() => fixture.RunAsync());
        Assert.Contains(error.Code, new[] { "update_restart_protocol", "update_restart_bridge_peer" });
        Assert.False(File.Exists(fixture.Storage));
        Assert.False(File.Exists(fixture.Confirmed));
        Assert.Equal("installed", fixture.Journal.Latest!.Phase);
        Assert.Equal("installing", UpdateRuntimeState.Read(fixture.Runtime).Phase);
        Assert.False(fixture.Main.HasExited);
        fixture.Admission.Dispose();
        using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
        Assert.Equal("update_recovery_required", Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(fixture.Workers)).Code);
    }

    [Fact]
    public async Task FailedHealthyPersistenceNeverConfirmsOrKillsTheAdmittedMainAndLeavesItsOwnershipUntilExit()
    {
        await using var fixture = new Fixture("valid");
        Assert.Equal("update_restart_outcome_failed", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            fixture.RunAsync((_, _) => throw new IOException("Synthetic health persistence failure.")))).Code);
        Assert.True(File.Exists(fixture.Storage));
        Assert.False(File.Exists(fixture.Confirmed));
        Assert.False(fixture.Main.HasExited);
        Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
        Assert.Equal("update_recovery_required", Assert.Throws<UpdateHandoffException>(() => UpdateStartupRecovery.RequireSafe(fixture.Workers)).Code);
    }

    [Fact]
    public async Task LostFinalAcknowledgmentDoesNotEraseDurableHealthOrKillTheAdmittedMain()
    {
        await using var fixture = new Fixture("lost-confirmation");
        Assert.Equal("update_restart_unavailable", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            fixture.RunAsync(async (proof, _) =>
            {
                await fixture.WaitForFile(fixture.Disconnected);
                fixture.Journal.WriteHealthy(proof);
            }))).Code);
        Assert.True(File.Exists(fixture.Storage));
        Assert.False(File.Exists(fixture.Confirmed));
        Assert.False(fixture.Main.HasExited);
        Assert.Equal("healthy", fixture.Journal.Latest!.Phase);
        UpdateStartupRecovery.RequireSafe(fixture.Workers);
        Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
        await fixture.StopMainAsync();
        using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private const string Wire = """
            function Read-Bytes([int]$count){
              $b=[byte[]]::new($count);$offset=0
              while($offset -lt $count){
                $n=$p.Read($b,$offset,$count-$offset)
                if($n -eq 0){throw 'Closed pipe'}
                $offset+=$n
              }
              return ,$b
            }
            function Read-Frame {
              $h=Read-Bytes 4;$n=[BitConverter]::ToUInt32($h,0)
              if($n -eq 0 -or $n -gt 1024){throw 'Invalid frame'}
              return [Text.Encoding]::UTF8.GetString((Read-Bytes $n))
            }
            function Write-Frame($value){
              $b=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Compress -Depth 6))
              $h=[BitConverter]::GetBytes([uint32]$b.Length)
              $p.Write($h,0,4);$p.Write($b,0,$b.Length);$p.Flush()
            }
            """;
        private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-first-start-{Guid.NewGuid():N}");
        private readonly NamedPipeServerStream authentication;
        private readonly UpdateRestartHealth health;
        private readonly string mode;
        private Task<UpdateRestartProof>? pending;
        internal string Locks => Path.Combine(root, "locks");
        internal string Workers => Path.Combine(root, "workers");
        internal string Runtime { get; }
        internal string Storage => Path.Combine(root, "storage-opened");
        internal string Confirmed => Path.Combine(root, "confirmed");
        internal string Disconnected => Path.Combine(root, "disconnected");
        internal UpdateWorkerJournal Journal { get; }
        internal UpdateOperationLock Admission { get; }
        internal UpdateLaunchedProcess Main { get; }
        internal CancellationTokenSource Deadline { get; } = new(TimeSpan.FromSeconds(30));

        internal Fixture(string mode)
        {
            this.mode = mode;
            Directory.CreateDirectory(root);
            new DirectoryInfo(Workers).Create(UpdatePrivateDirectory.Security());
            var session = Guid.NewGuid();
            Runtime = Path.Combine(Workers, $"worker-{session:D}");
            new DirectoryInfo(Runtime).Create(UpdatePrivateDirectory.Security());
            UpdateRuntimeState.Stage(Runtime, new('a', 64));
            UpdateRuntimeState.Claim(Runtime, new('a', 64));
            Journal = new(Runtime, "0.1.0", "0.1.1");
            Journal.Write("preparing", "update_worker_preparing");
            Journal.Write("prepared", "update_worker_prepared");
            Journal.Write("committed", "update_worker_committed");
            Journal.Write("installing", "update_installer_started", true, installerProcess: new(1234, "134000000000000001"));
            Journal.Write("installed", "update_worker_installed", true, 0);
            Admission = UpdateOperationLock.Open(Locks, admission: true);
            health = new(session, "0.1.1", TimeSpan.FromSeconds(10));
            var endpoint = $"notes-authentication-{Guid.NewGuid():N}";
            authentication = new(endpoint, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance, 1024, 1024);
            var bridgePath = Path.Combine(root, "bridge.ps1");
            File.WriteAllText(bridgePath, Wire + "\n" + $$"""
                $ErrorActionPreference='Stop'
                $p=[IO.Pipes.NamedPipeClientStream]::new('.','{{endpoint}}',[IO.Pipes.PipeDirection]::InOut)
                try {
                  $p.Connect(10000)
                  $binding=Read-Frame|ConvertFrom-Json
                  $reply=[ordered]@{
                    version=1;event='update_restart_auth_ready';session_id=$binding.session_id
                    challenge=$binding.challenge;identity=$binding.identity;application_version=$binding.application_version
                    auth_challenge=$binding.auth_challenge
                  }
                  switch('{{mode}}'){
                    'auth-challenge' {$reply.auth_challenge='0'*64}
                    'health-challenge' {$reply.challenge='0'*64}
                    'session' {$reply.session_id='11111111-1111-4111-8111-111111111111'}
                    'identity' {$reply.identity.pid++}
                    'version' {$reply.application_version='0.1.2'}
                    'extra' {$reply['healthy']=$true}
                    'missing' {$reply.Remove('auth_challenge')}
                  }
                  Write-Frame $reply
                  $ack=Read-Frame|ConvertFrom-Json
                  if($ack.event -ne 'update_restart_auth_admitted'){throw 'Not admitted'}
                  $ack.event='update_restart_auth_finished'
                  Write-Frame $ack
                }
                catch {[IO.File]::WriteAllText('{{Literal(Path.Combine(root, "bridge-error"))}}',$_.ToString());exit 2}
                finally {$p.Dispose()}
                """);
            var mainPath = Path.Combine(root, "main.ps1");
            File.WriteAllText(mainPath, Wire + "\n" + $$"""
                $ErrorActionPreference='Stop'
                $p=[IO.Pipes.NamedPipeClientStream]::new('.','{{health.Endpoint}}',[IO.Pipes.PipeDirection]::InOut)
                try {
                  $p.Connect(10000)
                  $binding=Read-Frame|ConvertFrom-Json
                  $start=[Diagnostics.ProcessStartInfo]::new('{{Literal(UpdateTrustTests.Reference)}}')
                  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
                  foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{{Literal(bridgePath)}}')){
                    $start.ArgumentList.Add($arg)
                  }
                  $bridge=[Diagnostics.Process]::Start($start)
                  try {
                    $bridge.WaitForExit()
                    if($bridge.ExitCode -ne 0){throw 'Bridge rejected admission'}
                  }
                  finally {$bridge.Dispose()}
                  [IO.File]::WriteAllText('{{Literal(Storage)}}','Synthetic storage boundary, not signed production acceptance.')
                  $ready=[ordered]@{
                    version=1;event='update_restart_ready';session_id=$binding.session_id;challenge=$binding.challenge
                    identity=$binding.identity;application_version=$binding.application_version;storage_schema=8
                  }
                  Write-Frame $ready
                  if('{{mode}}' -eq 'lost-confirmation'){
                    $p.Dispose()
                    [IO.File]::WriteAllText('{{Literal(Disconnected)}}','disconnected before durable confirmation')
                  } else {
                    $ack=Read-Frame|ConvertFrom-Json
                    if($ack.event -ne 'update_restart_confirmed'){throw 'Health not confirmed'}
                    [IO.File]::WriteAllText('{{Literal(Confirmed)}}','confirmed')
                  }
                }
                catch {[IO.File]::WriteAllText('{{Literal(Path.Combine(root, "main-error"))}}',$_.ToString())}
                finally {$p.Dispose()}
                while(![IO.File]::Exists('{{Literal(Path.Combine(root, "finish"))}}')){Start-Sleep -Milliseconds 10}
                """);
            var start = UpdateInstallerWorker.InstallerStart(UpdateTrustTests.Reference, root);
            start.Arguments = $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{mainPath}\"";
            Main = UpdateLaunchedProcess.StartIsolated(start);
        }

        internal Task<UpdateRestartProof> RunAsync(Func<UpdateRestartProof, CancellationToken, Task>? persist = null)
        {
            pending = health.RunAsync(Main, persist ?? ((proof, _) => { Journal.WriteHealthy(proof); return Task.CompletedTask; }),
                Deadline.Token, async (binding, token) =>
                {
                    try
                    {
                        await authentication.WaitForConnectionAsync(token);
                        using var bridge = UpdateRestartAdmission.OpenBridgePeer(authentication, Main, mode == "image"
                            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe") : UpdateTrustTests.Reference);
                        // This internal wire probe has synthetic services; production also requires the pinned sealed runtime.
                        await UpdateRestartAdmission.ExchangeAsync(authentication, Main, bridge, binding, Admission.Handles, token);
                        Admission.Dispose();
                    }
                    finally { await authentication.DisposeAsync(); }
                });
            return pending;
        }

        internal async Task WaitForFile(string path)
        {
            while (!File.Exists(path)) await Task.Delay(10, Deadline.Token);
        }

        internal async Task StopMainAsync()
        {
            File.WriteAllText(Path.Combine(root, "finish"), "finish");
            await Main.WaitForExitAsync(Deadline.Token);
            Assert.Equal(0, Main.ExitCode);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                Deadline.Cancel();
                await health.DisposeAsync();
                await authentication.DisposeAsync();
                File.WriteAllText(Path.Combine(root, "finish"), "finish");
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                await Main.WaitForExitAsync(cleanup.Token);
                if (pending is not null)
                {
                    try { await pending; }
                    catch (Exception error) when (error is IOException or OperationCanceledException) { }
                }
            }
            finally
            {
                Main.Dispose();
                Admission.Dispose();
                Deadline.Dispose();
                Directory.Delete(root, recursive: true);
            }
        }

        private static string Literal(string value) => value.Replace("'", "''", StringComparison.Ordinal);
    }
}
