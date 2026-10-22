using System.Security.Cryptography;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateRuntimeLease(UpdateRuntimeInventory inventory) : IDisposable
{
    internal static UpdateRuntimeLease Open(string directory, string installation, string manifest, string[] required)
    {
        if (!ValidManifest(manifest) || !ValidDirectoryName(Path.GetFileName(directory)))
            throw new UpdateRuntimeException("update_worker_arguments");
        var inventory = UpdateRuntimeInventory.Open(directory, required);
        try
        {
            UpdatePrivateDirectory.Require(directory);
            for (var ancestor = directory; ancestor is not null; ancestor = Path.GetDirectoryName(ancestor))
                if (UpdatePathLock.SameDirectory(ancestor, installation))
                    throw new UpdateRuntimeException("update_worker_location");
            if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(inventory.Manifest()), Convert.FromHexString(manifest)))
                throw new UpdateRuntimeException("update_worker_source");
            return new(inventory);
        }
        catch
        {
            inventory.Dispose();
            throw;
        }
    }

    internal static bool ValidManifest(string value) => value.Length == 64 &&
        value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static bool ValidDirectoryName(string name) => name.Length == 43 && name.StartsWith("worker-", StringComparison.Ordinal) &&
        Guid.TryParseExact(name.AsSpan(7), "D", out var id) && name == $"worker-{id:D}" &&
        name[21] == '4' && name[26] is '8' or '9' or 'a' or 'b';

    public void Dispose() => inventory.Dispose();
}
