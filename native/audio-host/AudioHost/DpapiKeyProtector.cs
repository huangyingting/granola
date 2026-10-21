using System.Security.Cryptography;
using System.Text;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

public sealed class DpapiKeyProtector : IKeyProtector
{
    private static readonly byte[] Entropy = SHA256.HashData(Encoding.UTF8.GetBytes("WindowsAiNotes.AudioHost.v1"));
    public byte[] Protect(byte[] key) => ProtectedData.Protect(key, Entropy, DataProtectionScope.CurrentUser);
    public byte[] Unprotect(byte[] wrappedKey) => ProtectedData.Unprotect(wrappedKey, Entropy, DataProtectionScope.CurrentUser);
}
