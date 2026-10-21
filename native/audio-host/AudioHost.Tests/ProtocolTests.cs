using System.Buffers.Binary;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class ProtocolTests
{
    [Fact]
    public void SharedRequestVectorsMatchTypeScriptValidation()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "requests.json")));
        foreach (var vector in document.RootElement.EnumerateArray())
        {
            var valid = true;
            try
            {
                var request = vector.GetProperty("request").Deserialize<AudioRequest>(AudioJson.Options);
                Assert.NotNull(request);
                request.Validate();
            }
            catch (Exception error) when (error is JsonException or AudioException)
            {
                valid = false;
            }
            Assert.Equal(vector.GetProperty("valid").GetBoolean(), valid);
        }
    }
    [Fact]
    public async Task FrameRoundTripsAndEofIsDistinctFromTruncation()
    {
        using var stream = new MemoryStream();
        var message = new AudioEvent(1, Guid.NewGuid(), null, "devices", new { Devices = Array.Empty<DeviceInfo>() });
        await FrameCodec.WriteAsync(stream, message);
        stream.Position = 0;
        var body = await FrameCodec.ReadAsync(stream);
        Assert.NotNull(body);
        using var json = JsonDocument.Parse(body);
        Assert.Equal("devices", json.RootElement.GetProperty("event_type").GetString());
        Assert.Null(await FrameCodec.ReadAsync(stream));
        await Assert.ThrowsAsync<EndOfStreamException>(() => FrameCodec.ReadAsync(new MemoryStream([1, 0])));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65_537)]
    [InlineData(int.MaxValue)]
    public async Task RejectsOversizedFrameBeforeAllocatingBody(int length)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, length);
        var error = await Assert.ThrowsAsync<AudioException>(() => FrameCodec.ReadAsync(new MemoryStream(header)));
        Assert.Equal("invalid_frame", error.Code);
    }

    [Fact]
    public void ScopeAndPathBoundariesAreValidatedInTheNativeProcess()
    {
        var track = new TrackSpec(Guid.NewGuid(), "loopback", "endpoint", "default", "default");
        var request = new AudioRequest(1, Guid.NewGuid(), "start_recording", Guid.NewGuid(), [track]);
        request.Validate();
        foreach (var invalid in new[]
        {
            request with { ProtocolVersion = 2 },
            request with { Tracks = [track with { CaptureScope = "process_tree" }] },
            request with { Tracks = [track, track] },
            request with { Tracks = [track with { DeviceSelectionPolicy = "explicit" }] },
            request with { Tracks = [null!] }
        })
            Assert.Throws<AudioException>(invalid.Validate);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AudioRequest>(
            """{"protocol_version":1,"request_id":"9c73575e-426d-4f72-98ed-7b4479f890ab","command":"list_devices","path":"../../outside"}""", AudioJson.Options));
    }
}
