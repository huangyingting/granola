using System.Buffers.Binary;
using System.Security.Cryptography;

namespace WindowsAiNotes.Audio;

public sealed class PcmChunkWriter(RecordingStore store, Guid trackId)
{
    public const int MaxSamples = 16_000 * 30;
    private readonly MemoryStream pending = new(MaxSamples * 2);
    private int sequence;
    private long savedSamples;
    private Guid epoch;
    private double clockStart;
    private double clockEnd;

    public void BeginEpoch(Guid captureEpoch)
    {
        if (pending.Length != 0) throw new InvalidOperationException("Seal the old epoch before starting another.");
        epoch = captureEpoch;
    }

    public void Append(ReadOnlySpan<byte> pcm, double startMs, double endMs)
    {
        if (epoch == Guid.Empty || pcm.Length % 2 != 0 || !double.IsFinite(startMs)
            || !double.IsFinite(endMs) || startMs < 0 || endMs < startMs)
            throw new InvalidDataException("Invalid PCM frame or clock range.");
        var consumed = 0;
        while (consumed < pcm.Length)
        {
            var count = Math.Min(MaxSamples * 2 - (int)pending.Length, pcm.Length - consumed);
            if (pending.Length == 0)
                clockStart = startMs + (endMs - startMs) * consumed / pcm.Length;
            pending.Write(pcm.Slice(consumed, count));
            consumed += count;
            clockEnd = startMs + (endMs - startMs) * consumed / pcm.Length;
            if (pending.Length == MaxSamples * 2) Flush();
        }
    }

    public void Flush()
    {
        if (pending.Length == 0) return;
        var pcm = pending.GetBuffer().AsSpan(0, (int)pending.Length);
        var chunk = new ChunkMetadata(1, store.RecordingId, trackId, Guid.NewGuid(), epoch,
            sequence, savedSamples, pcm.Length / 2, 16_000, 1, 16, clockStart, clockEnd,
            Convert.ToHexStringLower(SHA256.HashData(pcm)));
        store.Commit(chunk, pcm);
        savedSamples += chunk.SampleCount;
        sequence++;
        CryptographicOperations.ZeroMemory(pcm);
        pending.SetLength(0);
    }

    public static byte[] ToWav(ReadOnlySpan<byte> pcm)
    {
        if (pcm.Length % 2 != 0 || pcm.Length > MaxSamples * 2)
            throw new InvalidDataException("Invalid PCM chunk size.");
        var wav = new byte[44 + pcm.Length];
        "RIFF"u8.CopyTo(wav);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(4), 36 + pcm.Length);
        "WAVEfmt "u8.CopyTo(wav.AsSpan(8));
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(16), 16);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(20), 1);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(22), 1);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(24), 16_000);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(28), 32_000);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(32), 2);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(34), 16);
        "data"u8.CopyTo(wav.AsSpan(36));
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(40), pcm.Length);
        pcm.CopyTo(wav.AsSpan(44));
        return wav;
    }
}
