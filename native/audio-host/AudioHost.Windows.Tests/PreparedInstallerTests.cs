using System.Diagnostics;
using System.Security.Cryptography;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class PreparedInstallerTests
{
    private static string NewRoot() => Path.Combine(Path.GetTempPath(), $"notes-prepared-installer-{Guid.NewGuid():D}");
    private static string Hash(string path) => Convert.ToBase64String(SHA512.HashData(File.ReadAllBytes(path)));

    [Fact]
    public void KeepsActualVerifiedBytesAndEveryLaunchPathComponentLockedUntilDisposed()
    {
        var root = NewRoot();
        var directory = Path.Combine(root, "candidate with spaces");
        var file = Path.Combine(directory, "signed runtime.exe");
        Directory.CreateDirectory(directory);
        PreparedInstaller? prepared = null;
        try
        {
            File.Copy(UpdateTrustTests.Reference, file);
            var hash = Hash(file);
            // Generic mode is internal test coverage of the lock mechanics, not installer acceptance.
            var result = PreparedInstaller.OpenArtifact(file, UpdateTrustTests.ReferencePolicy(),
                new FileInfo(file).Length, hash, installer: false, out prepared);
            Assert.True(result.Verified, result.Code);
            Assert.NotNull(prepared);
            Assert.False(prepared.IsDisposed);
            Assert.Equal(file, prepared.Path);
            Assert.Equal(hash, prepared.Artifact.Sha512);
            Assert.Equal(hash, Hash(file));
            Assert.Throws<IOException>(() => { using var write = File.OpenWrite(file); });
            Assert.Throws<IOException>(() => File.Delete(file));
            Assert.Throws<IOException>(() => File.Move(file, Path.Combine(directory, "replaced.exe")));
            Assert.Throws<IOException>(() => Directory.Move(directory, Path.Combine(root, "moved")));
            Assert.Throws<IOException>(() => Directory.Move(root, root + "-moved"));
            prepared.Dispose();
            prepared.Dispose();
            Assert.True(prepared.IsDisposed);
            var moved = Path.Combine(root, "moved");
            Directory.Move(directory, moved);
            File.Delete(Path.Combine(moved, "signed runtime.exe"));
        }
        finally
        {
            prepared?.Dispose();
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("size")]
    [InlineData("pin")]
    [InlineData("role")]
    public void RejectsMismatchesAndReleasesAllPreparationHandles(string scenario)
    {
        var root = NewRoot();
        Directory.CreateDirectory(root);
        var file = Path.Combine(root, "signed runtime.exe");
        try
        {
            File.Copy(UpdateTrustTests.Reference, file);
            var policy = UpdateTrustTests.ReferencePolicy();
            if (scenario == "pin") policy = policy with { CertificateSha256 = new string('0', 64) };
            var result = PreparedInstaller.OpenArtifact(file, policy,
                new FileInfo(file).Length + (scenario == "size" ? 1 : 0),
                scenario == "digest" ? Convert.ToBase64String(new byte[64]) : Hash(file),
                installer: scenario == "role", out var prepared);
            Assert.False(result.Verified);
            Assert.Null(prepared);
            Assert.Equal(scenario switch
            {
                "pin" => "update_identity_mismatch",
                "role" => "update_installer_mismatch",
                _ => "update_artifact_mismatch"
            }, result.Code);
            File.Delete(file);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("0.1.0", "0.1.0")]
    [InlineData("0.2.0", "0.1.0")]
    [InlineData("01.0.0", "1.0.0")]
    [InlineData("0.0.0", "1.0.0-preview")]
    [InlineData("0.0.0", "65536.0.0")]
    public void PublicInstallerPreparationRejectsSameOlderOrNoncanonicalVersions(string installed, string offered)
    {
        var result = PreparedInstaller.Open(@"C:\Synthetic\installer.exe",
            new(new string('0', 64), "Synthetic publisher", "Synthetic product", offered),
            installed, 100, Convert.ToBase64String(new byte[64]), out var prepared);
        Assert.False(result.Verified);
        Assert.Equal("update_verification_arguments", result.Code);
        Assert.Null(prepared);
    }

    [Theory]
    [InlineData(-1, "invalid")]
    [InlineData(0, "invalid")]
    [InlineData(2147483649, "invalid")]
    [InlineData(100, "invalid")]
    public void RejectsInvalidSizeAndDigestBeforeOpeningPaths(long bytes, string hash)
    {
        var result = PreparedInstaller.Open(@"C:\Synthetic\installer.exe",
            new(new string('0', 64), "Synthetic publisher", "Synthetic product", "0.1.1"),
            "0.1.0", bytes, hash, out var prepared);
        Assert.False(result.Verified);
        Assert.Equal("update_verification_arguments", result.Code);
        Assert.Null(prepared);
    }

    [Fact]
    public async Task RejectsAnActualJunctionWithoutFollowingItOrDeletingItsTarget()
    {
        var root = NewRoot();
        var target = Path.Combine(root, "actual target");
        var junction = Path.Combine(root, "linked parent");
        Directory.CreateDirectory(target);
        var file = Path.Combine(target, "signed runtime.exe");
        try
        {
            File.Copy(UpdateTrustTests.Reference, file);
            var start = new ProcessStartInfo(UpdateTrustTests.Reference)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:NOTES_LINK -Target $env:NOTES_TARGET | Out-Null" })
                start.ArgumentList.Add(argument);
            start.Environment["NOTES_LINK"] = junction;
            start.Environment["NOTES_TARGET"] = target;
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Junction fixture did not start.");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var errors = process.StandardError.ReadToEndAsync(deadline.Token);
            var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
            try
            {
                await process.WaitForExitAsync(deadline.Token);
                Assert.Equal(0, process.ExitCode);
                Assert.Empty(await errors);
                await output;
            }
            finally
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                }

            }
            var result = PreparedInstaller.OpenArtifact(Path.Combine(junction, "signed runtime.exe"),
                UpdateTrustTests.ReferencePolicy(), new FileInfo(file).Length, Hash(file),
                installer: false, out var prepared);
            Assert.False(result.Verified);
            Assert.Equal("update_artifact_invalid", result.Code);
            Assert.Null(prepared);
            Directory.Delete(junction);
            Assert.True(File.Exists(file));
            Assert.Equal(Hash(UpdateTrustTests.Reference), Hash(file));
        }
        finally
        {
            if (Directory.Exists(junction)) Directory.Delete(junction);
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ReadOnlyPreparationAllowsImageCreationWhileTheVerifiedLeaseIsStillHeld()
    {
        var file = UpdateTrustTests.Reference;
        var result = PreparedInstaller.OpenArtifact(file, UpdateTrustTests.ReferencePolicy(),
            new FileInfo(file).Length, Hash(file), installer: false, out var prepared);
        Assert.True(result.Verified, result.Code);
        Assert.NotNull(prepared);
        using (prepared)
        {
            var start = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0" })
                start.ArgumentList.Add(argument);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("The verified image did not start.");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
            var errors = process.StandardError.ReadToEndAsync(deadline.Token);
            try
            {
                await process.WaitForExitAsync(deadline.Token);
                Assert.Equal(0, process.ExitCode);
                Assert.Empty(await output);
                Assert.Empty(await errors);
                Assert.False(prepared.IsDisposed);
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
    }
}
