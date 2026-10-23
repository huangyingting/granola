using System.Buffers.Binary;
using System.Runtime.InteropServices;
using NAudio.Wave;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class CapturePcmProcessorTests
{
    [Fact]
    public void EntirePcm16RangeRemainsBitExactBeforeOwnedBuffersAreCleared()
    {
        using var processor = new CapturePcmProcessor(new WaveFormat(16_000, 16, 1));
        var source = new byte[65_536 * 2];
        for (int value = short.MinValue; value <= short.MaxValue; value++)
            BinaryPrimitives.WriteInt16LittleEndian(source.AsSpan((value - short.MinValue) * 2), (short)value);
        var expected = source.ToArray();
        byte[]? actual = null;
        processor.Process(source, 0, 4096, (pcm, _, _) => actual = pcm.ToArray());
        Assert.Equal(expected, actual);
        Assert.True(source.AsSpan().IndexOfAnyExcept((byte)0) < 0);
    }

    [Theory]
    [InlineData(8_000, 1)]
    [InlineData(16_000, 1)]
    [InlineData(44_100, 2)]
    [InlineData(48_000, 6)]
    [InlineData(192_000, 32)]
    public void ReusedStagingPreservesStreamingConversionAndClocks(int rate, int channels)
    {
        var format = WaveFormat.CreateIeeeFloatWaveFormat(rate, channels);
        var reference = new PcmConverter(format);
        using var processor = new CapturePcmProcessor(format);
        using var expected = new MemoryStream();
        using var actual = new MemoryStream();
        byte[]? staging = null;
        for (var packet = 0; packet < 20; packet++)
        {
            var bytes = Sine(rate, channels, packet);
            reference.Convert(bytes, (pcm, count) => expected.Write(pcm, 0, count));
            ReadOnlyMemory<byte> borrowed = default;
            var start = 200 + packet * 50;
            processor.Process(bytes, start, start + 50, (pcm, startMs, endMs) =>
            {
                Assert.Equal(start, startMs);
                Assert.Equal(start + 50, endMs);
                Assert.True(MemoryMarshal.TryGetArray(pcm, out var segment));
                Assert.NotNull(segment.Array);
                Assert.Equal(PcmConverter.MaxBufferedSeconds * 16_000 * 2, segment.Array.Length);
                if (staging is null) staging = segment.Array;
                else Assert.Same(staging, segment.Array);
                borrowed = pcm;
                actual.Write(pcm.Span);
            });
            Assert.True(bytes.AsSpan().IndexOfAnyExcept((byte)0) < 0);
            Assert.True(borrowed.Span.IndexOfAnyExcept((byte)0) < 0);
        }
        Assert.Equal(expected.ToArray(), actual.ToArray());
        Assert.Contains(actual.ToArray(), value => value != 0);
    }

    [Fact]
    public void CallbackFailureClearsSourceAndEntireStagingAndIsTerminal()
    {
        using var processor = new CapturePcmProcessor(new WaveFormat(16_000, 16, 1));
        var source = Enumerable.Repeat((byte)0x31, 1600).ToArray();
        byte[]? staging = null;
        var failure = new IOException("Synthetic encrypted storage failure.");
        var error = Assert.Throws<IOException>(() => processor.Process(source, 0, 50, (pcm, _, _) =>
        {
            Assert.True(MemoryMarshal.TryGetArray(pcm, out var segment));
            staging = segment.Array;
            Assert.NotNull(staging);
            Assert.Contains(pcm.ToArray(), value => value != 0);
            staging[^1] = 0x7f;
            throw failure;
        }));
        Assert.Same(failure, error);
        Assert.True(source.AsSpan().IndexOfAnyExcept((byte)0) < 0);
        Assert.NotNull(staging);
        Assert.True(staging.AsSpan().IndexOfAnyExcept((byte)0) < 0);
        var next = Enumerable.Repeat((byte)0x32, 1600).ToArray();
        var called = false;
        Assert.Throws<InvalidOperationException>(() =>
            processor.Process(next, 50, 100, (_, _, _) => called = true));
        Assert.False(called);
        Assert.True(next.AsSpan().IndexOfAnyExcept((byte)0) < 0);
    }

    [Fact]
    public void InvalidAudioClearsOwnedSourceWithoutPublishing()
    {
        using var processor = new CapturePcmProcessor(WaveFormat.CreateIeeeFloatWaveFormat(16_000, 1));
        var source = new byte[4];
        BinaryPrimitives.WriteSingleLittleEndian(source, float.NaN);
        var called = false;
        var error = Assert.Throws<AudioException>(() =>
            processor.Process(source, 0, 1, (_, _, _) => called = true));
        Assert.Equal("invalid_audio", error.Code);
        Assert.False(called);
        Assert.True(source.AsSpan().IndexOfAnyExcept((byte)0) < 0);
    }

    [Theory]
    [InlineData(double.NaN, 50)]
    [InlineData(0, double.PositiveInfinity)]
    [InlineData(-1, 50)]
    [InlineData(50, 49)]
    public void InvalidClocksStillClearOwnedSource(double start, double end)
    {
        using var processor = new CapturePcmProcessor(new WaveFormat(16_000, 16, 1));
        var source = Enumerable.Repeat((byte)0x31, 1600).ToArray();
        var called = false;
        Assert.Throws<InvalidDataException>(() =>
            processor.Process(source, start, end, (_, _, _) => called = true));
        Assert.False(called);
        Assert.True(source.AsSpan().IndexOfAnyExcept((byte)0) < 0);
    }

    [Fact]
    public void SixSecondInputUsesFixedStagingAndLargerInputFailsClosed()
    {
        using var processor = new CapturePcmProcessor(new WaveFormat(16_000, 16, 1));
        var source = Enumerable.Repeat((byte)0x31, PcmConverter.MaxBufferedSeconds * 32_000).ToArray();
        var published = 0;
        processor.Process(source, 0, 6000, (pcm, _, _) => published = pcm.Length);
        Assert.Equal(source.Length, published);
        Assert.True(source.AsSpan().IndexOfAnyExcept((byte)0) < 0);
        var oversized = Enumerable.Repeat((byte)0x32, source.Length + 2).ToArray();
        var called = false;
        Assert.Throws<InvalidOperationException>(() =>
            processor.Process(oversized, 6000, 12_001, (_, _, _) => called = true));
        Assert.False(called);
        Assert.True(oversized.AsSpan().IndexOfAnyExcept((byte)0) < 0);
    }

    [Fact]
    public void DisposeClearsEntireStagingAndRejectsFurtherOwnedInput()
    {
        var processor = new CapturePcmProcessor(new WaveFormat(16_000, 16, 1));
        byte[]? staging = null;
        processor.Process(new byte[1600], 0, 50, (pcm, _, _) =>
        {
            Assert.True(MemoryMarshal.TryGetArray(pcm, out var segment));
            staging = segment.Array;
        });
        Assert.NotNull(staging);
        staging[^1] = 0x7f;
        processor.Dispose();
        processor.Dispose();
        Assert.True(staging.AsSpan().IndexOfAnyExcept((byte)0) < 0);
        var source = Enumerable.Repeat((byte)0x31, 1600).ToArray();
        Assert.Throws<ObjectDisposedException>(() => processor.Process(source, 50, 100, (_, _, _) =>
            throw new InvalidOperationException("A disposed processor must not publish.")));
        Assert.True(source.AsSpan().IndexOfAnyExcept((byte)0) < 0);
    }

    private static byte[] Sine(int rate, int channels, int packet)
    {
        var count = rate / 20;
        var bytes = new byte[count * channels * 4];
        for (var sample = 0; sample < count; sample++)
        {
            var value = (float)(0.25 * Math.Sin(2 * Math.PI * 440 * (packet * count + sample) / rate));
            for (var channel = 0; channel < channels; channel++)
                BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan((sample * channels + channel) * 4), value);
        }
        return bytes;
    }
}
