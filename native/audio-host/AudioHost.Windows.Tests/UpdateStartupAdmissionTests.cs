using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

[CollectionDefinition("Update startup admission", DisableParallelization = true)]
public sealed class UpdateStartupAdmissionCollection { }

[Collection("Update startup admission")]
public sealed class UpdateStartupAdmissionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-startup-admission-{Guid.NewGuid():D}");
    private string Locks => Path.Combine(root, "locks");
    private string Lockfile => Path.Combine(Locks, $"{UpdateInstallationVerifier.ApplicationGuid}.startup.lock");

    public UpdateStartupAdmissionTests() => Directory.CreateDirectory(root);

    [Fact]
    public void LocksBothTheFileAndItsAncestorNamesWithoutCouplingPreparationToMainLifetime()
    {
        using var admission = UpdateOperationLock.Open(Locks, admission: true);
        using var operation = UpdateOperationLock.Open(Locks, admission: false);
        Assert.Equal("update_worker_busy", Assert.Throws<UpdateHandoffException>(() =>
            UpdateOperationLock.Open(Locks, admission: true)).Code);
        Assert.Throws<IOException>(() => Directory.Move(Locks, Locks + "-replaced"));
        Assert.Throws<IOException>(() => Directory.Move(root, root + "-replaced"));
        Assert.Throws<IOException>(() => File.Delete(Lockfile));
        operation.Dispose();
        using var preparing = UpdateOperationLock.Open(Locks, admission: false);
        admission.Dispose();
        using var released = UpdateOperationLock.Open(Locks, admission: true);
    }

    [Fact]
    public async Task TransferredMainAdmissionSurvivesHelperCleanupUntilTheExactMainActuallyExits()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var local = UpdateOperationLock.Open(Locks, admission: true);
        using var remote = UpdateRemoteRuntimeLease.Open(fixture.Parent, local.Handles);
        remote.TransferToParent();
        remote.Dispose();
        local.Dispose();
        Assert.False(fixture.Parent.HasExited);
        Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(Locks, admission: true));
        Assert.Throws<IOException>(() => Directory.Move(Locks, Locks + "-replaced"));
        await fixture.ExitParentAsync();
        using var released = UpdateOperationLock.Open(Locks, admission: true);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(7)]
    [InlineData(259)]
    public async Task InstallerRetainsAdmissionAndCandidateAfterAllWorkerCopiesCloseButNotUnlistedInheritableHandles(int exitCode)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var admission = UpdateOperationLock.Open(Locks, admission: true);
        var candidatePath = Path.Combine(root, "retained candidate.bin");
        var unrelatedPath = Path.Combine(root, "unlisted private file.bin");
        File.WriteAllBytes(candidatePath, [1, 2, 3]);
        using var candidate = UpdatePathLock.OpenFile(candidatePath);
        using var unrelated = new FileStream(unrelatedPath, FileMode.Create, FileAccess.ReadWrite,
            FileShare.Read | FileShare.Inheritable);
        var ready = Path.Combine(root, "ready");
        var finish = Path.Combine(root, "finish");
        var start = UpdateInstallerWorker.InstallerStart(UpdateTrustTests.Reference, root);
        start.Arguments = $"-NoLogo -NoProfile -NonInteractive -Command \"$ErrorActionPreference='Stop'; " +
            $"[IO.File]::WriteAllText('{Literal(ready)}','ready'); " +
            $"while(![IO.File]::Exists('{Literal(finish)}')){{Start-Sleep -Milliseconds 20}}; exit {exitCode}\"";
        using var process = UpdateInstallerProcess.Start(start, admission.Handles.Append(candidate));
        try
        {
            while (!File.Exists(ready)) await Task.Delay(10, deadline.Token);
            Assert.False(process.HasExited);
            Assert.True(process.Id > 0);
            Assert.True(process.StartTime.ToUniversalTime().ToFileTimeUtc() > 0);
            // A dead worker has no local copies. Exclusion must still be owned by the real installer.
            admission.Dispose();
            candidate.Dispose();
            unrelated.Dispose();
            Assert.Throws<UpdateHandoffException>(() => UpdateOperationLock.Open(Locks, admission: true));
            Assert.Throws<IOException>(() => Directory.Move(Locks, Locks + "-replaced"));
            Assert.Throws<IOException>(() => { using var overwrite = File.OpenWrite(candidatePath); });
            Assert.Throws<IOException>(() => File.Delete(candidatePath));
            using var notInherited = File.OpenWrite(unrelatedPath);
            var waiting = process.WaitForExitAsync(CancellationToken.None);
            Assert.False(waiting.IsCompleted);
        }
        finally
        {
            File.WriteAllText(finish, "finish");
            await process.WaitForExitAsync(deadline.Token);
        }
        Assert.True(process.HasExited);
        Assert.Equal(exitCode, process.ExitCode);
        using var released = UpdateOperationLock.Open(Locks, admission: true);
        using var writable = File.OpenWrite(candidatePath);
    }

    [Fact]
    public void FailedProcessCreationReclaimsAllTemporaryInheritedDuplicates()
    {
        using var admission = UpdateOperationLock.Open(Locks, admission: true);
        var start = UpdateInstallerWorker.InstallerStart(Path.Combine(root, "missing.exe"), root);
        Assert.Throws<Win32Exception>(() => UpdateInstallerProcess.Start(start, admission.Handles));
        admission.Dispose();
        using var released = UpdateOperationLock.Open(Locks, admission: true);
    }

    [Fact]
    public void RejectsAWeakenedExistingLockFileEvenInsideTheProtectedDirectory()
    {
        using (UpdateOperationLock.Open(Locks, admission: true)) { }
        var info = new FileInfo(Lockfile);
        var security = info.GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null),
            FileSystemRights.Read, AccessControlType.Allow));
        info.SetAccessControl(security);
        Assert.Throws<UnauthorizedAccessException>(() => UpdateOperationLock.Open(Locks, admission: true));
    }

    [Fact]
    public void RejectsAnAliasedLockFileWithoutFollowingOrTruncatingIt()
    {
        using (UpdateOperationLock.Open(Locks, admission: true)) { }
        var alias = Path.Combine(root, "aliased-lock");
        Assert.True(CreateHardLink(alias, Lockfile, 0), new Win32Exception(Marshal.GetLastPInvokeError()).Message);
        Assert.Throws<UpdatePathInvalidException>(() => UpdateOperationLock.Open(Locks, admission: true));
        Assert.True(File.Exists(alias));
    }

    private static string Literal(string path) => path.Replace("'", "''", StringComparison.Ordinal);
    public void Dispose() => Directory.Delete(root, recursive: true);

    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string file, string existing, nint security);
}
