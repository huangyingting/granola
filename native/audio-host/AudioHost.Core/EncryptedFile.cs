using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;

namespace WindowsAiNotes.Audio;

public sealed record EnvelopeHeader(
    int FormatVersion, Guid RecordingId, string Kind, int PlaintextSize,
    string WrappedKey, string Nonce, ChunkMetadata? Chunk);

public static class EncryptedFile
{
    private static ReadOnlySpan<byte> Magic => "WNOTE001"u8;
    private const int MaxHeaderBytes = 64 * 1024;
    private const int MaxPayloadBytes = 4 * 1024 * 1024;

    public static void Write(string path, Guid recordingId, string kind, ChunkMetadata? chunk, ReadOnlySpan<byte> plaintext, IKeyProtector protector)
    {
        if (plaintext.Length > MaxPayloadBytes)
            throw new AudioException("storage_limit", "Encrypted payload exceeds the supported size.");
        var key = RandomNumberGenerator.GetBytes(32);
        try
        {
            var nonce = RandomNumberGenerator.GetBytes(12);
            var header = new EnvelopeHeader(1, recordingId, kind, plaintext.Length,
                Convert.ToBase64String(protector.Protect(key)), Convert.ToBase64String(nonce), chunk);
            var aad = JsonSerializer.SerializeToUtf8Bytes(header, AudioJson.Options);
            if (aad.Length > MaxHeaderBytes)
                throw new AudioException("storage_limit", "Encrypted header exceeds the supported size.");
            var ciphertext = new byte[plaintext.Length];
            var tag = new byte[16];
            using (var aes = new AesGcm(key, 16))
                aes.Encrypt(nonce, plaintext, ciphertext, tag, aad);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".partial";
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                file.Write(Magic);
                Span<byte> length = stackalloc byte[4];
                BinaryPrimitives.WriteInt32LittleEndian(length, aad.Length);
                file.Write(length);
                file.Write(aad);
                file.Write(ciphertext);
                file.Write(tag);
                file.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: kind == "manifest");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public static (EnvelopeHeader Header, byte[] Plaintext) Read(string path, Guid recordingId, string kind, IKeyProtector protector)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        Span<byte> prefix = stackalloc byte[12];
        file.ReadExactly(prefix);
        if (!prefix[..8].SequenceEqual(Magic))
            throw new InvalidDataException("Unknown encrypted file format.");
        var headerLength = BinaryPrimitives.ReadInt32LittleEndian(prefix[8..]);
        if (headerLength is <= 0 or > MaxHeaderBytes)
            throw new InvalidDataException("Invalid encrypted header length.");
        var aad = new byte[headerLength];
        file.ReadExactly(aad);
        var header = JsonSerializer.Deserialize<EnvelopeHeader>(aad, AudioJson.Options)
            ?? throw new InvalidDataException("Missing encrypted header.");
        if (header.FormatVersion != 1 || header.RecordingId != recordingId || header.Kind != kind
            || header.PlaintextSize is < 0 or > MaxPayloadBytes
            || file.Length != 12L + headerLength + header.PlaintextSize + 16)
            throw new InvalidDataException("Encrypted file is truncated or has invalid bounds.");
        byte[] key;
        try
        {
            key = protector.Unprotect(Convert.FromBase64String(header.WrappedKey));
        }
        catch (CryptographicException error)
        {
            throw new AudioException("key_unavailable", "The recording key cannot be unlocked by this Windows account.", inner: error);
        }
        try
        {
            var ciphertext = new byte[header.PlaintextSize];
            file.ReadExactly(ciphertext);
            var tag = new byte[16];
            file.ReadExactly(tag);
            var plaintext = new byte[header.PlaintextSize];
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(Convert.FromBase64String(header.Nonce), ciphertext, tag, plaintext, aad);
            return (header, plaintext);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }
}
