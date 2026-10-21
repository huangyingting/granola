using System.Buffers.Binary;
using NAudio.Wave;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class ConversionTests
{
    [Theory]
    [InlineData(16_000, 1)]
    [InlineData(44_100, 2)]
    [InlineData(48_000, 2)]
    [InlineData(48_000, 6)]
    public void StreamingSyntheticSineConvertsToMonoPcm16(int rate, int channels)
    {
        var converter = new PcmConverter(WaveFormat.CreateIeeeFloatWaveFormat(rate, channels));
        using var output = new MemoryStream();
        for (var frame = 0; frame < 20; frame++)
        {
            var count = rate / 20;
            var bytes = new byte[count * channels * 4];
            for (var sample = 0; sample < count; sample++)
            {
                var value = (float)(0.25 * Math.Sin(2 * Math.PI * 440 * (frame * count + sample) / rate));
                for (var channel = 0; channel < channels; channel++)
                    BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan((sample * channels + channel) * 4), value);
            }
            converter.Convert(bytes, (pcm, length) => output.Write(pcm, 0, length));
        }
        Assert.InRange(output.Length / 2, 15_950, 16_050);
        var pcmOutput = output.ToArray();
        Assert.Contains(pcmOutput, value => value != 0);
        Assert.True(pcmOutput.Length % 2 == 0);
    }

    [Fact]
    public void SilenceRemainsSilenceAndDoesNotBecomeAnInfiniteRead()
    {
        var converter = new PcmConverter(new WaveFormat(16_000, 16, 1));
        using var output = new MemoryStream();
        converter.Convert(new byte[1600], (pcm, count) => output.Write(pcm, 0, count));
        Assert.Equal(new byte[1600], output.ToArray());
    }

    [Fact]
    public void RejectsUnsupportedEndpointFormatsAndNonFiniteSamples()
    {
        Assert.Throws<AudioException>(() => new PcmConverter(WaveFormat.CreateIeeeFloatWaveFormat(384_000, 2)));
        var converter = new PcmConverter(WaveFormat.CreateIeeeFloatWaveFormat(16_000, 1));
        var invalid = new byte[4];
        BinaryPrimitives.WriteSingleLittleEndian(invalid, float.NaN);
        Assert.Equal("invalid_audio", Assert.Throws<AudioException>(() => converter.Convert(invalid, (_, _) => { })).Code);
    }
}
