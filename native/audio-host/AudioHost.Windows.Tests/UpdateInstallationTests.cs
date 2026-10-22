using WindowsAiNotes.AudioHost;
using System.Diagnostics;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateInstallationTests
{
    private const string Directory = @"C:\Synthetic installed app";
    private const string Product = "Windows AI Notes Preview";
    private static readonly UpdateRegistration Registration = new(Directory, $"{Product} 0.1.0", "0.1.0",
        $"\"{Directory}\\Uninstall {Product}.exe\" /currentuser",
        $"\"{Directory}\\Uninstall {Product}.exe\" /currentuser /S");

    [Fact]
    public void MatchesOnlyTheExactPerUserLocationVersionAndUninstallCommands()
    {
        Assert.True(UpdateInstallationVerifier.Matches(Registration, Directory, "0.1.0", Product));
        Assert.True(UpdateInstallationVerifier.Matches(Registration with { Location = Directory.ToLowerInvariant() },
            Directory, "0.1.0", Product));
        foreach (var changed in new[]
        {
            Registration with { Location = null },
            Registration with { Location = @"C:\Different" },
            Registration with { Location = Directory + @"\.." },
            Registration with { DisplayName = "Different product" },
            Registration with { DisplayName = Product },
            Registration with { DisplayName = $"{Product} 0.1.1" },
            Registration with { DisplayVersion = "0.1.1" },
            Registration with { Uninstall = null },
            Registration with { Uninstall = $"\"{Directory}\\Uninstall {Product}.exe\" /allusers" },
            Registration with { Uninstall = Registration.Uninstall + " --delete-app-data" },
            Registration with { QuietUninstall = Registration.QuietUninstall + " extra" },
            Registration with { QuietUninstall = Registration.QuietUninstall!.Replace("/S", "/s", StringComparison.Ordinal) }
        })
            Assert.False(UpdateInstallationVerifier.Matches(changed, Directory, "0.1.0", Product));
    }

    [Theory]
    [InlineData("relative.exe")]
    [InlineData(@"\\server\share\app.exe")]
    [InlineData(@"\\?\C:\app.exe")]
    [InlineData(@"C:\app.exe:stream")]
    [InlineData(@"C:\folder\..\app.exe")]
    [InlineData(@"C:\folder.\app.exe")]
    [InlineData(@"C:\folder \app.exe")]
    [InlineData(@"C:\folder\\app.exe")]
    [InlineData("C:\\app.exe\n")]
    [InlineData(@"C:/folder/app.exe")]
    public void RejectsAmbiguousNonlocalOrNoncanonicalPaths(string path)
    {
        Assert.False(UpdateInstallationVerifier.CanonicalPath(path));
    }

    [Theory]
    [InlineData("0.1.0", true)]
    [InlineData("65535.65535.65535", true)]
    [InlineData("0.1.0.0", false)]
    [InlineData("01.1.0", false)]
    [InlineData("0.1.0-preview", false)]
    [InlineData("0.1.0\n", false)]
    [InlineData("65536.0.0", false)]
    public void UsesTheSameCanonicalStableVersionBoundsAsTheDesktop(string value, bool valid)
    {
        Assert.Equal(valid, UpdateTrustVerifier.IsStableVersion(value));
    }

    [Fact]
    public void InvalidRequestsReturnStructuredRejectionsWithoutResettingStorage()
    {
        foreach (var request in new[]
        {
            ("relative.exe", "0.1.0", Product),
            ($"{Directory}\\{Product}.exe", "01.1.0", Product),
            ($"{Directory}\\other.exe", "0.1.0", Product),
            ($"{Directory}\\{Product}.exe", "0.1.0", "../different")
        })
        {
            var result = UpdateInstallationVerifier.Verify(request.Item1, request.Item2, request.Item3);
            Assert.False(result.Registered);
            Assert.Equal("update_installation_arguments", result.Code);
            Assert.Null(result.Installation);
        }
    }

    [Fact]
    public void ComparesActualDirectoryIdentitiesInsteadOfOnlyCaseFoldedOrShortPathStrings()
    {
        var root = Path.Combine(Path.GetTempPath(), $"notes-installation-identity-{Guid.NewGuid():D}");
        var first = Path.Combine(root, "first");
        var second = Path.Combine(root, "second");
        System.IO.Directory.CreateDirectory(first);
        System.IO.Directory.CreateDirectory(second);
        try
        {
            Assert.True(UpdatePathLock.SameDirectory(first, first));
            Assert.True(UpdatePathLock.SameDirectory(first, first.ToUpperInvariant()));
            Assert.False(UpdatePathLock.SameDirectory(first, second));
        }
        finally
        {
            System.IO.Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task InvalidOneShotInspectionArgumentsReturnBoundedStructuredRejection()
    {
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in new[] { typeof(UpdateInstallationVerifier).Assembly.Location,
                    "--verify-update-installation", "relative.exe" })
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Installation inspection did not start.");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
        var errors = process.StandardError.ReadToEndAsync(deadline.Token);
        try
        {
            await process.WaitForExitAsync(deadline.Token);
            Assert.Equal(2, process.ExitCode);
            var text = await output;
            Assert.True(text.Length < 4096);
            var result = JsonSerializer.Deserialize<UpdateInstallationResult>(text, AudioJson.Options);
            Assert.NotNull(result);
            Assert.Equal(1, result.Version);
            Assert.False(result.Registered);
            Assert.Equal("update_installation_arguments", result.Code);
            Assert.Null(result.Installation);
            Assert.Empty(await errors);
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
