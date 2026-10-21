using System.Security.Cryptography;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioTests;

internal sealed class TestKeyProtector : IKeyProtector
{
    private readonly byte[] root = RandomNumberGenerator.GetBytes(32);

    public byte[] Protect(byte[] key)
    {
        var output = new byte[12 + key.Length + 16];
        RandomNumberGenerator.Fill(output.AsSpan(0, 12));
        using var aes = new AesGcm(root, 16);
        aes.Encrypt(output.AsSpan(0, 12), key, output.AsSpan(12, key.Length), output.AsSpan(12 + key.Length, 16));
        return output;
    }

    public byte[] Unprotect(byte[] wrappedKey)
    {
        var key = new byte[wrappedKey.Length - 28];
        using var aes = new AesGcm(root, 16);
        aes.Decrypt(wrappedKey.AsSpan(0, 12), wrappedKey.AsSpan(12, key.Length), wrappedKey.AsSpan(12 + key.Length, 16), key);
        return key;
    }
}
