using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class UpdateHandoffTests
{
    [Theory]
    [InlineData("commit")]
    [InlineData("cancel")]
    public void AcceptsOnlyOneFreshMatchingDecision(string operation)
    {
        var challenge = new UpdateHandoffChallenge();
        Assert.Matches("^[0-9a-f]{64}$", challenge.Value);
        Assert.NotEqual(challenge.Value, new UpdateHandoffChallenge().Value);
        var message = JsonSerializer.SerializeToUtf8Bytes(new UpdateHandoffDecision(1, operation, challenge.Value), AudioJson.Options);
        Assert.Equal(operation, challenge.Consume(message));
        Assert.Equal("update_handoff_consumed", Assert.Throws<UpdateHandoffException>(() => challenge.Consume(message)).Code);
    }

    [Fact]
    public void RejectsReplayedChallengesAndConsumesFailedAttempts()
    {
        var original = new UpdateHandoffChallenge();
        var current = new UpdateHandoffChallenge();
        var replay = JsonSerializer.SerializeToUtf8Bytes(new UpdateHandoffDecision(1, "commit", original.Value), AudioJson.Options);
        Assert.Equal("update_handoff_challenge", Assert.Throws<UpdateHandoffException>(() => current.Consume(replay)).Code);
        var correct = JsonSerializer.SerializeToUtf8Bytes(new UpdateHandoffDecision(1, "commit", current.Value), AudioJson.Options);
        Assert.Equal("update_handoff_consumed", Assert.Throws<UpdateHandoffException>(() => current.Consume(correct)).Code);
    }

    [Fact]
    public async Task DoesNotConsumeTheSameChallengeTwiceEvenUnderConcurrentCalls()
    {
        var challenge = new UpdateHandoffChallenge();
        var message = JsonSerializer.SerializeToUtf8Bytes(new UpdateHandoffDecision(1, "commit", challenge.Value), AudioJson.Options);
        var results = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ => Task.Run(() =>
        {
            try { return challenge.Consume(message); }
            catch (UpdateHandoffException error) { return error.Code; }
        })));
        Assert.Single(results, result => result == "commit");
        Assert.Equal(31, results.Count(result => result == "update_handoff_consumed"));
    }

    [Theory]
    [InlineData("""{"version":2,"operation":"commit","challenge":"CHALLENGE"}""")]
    [InlineData("""{"version":1,"operation":"install","challenge":"CHALLENGE"}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":"CHALLENGE","installer":"other.exe"}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":null}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":1}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":"short"}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}""")]
    [InlineData("""{"version":1,"operation":"commit"}""")]
    [InlineData("""{"operation":"commit","challenge":"CHALLENGE"}""")]
    [InlineData("""{"version":1,"operation":"cancel","operation":"commit","challenge":"CHALLENGE"}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":"CHALLENGE","challenge":"CHALLENGE"}""")]
    [InlineData("""{"version":1,"operation":"commit","challenge":"CHALLENGE"}{}""")]
    [InlineData("""[]""")]
    [InlineData("""null""")]
    [InlineData("""not-json""")]
    public void RejectsMalformedUnknownMissingAndDuplicateClaims(string template)
    {
        var challenge = new UpdateHandoffChallenge();
        var message = Encoding.UTF8.GetBytes(template.Replace("CHALLENGE", challenge.Value, StringComparison.Ordinal));
        Assert.Equal("update_handoff_protocol", Assert.Throws<UpdateHandoffException>(() => challenge.Consume(message)).Code);
    }

    [Fact]
    public async Task UsesTheExistingFrameFormatWithASmallerBoundAndPreservesAudioFraming()
    {
        var challenge = new UpdateHandoffChallenge();
        using var stream = new MemoryStream();
        await FrameCodec.WriteJsonAsync(stream, new UpdateHandoffDecision(1, "commit", challenge.Value));
        stream.Position = 0;
        Assert.Equal("commit", challenge.Consume((await FrameCodec.ReadAsync(stream, UpdateHandoffChallenge.MaximumMessageBytes))!));
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, UpdateHandoffChallenge.MaximumMessageBytes + 1);
        Assert.Equal("invalid_frame", (await Assert.ThrowsAsync<AudioException>(
            () => FrameCodec.ReadAsync(new MemoryStream(header), UpdateHandoffChallenge.MaximumMessageBytes))).Code);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => FrameCodec.ReadAsync(stream, 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => FrameCodec.ReadAsync(stream, FrameCodec.MaxControlBytes + 1));
    }

    [Fact]
    public void BoundsTheRawDecisionBeforeDeserializing()
    {
        foreach (var message in new[] { Array.Empty<byte>(), new byte[UpdateHandoffChallenge.MaximumMessageBytes + 1] })
        {
            var challenge = new UpdateHandoffChallenge();
            Assert.Equal("update_handoff_protocol", Assert.Throws<UpdateHandoffException>(() => challenge.Consume(message)).Code);
        }
    }
}
