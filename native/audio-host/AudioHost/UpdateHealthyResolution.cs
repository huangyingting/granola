using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateHealthyReceipt(int Version, string RuntimeSha256, UpdateWorkerOutcome Outcome);

internal static class UpdateHealthyResolution
{
    private static readonly byte[] Entropy = SHA256.HashData(Encoding.UTF8.GetBytes("WindowsAINotes.UpdateHealthy.v1"));

    internal static string Seal(string manifest, UpdateWorkerOutcome outcome)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new UpdateHealthyReceipt(1, manifest, outcome), AudioJson.Options);
        try { return Convert.ToBase64String(ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser)); }
        catch (CryptographicException) { throw new UpdateHandoffException("update_worker_outcome_failed"); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal static void Require(UpdateRuntimeState state, UpdateWorkerOutcome outcome)
    {
        byte[]? bytes = null;
        try
        {
            if (state.Resolution is null) throw new UpdateHandoffException("update_recovery_invalid");
            var wrapped = Convert.FromBase64String(state.Resolution);
            if (Convert.ToBase64String(wrapped) != state.Resolution)
                throw new UpdateHandoffException("update_recovery_invalid");
            bytes = ProtectedData.Unprotect(wrapped, Entropy, DataProtectionScope.CurrentUser);
            if (bytes.Length > 8192) throw new UpdateHandoffException("update_recovery_invalid");
            var receipt = JsonSerializer.Deserialize<UpdateHealthyReceipt>(bytes, UpdateRestartProtocol.Options);
            if (receipt is null || receipt.Version != 1 || receipt.RuntimeSha256 != state.RuntimeSha256 ||
                receipt.Outcome != outcome)
                throw new UpdateHandoffException("update_recovery_invalid");
        }
        catch (Exception error) when (error is CryptographicException or FormatException or JsonException)
        {
            throw new UpdateHandoffException("update_recovery_invalid");
        }
        finally { if (bytes is not null) CryptographicOperations.ZeroMemory(bytes); }
    }
}
