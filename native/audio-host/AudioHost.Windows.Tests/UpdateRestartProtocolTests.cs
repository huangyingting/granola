using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateRestartProtocolTests
{
    private static UpdateRestartChallenge Binding() => new(1, "update_restart_challenge",
        "11111111-1111-4111-8111-111111111111", new('a', 64), new(1234, "134000000000000001"), "0.1.1");

    [Fact]
    public void RequiresExactSessionEndpointKindNonceAndCanonicalLowercaseBinding()
    {
        var binding = Binding();
        Assert.True(UpdateRestartProtocol.ValidBinding(binding));
        var session = Guid.Parse(binding.SessionId);
        var endpoint = UpdateRestartProtocol.Endpoint(session, "RestartAuth");
        Assert.True(UpdateRestartProtocol.ValidEndpoint(endpoint, session, "RestartAuth"));
        Assert.False(UpdateRestartProtocol.ValidEndpoint(endpoint, Guid.NewGuid(), "RestartAuth"));
        Assert.False(UpdateRestartProtocol.ValidEndpoint(endpoint, session, "Restart"));
        Assert.False(UpdateRestartProtocol.ValidEndpoint(endpoint + "\\extra", session, "RestartAuth"));
        Assert.False(UpdateRestartProtocol.ValidEndpoint(endpoint.ToUpperInvariant(), session, "RestartAuth"));
        Assert.False(UpdateRestartProtocol.ValidBinding(binding with { Identity = new(1234, "0134") }));
        Assert.False(UpdateRestartProtocol.ValidBinding(binding with { SessionId = Guid.Empty.ToString("D") }));
        Assert.False(UpdateRestartProtocol.ValidBinding(binding with { ApplicationVersion = "0.1.1-preview" }));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("event")]
    [InlineData("session")]
    [InlineData("health-challenge")]
    [InlineData("auth-challenge")]
    [InlineData("pid")]
    [InlineData("creation")]
    [InlineData("application")]
    public void BothChannelsMustMatchTheExactFreshBinding(string fault)
    {
        var binding = Binding();
        var challenge = new string('b', 64);
        var message = UpdateRestartProtocol.Message(binding, "update_restart_auth_ready", challenge);
        Assert.True(UpdateRestartProtocol.Matches(message, binding, "update_restart_auth_ready", challenge));
        message = fault switch
        {
            "version" => message with { Version = 2 },
            "event" => message with { Event = "update_restart_auth_admitted" },
            "session" => message with { SessionId = Guid.NewGuid().ToString("D") },
            "health-challenge" => message with { Challenge = new('c', 64) },
            "auth-challenge" => message with { AuthChallenge = new('c', 64) },
            "pid" => message with { Identity = message.Identity with { Pid = 1235 } },
            "creation" => message with { Identity = message.Identity with { CreationFileTime = "134000000000000002" } },
            _ => message with { ApplicationVersion = "0.1.2" }
        };
        Assert.False(UpdateRestartProtocol.Matches(message, binding, "update_restart_auth_ready", challenge));
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("unknown")]
    [InlineData("missing")]
    [InlineData("null")]
    [InlineData("identity")]
    [InlineData("fraction")]
    [InlineData("malformed")]
    public async Task NativeAuthenticationMessagesRejectAmbiguousOrExtendedJson(string fault)
    {
        var message = UpdateRestartProtocol.Message(Binding(), "update_restart_auth_ready", new('b', 64));
        var json = JsonSerializer.Serialize(message, AudioJson.Options);
        json = fault switch
        {
            "duplicate" => json.Replace("\"version\":1", "\"version\":1,\"version\":1", StringComparison.Ordinal),
            "unknown" => json.Replace("\"version\":1", "\"version\":1,\"admission\":true", StringComparison.Ordinal),
            "missing" => json.Replace("\"version\":1,", "", StringComparison.Ordinal),
            "null" => json.Replace($"\"{message.AuthChallenge}\"", "null", StringComparison.Ordinal),
            "identity" => json.Replace("\"pid\":1234", "\"pid\":1234,\"handle\":42", StringComparison.Ordinal),
            "fraction" => json.Replace("\"pid\":1234", "\"pid\":1234.5", StringComparison.Ordinal),
            _ => "{"
        };
        using var stream = new MemoryStream();
        var bytes = Encoding.UTF8.GetBytes(json);
        await stream.WriteAsync(BitConverter.GetBytes(bytes.Length));
        await stream.WriteAsync(bytes);
        stream.Position = 0;
        Assert.Equal("update_restart_protocol", (await Assert.ThrowsAsync<UpdateHandoffException>(() =>
            UpdateRestartProtocol.ReadAsync<UpdateRestartAuthentication>(stream, CancellationToken.None))).Code);
    }
}
