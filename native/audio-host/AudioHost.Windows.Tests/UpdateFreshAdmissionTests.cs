using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

[Collection("Update startup admission")]
public sealed class UpdateFreshAdmissionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TransfersOrReclaimsAdmissionInTheExactNativeChildWithoutAnyUnprotectedInterval(bool transfer)
    {
        await using var fixture = await Fixture.StartAsync();
        using var admission = fixture.Admission;
        using var remote = UpdateRemoteRuntimeLease.Open(fixture.Main, admission.Handles);
        Assert.True(fixture.Main.IsNativeLaunch);
        Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
        if (transfer) remote.TransferToProcess();
        remote.Dispose();
        Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
        admission.Dispose();
        if (transfer)
        {
            Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
            Assert.Throws<IOException>(() => Directory.Move(fixture.Locks, fixture.Locks + "-moved"));
            Assert.False(fixture.Main.HasExited);
            await fixture.StopMainAsync();
        }
        using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
        Assert.Equal(transfer, fixture.Observed.HasExited);
    }

    [Fact]
    public async Task APartialTransferFailureReclaimsAlreadyCreatedCopiesWithoutKillingMain()
    {
        await using var fixture = await Fixture.StartAsync();
        using var admission = fixture.Admission;
        Assert.Equal("Synthetic handle enumeration failure.", Assert.Throws<IOException>(() =>
            UpdateRemoteRuntimeLease.Open(fixture.Main, FailAfterOne(admission.Handles))).Message);
        admission.Dispose();
        using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
        Assert.False(fixture.Main.HasExited);
    }

    [Fact]
    public async Task AnExitedChildCannotReceiveOrAcceptOwnershipAndCleanupNeverReopensItsPid()
    {
        await using var fixture = await Fixture.StartAsync();
        using var admission = fixture.Admission;
        using var remote = UpdateRemoteRuntimeLease.Open(fixture.Main, admission.Handles);
        await fixture.StopMainAsync();
        Assert.Equal("update_parent_missing", Assert.Throws<UpdateHandoffException>(remote.TransferToProcess).Code);
        Assert.Equal("update_parent_missing", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRemoteRuntimeLease.Open(fixture.Main, admission.Handles)).Code);
        remote.Dispose();
        admission.Dispose();
        using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RejectsBorrowedSurrogatesAndClosedNativeHandlesBeforeDuplicatingAdmission(bool disposed)
    {
        await using var fixture = await Fixture.StartAsync();
        using var admission = fixture.Admission;
        if (disposed)
        {
            fixture.Main.Dispose();
            Assert.Throws<ObjectDisposedException>(() => UpdateRemoteRuntimeLease.Open(fixture.Main, admission.Handles));
        }
        else
        {
            using var borrowed = Process.GetProcessById(fixture.Main.Id);
            using var surrogate = new UpdateLaunchedProcess(borrowed);
            Assert.False(surrogate.IsNativeLaunch);
            Assert.Throws<ArgumentException>(() => UpdateRemoteRuntimeLease.Open(surrogate, admission.Handles));
        }
        admission.Dispose();
        using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
        Assert.False(fixture.Observed.HasExited);
    }

    [Fact]
    public async Task IsolatedLaunchInheritsNeitherUnlistedFilesNorPrivatePipesAndTransferredAdmissionCannotLeakToDescendants()
    {
        var root = Path.Combine(Path.GetTempPath(), $"notes-isolated-canary-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var canaryPath = Path.Combine(root, "must-not-inherit.bin");
            using var canary = new FileStream(canaryPath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read | FileShare.Inheritable);
            using var privatePipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            await using var fixture = await Fixture.StartAsync();
            canary.Dispose();
            using var writable = File.OpenWrite(canaryPath);
            privatePipe.DisposeLocalCopyOfClientHandle();
            await Assert.ThrowsAsync<IOException>(async () =>
                await privatePipe.WriteAsync(new byte[] { 1 }, fixture.Deadline.Token));
            using var admission = fixture.Admission;
            using var remote = UpdateRemoteRuntimeLease.Open(fixture.Main, admission.Handles);
            remote.TransferToProcess();
            remote.Dispose();
            admission.Dispose();
            Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(fixture.Locks, admission: true));
            await fixture.LaunchDescendantAsync();
            Assert.False(fixture.Descendant.HasExited);
            await fixture.StopMainAsync();
            Assert.False(fixture.Descendant.HasExited);
            using var released = UpdateOperationLock.Open(fixture.Locks, admission: true);
            Assert.False(fixture.Descendant.HasExited);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void IsolatedLaunchFailureDoesNotRetainOrInheritExistingAdmission()
    {
        var root = Path.Combine(Path.GetTempPath(), $"notes-isolated-failure-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var admission = UpdateOperationLock.Open(Path.Combine(root, "locks"), admission: true);
            Assert.Throws<Win32Exception>(() => UpdateLaunchedProcess.StartIsolated(
                UpdateInstallerWorker.InstallerStart(Path.Combine(root, "missing.exe"), root)));
            admission.Dispose();
            using var released = UpdateOperationLock.Open(Path.Combine(root, "locks"), admission: true);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static IEnumerable<SafeFileHandle> FailAfterOne(IEnumerable<SafeFileHandle> handles)
    {
        yield return handles.First();
        throw new IOException("Synthetic handle enumeration failure.");
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private Process? descendant;
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), $"notes-fresh-admission-{Guid.NewGuid():N}");
        internal string Locks => Path.Combine(Root, "locks");
        internal UpdateOperationLock Admission { get; }
        internal UpdateLaunchedProcess Main { get; }
        internal Process Observed { get; }
        internal Process Descendant => descendant ?? throw new InvalidOperationException("No descendant was launched.");
        internal CancellationTokenSource Deadline { get; } = new(TimeSpan.FromSeconds(45));

        private Fixture()
        {
            Directory.CreateDirectory(Root);
            var childPath = Path.Combine(Root, "descendant.ps1");
            File.WriteAllText(childPath, $$"""
                $ErrorActionPreference='Stop'
                [IO.File]::WriteAllText('{{Literal(Path.Combine(Root, "descendant-ready"))}}.tmp',$PID.ToString())
                [IO.File]::Move('{{Literal(Path.Combine(Root, "descendant-ready"))}}.tmp','{{Literal(Path.Combine(Root, "descendant-ready"))}}')
                while(![IO.File]::Exists('{{Literal(Path.Combine(Root, "descendant-finish"))}}')){Start-Sleep -Milliseconds 10}
                """);
            var mainPath = Path.Combine(Root, "main.ps1");
            File.WriteAllText(mainPath, $$"""
                $ErrorActionPreference='Stop'
                [IO.File]::WriteAllText('{{Literal(Path.Combine(Root, "ready"))}}','ready')
                $finish='{{Literal(Path.Combine(Root, "finish"))}}'
                $launch='{{Literal(Path.Combine(Root, "launch"))}}'
                while(![IO.File]::Exists($finish) -and ![IO.File]::Exists($launch)){Start-Sleep -Milliseconds 10}
                if([IO.File]::Exists($launch)){
                  Add-Type -TypeDefinition @'
                using System;
                using System.ComponentModel;
                using System.Runtime.InteropServices;
                using System.Text;
                public static class UpdateInheritedProbe {
                  [StructLayout(LayoutKind.Sequential)] private struct Startup {
                    public uint Size;
                    public IntPtr Reserved, Desktop, Title;
                    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
                    public ushort Show,ReservedSize;
                    public IntPtr ReservedBytes,Input,Output,Error;
                  }
                  [StructLayout(LayoutKind.Sequential)] private struct Created {
                    public IntPtr Process,Thread;
                    public uint Pid,Tid;
                  }
                  private static IntPtr child;
                  public static void Start(string executable,string arguments,string directory) {
                    var startup=new Startup {Size=(uint)Marshal.SizeOf<Startup>()};
                    if(!CreateProcess(executable,new StringBuilder("\""+executable+"\" "+arguments),
                      IntPtr.Zero,IntPtr.Zero,true,0x08000400,IntPtr.Zero,directory,ref startup,out var created))
                      throw new Win32Exception(Marshal.GetLastWin32Error());
                    child=created.Process;
                    CloseHandle(created.Thread);
                  }
                  public static void Release(bool wait) {
                    try {
                      if(wait && WaitForSingleObject(child,10000)!=0) throw new InvalidOperationException("The descendant did not exit.");
                    }
                    finally {CloseHandle(child);}
                  }
                  [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)]
                  [return:MarshalAs(UnmanagedType.Bool)]
                  private static extern bool CreateProcess(string executable,StringBuilder command,IntPtr processSecurity,
                    IntPtr threadSecurity,[MarshalAs(UnmanagedType.Bool)]bool inherit,uint flags,IntPtr environment,
                    string directory,ref Startup startup,out Created created);
                  [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
                  [DllImport("kernel32.dll")] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
                }
                '@
                  [UpdateInheritedProbe]::Start('{{Literal(UpdateTrustTests.Reference)}}',
                    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{Literal(childPath)}}"','{{Literal(Root)}}')
                  try {
                    while(![IO.File]::Exists($finish)){Start-Sleep -Milliseconds 10}
                  }
                  finally {
                    [UpdateInheritedProbe]::Release([IO.File]::Exists('{{Literal(Path.Combine(Root, "descendant-finish"))}}'))
                  }
                }
                """);
            var start = UpdateInstallerWorker.InstallerStart(UpdateTrustTests.Reference, Root);
            start.Arguments = $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{mainPath}\"";
            Admission = UpdateOperationLock.Open(Locks, admission: true);
            Main = UpdateLaunchedProcess.StartIsolated(start);
            Observed = Process.GetProcessById(Main.Id);
        }

        internal static async Task<Fixture> StartAsync()
        {
            var fixture = new Fixture();
            try
            {
                await fixture.WaitForFile(Path.Combine(fixture.Root, "ready"));
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }

        internal async Task LaunchDescendantAsync()
        {
            File.WriteAllText(Path.Combine(Root, "launch"), "launch");
            var path = Path.Combine(Root, "descendant-ready");
            await WaitForFile(path);
            descendant = Process.GetProcessById(int.Parse(File.ReadAllText(path), System.Globalization.CultureInfo.InvariantCulture));
        }

        private async Task WaitForFile(string path)
        {
            while (!File.Exists(path))
            {
                if (Observed.HasExited)
                    throw new InvalidOperationException($"The Main fixture exited with code {Observed.ExitCode} before {Path.GetFileName(path)}.");
                await Task.Delay(10, Deadline.Token);
            }
        }

        internal async Task StopMainAsync()
        {
            File.WriteAllText(Path.Combine(Root, "finish"), "finish");
            await Observed.WaitForExitAsync(Deadline.Token);
            Assert.Equal(0, Observed.ExitCode);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                File.WriteAllText(Path.Combine(Root, "finish"), "finish");
                File.WriteAllText(Path.Combine(Root, "descendant-finish"), "finish");
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                await Observed.WaitForExitAsync(cleanup.Token);
                Assert.Equal(0, Observed.ExitCode);
                if (descendant is not null)
                {
                    await descendant.WaitForExitAsync(cleanup.Token);
                    Assert.Equal(0, descendant.ExitCode);
                }
            }
            finally
            {
                Main.Dispose();
                Observed.Dispose();
                descendant?.Dispose();
                Admission.Dispose();
                Deadline.Dispose();
                Directory.Delete(Root, recursive: true);
            }
        }

        private static string Literal(string path) => path.Replace("'", "''", StringComparison.Ordinal);
    }
}
