using System.Diagnostics;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateParentTests
{
    [Theory]
    [InlineData(0, @"C:\Synthetic\app.exe")]
    [InlineData(-1, @"C:\Synthetic\app.exe")]
    [InlineData(1, "relative.exe")]
    [InlineData(1, @"C:\Synthetic\app.dll")]
    public void RejectsInvalidIdentityRequestsBeforeOpeningProcesses(int pid, string executable)
    {
        var result = UpdateParentLease.Open(pid, executable, out var lease);
        Assert.False(result.Matched);
        Assert.Equal("update_parent_arguments", result.Code);
        Assert.Null(lease);
    }

    [Fact]
    public void DoesNotTreatTheCurrentProcessAsItsOwnParent()
    {
        var result = UpdateParentLease.Open(Environment.ProcessId,
            Environment.ProcessPath ?? throw new InvalidOperationException("No executable path is available."), out var lease);
        Assert.False(result.Matched);
        Assert.Equal("update_parent_mismatch", result.Code);
        Assert.Null(lease);
    }

    [Fact]
    public async Task RetainsTheExactKernelProcessHandleWaitsForExitAndNeverTerminatesTheProcess()
    {
        using var process = StartFixture();
        UpdateParentLease? lease = null;
        try
        {
            // The internal opener tests handle lifetime; production also requires the actual OS parent.
            var result = UpdateParentLease.OpenProcess(process.Id, UpdateTrustTests.Reference, out lease);
            Assert.True(result.Matched, result.Code);
            Assert.NotNull(lease);
            Assert.Equal(process.Id, lease.Identity.Pid);
            Assert.Equal(process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture),
                lease.Identity.CreationFileTime);
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lease.WaitForExitAsync(cancelled.Token));
            Assert.False(lease.HasExited);
            Assert.False(process.HasExited);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var waiting = lease.WaitForExitAsync(deadline.Token);
            Assert.False(waiting.IsCompleted);
            await process.StandardInput.WriteLineAsync("exit");
            await waiting;
            await process.WaitForExitAsync(deadline.Token);
            Assert.Equal(0, process.ExitCode);
            Assert.True(lease.HasExited);
            lease.Dispose();
            lease.Dispose();
            Assert.True(lease.IsDisposed);
            await Assert.ThrowsAsync<ObjectDisposedException>(() => lease.WaitForExitAsync(CancellationToken.None));
        }
        finally
        {
            lease?.Dispose();
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    [Fact]
    public async Task DisposingALiveLeaseReleasesTheHandleWithoutTerminatingTheProcess()
    {
        using var process = StartFixture();
        UpdateParentLease? lease = null;
        try
        {
            var result = UpdateParentLease.OpenProcess(process.Id, UpdateTrustTests.Reference, out lease);
            Assert.True(result.Matched, result.Code);
            Assert.NotNull(lease);
            lease.Dispose();
            lease.Dispose();
            Assert.True(lease.IsDisposed);
            Assert.False(process.HasExited);
            Assert.Throws<ObjectDisposedException>(() => lease.HasExited);
        }
        finally
        {
            lease?.Dispose();
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    [Fact]
    public async Task RejectsADifferentExecutableIdentityWithoutStoppingTheObservedProcess()
    {
        using var process = StartFixture();
        try
        {
            var result = UpdateParentLease.OpenProcess(process.Id,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"), out var lease);
            Assert.False(result.Matched);
            Assert.Equal("update_parent_mismatch", result.Code);
            Assert.Null(lease);
            Assert.False(process.HasExited);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    private static Process StartFixture()
    {
        var start = new ProcessStartInfo(UpdateTrustTests.Reference)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true
        };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "[Console]::ReadLine() | Out-Null; exit 0" })
            start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new InvalidOperationException("The process identity fixture did not start.");
    }
}
