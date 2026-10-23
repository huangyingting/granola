using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateRuntimeProvenance : IDisposable
{
    private readonly UpdateRuntimeInventory inventory;
    internal string ApplicationVersion { get; }
    internal string Manifest => inventory.Manifest();

    private UpdateRuntimeProvenance(UpdateRuntimeInventory inventory, string version)
    {
        this.inventory = inventory;
        ApplicationVersion = version;
    }

    internal static UpdateRuntimeProvenance Open(string directory, string expectedVersion, string certificateSha256, string publisher)
    {
        var inventory = UpdateRuntimeInventory.Open(directory, UpdateRuntimeStager.RequiredFiles);
        try
        {
            foreach (var (_, stream) in inventory.Files) UpdatePathLock.RequireSingleRegularFile(stream.SafeFileHandle);
            var executable = Path.Combine(directory, "AudioHost.exe");
            var metadata = FileVersionInfo.GetVersionInfo(executable);
            if (metadata.ProductName != "AudioHost" || metadata.ProductVersion is not { Length: > 0 and <= 200 })
                throw new UpdateHandoffException("update_runtime_identity");
            var signature = UpdateTrustVerifier.Verify(executable,
                new(certificateSha256, publisher, "AudioHost", metadata.ProductVersion));
            if (!signature.Verified) throw new UpdateHandoffException(signature.Code);
            var bytes = UpdateRuntimeResource.Read(executable)
                ?? throw new UpdateHandoffException("update_runtime_seal_missing");
            var seal = UpdateRuntimeSeal.Parse(bytes);
            if (seal.ApplicationVersion != expectedVersion) throw new UpdateHandoffException("update_runtime_version");
            RequireContents(inventory, seal);
            return new(inventory, seal.ApplicationVersion);
        }
        catch
        {
            inventory.Dispose();
            throw;
        }
    }

    internal static void Seal(string directory, string version)
    {
        if (!UpdateTrustVerifier.IsStableVersion(version)) throw new UpdateHandoffException("update_runtime_version");
        UpdateRuntimeSeal seal;
        using (var inventory = UpdateRuntimeInventory.Open(directory, UpdateRuntimeStager.RequiredFiles))
        {
            foreach (var (_, stream) in inventory.Files) UpdatePathLock.RequireSingleRegularFile(stream.SafeFileHandle);
            if (new[] { UpdateRuntimeState.Filename, UpdateWorkerJournal.Filename }.Any(file => File.Exists(Path.Combine(directory, file))))
                throw new UpdateHandoffException("update_runtime_seal_invalid");
            seal = new(1, version, inventory.Files.Where(file => file.Relative != "AudioHost.exe")
                .Select(file => new UpdateRuntimeMember(file.Relative, file.Stream.Length, Digest(file.Stream))).ToArray());
        }
        var bytes = JsonSerializer.SerializeToUtf8Bytes(seal, AudioJson.Options);
        _ = UpdateRuntimeSeal.Parse(bytes);
        UpdateRuntimeResource.WriteNew(Path.Combine(directory, "AudioHost.exe"), bytes);
        using var final = UpdateRuntimeInventory.Open(directory, UpdateRuntimeStager.RequiredFiles);
        RequireContents(final, seal);
    }

    internal static void RequireContents(UpdateRuntimeInventory inventory, UpdateRuntimeSeal seal)
    {
        var files = inventory.Files.Where(file => file.Relative != "AudioHost.exe").ToArray();
        if (files.Length != seal.Files.Length) throw new UpdateHandoffException("update_runtime_payload_changed");
        for (var index = 0; index < files.Length; index++)
        {
            var (relative, stream) = files[index];
            var member = seal.Files[index];
            if (relative != member.Path || stream.Length != member.Bytes ||
                !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(Digest(stream)), Convert.FromHexString(member.Sha256)))
                throw new UpdateHandoffException("update_runtime_payload_changed");
        }
    }

    private static string Digest(FileStream stream)
    {
        stream.Position = 0;
        var digest = SHA256.HashData(stream);
        stream.Position = 0;
        return Convert.ToHexStringLower(digest);
    }

    public void Dispose() => inventory.Dispose();
}
