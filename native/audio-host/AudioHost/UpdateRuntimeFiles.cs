using System.Security.Cryptography;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateRuntimeFiles(int Version, UpdateRuntimeMember[] Files)
{
    internal const string Filename = "update-runtime-files.json";

    internal string Manifest()
    {
        if (Version != 1 || Files is not { Length: > 0 and <= UpdateRuntimeStager.MaximumFiles })
            throw new UpdateHandoffException("update_cleanup_invalid");
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? previous = null;
        long total = 0;
        foreach (var file in Files)
        {
            if (file is null || !UpdateRuntimeSeal.ValidPath(file.Path) || UpdateRuntimeSeal.IsOperationalFile(file.Path) ||
                file.Path.Equals(UpdateSessionRetention.ReceiptFilename, StringComparison.OrdinalIgnoreCase) ||
                !names.Add(file.Path) || (previous is not null && StringComparer.Ordinal.Compare(previous, file.Path) >= 0) ||
                file.Bytes < 0 || file.Bytes > UpdateRuntimeStager.MaximumBytes - total || !UpdateRuntimeLease.ValidManifest(file.Sha256))
                throw new UpdateHandoffException("update_cleanup_invalid");
            UpdateRuntimeInventory.Append(digest, file.Path, file.Bytes, Convert.FromHexString(file.Sha256));
            previous = file.Path;
            total += file.Bytes;
        }
        return Convert.ToHexStringLower(digest.GetHashAndReset());
    }

    internal void RequireManifest(string expected)
    {
        if (Manifest() != expected || UpdateRuntimeStager.RequiredFiles.Any(required =>
            !Files.Any(file => file.Path.Equals(required, StringComparison.OrdinalIgnoreCase))))
            throw new UpdateHandoffException("update_cleanup_invalid");
    }
}
