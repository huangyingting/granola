using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateWorkerPolicyTests
{
    private const string Policy = """{"version":1,"feed_url":"https://updates.example/windows/stable.json","certificate_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","publisher":"Synthetic publisher","product_name":"Windows AI Notes Preview"}""";

    [Fact]
    public void ReadsOnlyIndependentPinsFromTheStrictOriginalPackagedPolicy()
    {
        var policy = UpdateWorkerPolicy.Parse(Encoding.UTF8.GetBytes(Policy));
        Assert.Equal("https://updates.example/windows/stable.json", policy.FeedUrl);
        Assert.Equal(new(new string('a', 64), "Synthetic publisher", "Windows AI Notes Preview", "0.1.1"), policy.Trust("0.1.1"));
    }

    [Theory]
    [InlineData("\"version\":1", "\"version\":2")]
    [InlineData("\"version\":1", "\"version\":1,\"version\":1")]
    [InlineData("\"version\":1", "\"version\":1,\"verified\":true")]
    [InlineData("https://updates.example/windows/stable.json", "http://updates.example/windows/stable.json")]
    [InlineData("https://updates.example/windows/stable.json", "https://user:password@updates.example/windows/stable.json")]
    [InlineData("stable.json", "stable.json?")]
    [InlineData("stable.json", "stable.json#")]
    [InlineData("stable.json", "stable.json?token=synthetic")]
    [InlineData("\"publisher\":\"Synthetic publisher\"", "\"publisher\":null")]
    [InlineData("\"publisher\":\"Synthetic publisher\"", "\"publisher\":\" Synthetic publisher\"")]
    [InlineData("\"product_name\":\"Windows AI Notes Preview\"", "\"product_name\":\"../other\"")]
    [InlineData("aaaaaaaa", "AAAAAAAA")]
    public void RejectsUnknownDuplicateMissingAndUnsafePolicyClaims(string original, string replacement)
    {
        var error = Assert.Throws<UpdateHandoffException>(() =>
            UpdateWorkerPolicy.Parse(Encoding.UTF8.GetBytes(Policy.Replace(original, replacement, StringComparison.Ordinal))));
        Assert.Equal("update_policy_invalid", error.Code);
    }

    [Fact]
    public async Task ValidatesWorkerInputsBeforeAnyProcessOrFilesystemAccess()
    {
        var request = new UpdateWorkerRequest(1234, @"C:\Synthetic\Application.exe", "0.1.0", "0.1.1",
            @"C:\Synthetic\installer.exe", 123, Convert.ToBase64String(new byte[64]), new string('a', 64), @"C:\Synthetic\UserData");
        Assert.True(UpdateInstallerWorker.ValidRequest(request));
        Assert.Equal(request, UpdateWorkerRequest.Parse(JsonSerializer.SerializeToUtf8Bytes(request, AudioJson.Options)));
        foreach (var invalid in new[]
        {
            request with { ParentPid = 0 },
            request with { Application = "relative.exe" },
            request with { Installer = @"C:\Synthetic\..\other.exe" },
            request with { CurrentVersion = "01.1.0" },
            request with { OfferedVersion = "0.1.0" },
            request with { OfferedVersion = "0.0.1" },
            request with { Bytes = 0 },
            request with { Sha512 = "invalid" },
            request with { RuntimeSha256 = new string('A', 64) },
            request with { UserData = "relative" }
        })
        {
            Assert.False(UpdateInstallerWorker.ValidRequest(invalid));
            var result = await UpdateInstallerWorker.RunAsync(invalid, Stream.Null, Stream.Null);
            Assert.False(result.Installed);
            Assert.Equal("update_worker_arguments", result.Code);
            Assert.Null(result.Outcome);
        }
    }

    [Theory]
    [InlineData("\"parent_pid\":1234", "\"parent_pid\":1234,\"parent_pid\":1234")]
    [InlineData("\"parent_pid\":1234", "\"parent_pid\":1234,\"certificate_sha256\":\"attacker-selected\"")]
    [InlineData("\"parent_pid\":1234", "\"parent_pid\":1234,\"arguments\":[\"/allusers\"]")]
    [InlineData("\"application\":\"C:\\\\Synthetic\\\\Application.exe\"", "\"application\":null")]
    public void RejectsAmbiguousOrCallerSelectedAuthorityBeforePreparingTheWorker(string original, string replacement)
    {
        var request = new UpdateWorkerRequest(1234, @"C:\Synthetic\Application.exe", "0.1.0", "0.1.1",
            @"C:\Synthetic\installer.exe", 123, Convert.ToBase64String(new byte[64]), new string('a', 64), @"C:\Synthetic\UserData");
        var json = JsonSerializer.Serialize(request, AudioJson.Options);
        Assert.Contains(original, json);
        Assert.Equal("update_worker_arguments", Assert.Throws<UpdateHandoffException>(() =>
            UpdateWorkerRequest.Parse(Encoding.UTF8.GetBytes(json.Replace(original, replacement, StringComparison.Ordinal)))).Code);
    }

    [Fact]
    public void BuildsOnlyAShellFreeCurrentUserSilentCommandWithTheUnquotedDestinationLast()
    {
        var start = UpdateInstallerWorker.InstallerStart(@"C:\Private cache\installer.exe", @"C:\Installed app with spaces");
        Assert.False(start.UseShellExecute);
        Assert.True(start.CreateNoWindow);
        Assert.Equal(@"C:\Private cache\installer.exe", start.FileName);
        Assert.Equal(@"C:\Private cache", start.WorkingDirectory);
        Assert.Equal(@"/currentuser /S /D=C:\Installed app with spaces", start.Arguments);
        Assert.Empty(start.ArgumentList);
        Assert.DoesNotContain(start.Environment.Keys, key =>
            key.Contains("AZURE", StringComparison.OrdinalIgnoreCase) || key.Contains("TOKEN", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("PASSWORD", StringComparison.OrdinalIgnoreCase) || key.StartsWith("WIN_CSC", StringComparison.OrdinalIgnoreCase));
    }
}
