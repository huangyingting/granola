using System.Threading.Channels;
using NAudio.Wave;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class CaptureQueueTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompletedOrOpenCaptureQueueClearsEveryOwnedPacket(bool completed)
    {
        var packets = Channel.CreateBounded<CaptureTrack.Packet>(64);
        var buffers = Enumerable.Range(0, 64).Select(_ =>
            Enumerable.Repeat((byte)0x31, 1600).ToArray()).ToArray();
        foreach (var bytes in buffers)
            Assert.True(packets.Writer.TryWrite(new CaptureTrack.Packet(bytes, 0, 50)));
        if (completed) packets.Writer.TryComplete();
        Assert.Equal(64 * 1600, CaptureTrack.CompleteAndClear(packets));
        await packets.Reader.Completion.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(packets.Reader.TryRead(out _));
        Assert.False(packets.Writer.TryWrite(new CaptureTrack.Packet([], 50, 100)));
        foreach (var bytes in buffers) Assert.All(bytes, value => Assert.Equal(0, value));
        Assert.Equal(0, CaptureTrack.CompleteAndClear(packets));
    }

    [Fact]
    public async Task ProcessingFailureClearsActiveAndRemainingQueuedPcm()
    {
        using var processor = new CapturePcmProcessor(new WaveFormat(16_000, 16, 1));
        var packets = Channel.CreateBounded<CaptureTrack.Packet>(64);
        var active = Enumerable.Repeat((byte)0x31, 1600).ToArray();
        var pending = Enumerable.Repeat((byte)0x32, 3200).ToArray();
        Assert.True(packets.Writer.TryWrite(new CaptureTrack.Packet(active, 0, 50)));
        Assert.True(packets.Writer.TryWrite(new CaptureTrack.Packet(pending, 50, 150)));
        var packet = await packets.Reader.ReadAsync();
        try
        {
            Assert.Throws<IOException>(() =>
                processor.Process(packet.Bytes, packet.StartMs, packet.EndMs, (_, _, _) =>
                    throw new IOException("Synthetic capture consumer failure.")));
        }
        finally
        {
            Assert.Equal(3200, CaptureTrack.CompleteAndClear(packets));
        }
        Assert.All(active, value => Assert.Equal(0, value));
        Assert.All(pending, value => Assert.Equal(0, value));
        await packets.Reader.Completion.WaitAsync(TimeSpan.FromSeconds(5));
    }
}
