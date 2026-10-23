using System.Buffers.Binary;
using System.Security.Cryptography;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace WindowsAiNotes.Audio;

public sealed class PcmConverter
{
    public const int MaxBufferedSeconds = 6;
    private readonly BufferedWaveProvider source;
    private readonly ISampleProvider normalized;
    private readonly float[] samples = new float[1600];
    private readonly byte[] pcm = new byte[3200];

    public PcmConverter(WaveFormat format)
    {
        if (format.Channels is < 1 or > 32 || format.SampleRate is < 8_000 or > 192_000)
            throw new AudioException("unsupported_format", "The endpoint format is outside the supported probe range.");
        source = new BufferedWaveProvider(format)
        {
            BufferLength = checked(format.AverageBytesPerSecond * MaxBufferedSeconds),
            ReadFully = false,
            DiscardOnBufferOverflow = false
        };
        ISampleProvider mono = new DownmixProvider(source.ToSampleProvider());
        normalized = mono.WaveFormat.SampleRate == 16_000 ? mono : new WdlResamplingSampleProvider(mono, 16_000);
    }

    public void Convert(byte[] bytes, Action<byte[], int> consume)
    {
        try
        {
            source.AddSamples(bytes, 0, bytes.Length);
            int count;
            while ((count = normalized.Read(samples, 0, samples.Length)) > 0)
            {
                for (var i = 0; i < count; i++)
                {
                    if (!float.IsFinite(samples[i]))
                        throw new AudioException("invalid_audio", "The endpoint returned non-finite audio samples.");
                    var value = (short)Math.Clamp((int)Math.Round(samples[i] * 32768.0), short.MinValue, short.MaxValue);
                    BinaryPrimitives.WriteInt16LittleEndian(pcm.AsSpan(i * 2), value);
                }
                consume(pcm, count * 2);
            }
        }
        finally
        {
            Array.Clear(samples);
            CryptographicOperations.ZeroMemory(pcm);
        }
    }

    private sealed class DownmixProvider(ISampleProvider source) : ISampleProvider
    {
        private float[] input = [];
        public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);

        public int Read(float[] buffer, int offset, int count)
        {
            var channels = source.WaveFormat.Channels;
            var required = checked(count * channels);
            if (input.Length < required) input = new float[required];
            try
            {
                var read = source.Read(input, 0, required);
                if (read % channels != 0) throw new InvalidDataException("The endpoint returned an incomplete audio frame.");
                for (var frame = 0; frame < read / channels; frame++)
                {
                    double sum = 0;
                    for (var channel = 0; channel < channels; channel++)
                        sum += input[frame * channels + channel];
                    buffer[offset + frame] = (float)(sum / channels);
                }
                return read / channels;
            }
            finally
            {
                Array.Clear(input);
            }
        }
    }
}
