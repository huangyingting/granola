using System.Buffers;
using System.Security.AccessControl;
using System.Security.Cryptography;

namespace WindowsAiNotes.AudioHost;

public sealed record StagedUpdateRuntime(string Directory, string Executable, int Files, long Bytes, string Sha256);
public sealed record UpdateRuntimeResult(int Version, bool Staged, string Code, StagedUpdateRuntime? Runtime)
{
    public static UpdateRuntimeResult Rejected(string code) => new(1, false, code, null);
}

public static class UpdateRuntimeStager
{
    internal const int MaximumFiles = 512;
    internal const long MaximumBytes = 512 * 1024 * 1024;
    internal static readonly string[] RequiredFiles =
    [
        "AudioHost.exe", "AudioHost.dll", "AudioHost.Core.dll", "AudioHost.deps.json",
        "AudioHost.runtimeconfig.json", "coreclr.dll", "hostfxr.dll", "hostpolicy.dll",
        "System.Private.CoreLib.dll", "licenses/dotnet/LICENSE.TXT", "licenses/dotnet/THIRD-PARTY-NOTICES.TXT"
    ];

    public static UpdateRuntimeResult Stage(string executable, string version, string product, string parent)
    {
        if (!UpdateInstallationVerifier.CanonicalPath(parent))
            return UpdateRuntimeResult.Rejected("update_worker_arguments");
        var installation = UpdateInstallationVerifier.Verify(executable, version, product);
        if (!installation.Registered || installation.Installation is null)
            return UpdateRuntimeResult.Rejected(installation.Code);
        try
        {
            var runtime = Copy(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory),
                installation.Installation.Directory, parent, RequiredFiles);
            return new(1, true, "update_worker_staged", runtime);
        }
        catch (UpdateRuntimeException error)
        {
            return UpdateRuntimeResult.Rejected(error.Code);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or
            System.ComponentModel.Win32Exception or ArgumentException or System.Security.SecurityException)
        {
            return UpdateRuntimeResult.Rejected("update_worker_unavailable");
        }
    }

    internal static StagedUpdateRuntime Copy(string source, string installation, string parent, string[] required,
        Action<StagedUpdateRuntime>? retain = null)
    {
        if (!OperatingSystem.IsWindows() || !UpdateInstallationVerifier.CanonicalPath(source) ||
            !UpdateInstallationVerifier.CanonicalPath(installation) || !UpdateInstallationVerifier.CanonicalPath(parent) ||
            !UpdatePathLock.IsFixedDiskPath(source) || !UpdatePathLock.IsFixedDiskPath(parent))
            throw new UpdateRuntimeException("update_worker_location");
        var directories = new List<Microsoft.Win32.SafeHandles.SafeFileHandle>();
        using var inventory = UpdateRuntimeInventory.Open(source, required);
        string? staged = null;
        var succeeded = false;
        try
        {
            directories.AddRange(UpdatePathLock.OpenAncestors(parent));
            for (var ancestor = parent; ancestor is not null; ancestor = Path.GetDirectoryName(ancestor))
                if (UpdatePathLock.SameDirectory(ancestor, installation))
                    throw new UpdateRuntimeException("update_worker_location");
            if (new DriveInfo(Path.GetPathRoot(parent)!).AvailableFreeSpace < inventory.Bytes * 2 + 64 * 1024 * 1024)
                throw new UpdateRuntimeException("update_worker_capacity");

            var destination = Path.Combine(parent, $"worker-{Guid.NewGuid():D}");
            new DirectoryInfo(destination).Create(UpdatePrivateDirectory.Security());
            staged = destination;
            directories.Add(UpdatePathLock.OpenDirectory(destination));
            using var manifest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (var (relative, stream) in inventory.Files)
            {
                var target = Path.Combine(destination, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                {
                    var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
                    try
                    {
                        int count;
                        while ((count = stream.Read(buffer)) > 0)
                        {
                            output.Write(buffer, 0, count);
                            digest.AppendData(buffer.AsSpan(0, count));
                        }
                        output.Flush(flushToDisk: true);
                    }
                    finally
                    {
                        ArrayPool<byte>.Shared.Return(buffer);
                    }
                }
                var hash = digest.GetHashAndReset();
                using var copied = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (copied.Length != stream.Length ||
                    !CryptographicOperations.FixedTimeEquals(hash, SHA256.HashData(copied)))
                    throw new UpdateRuntimeException("update_worker_source");
                UpdateRuntimeInventory.Append(manifest, relative, stream.Length, hash);
            }
            var result = new StagedUpdateRuntime(destination, Path.Combine(destination, "AudioHost.exe"),
                inventory.Files.Count, inventory.Bytes, Convert.ToHexStringLower(manifest.GetHashAndReset()));
            UpdateRuntimeState.Stage(destination, result.Sha256);
            retain?.Invoke(result);
            succeeded = true;
            return result;
        }
        finally
        {
            for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
            if (staged is not null && !succeeded) Directory.Delete(staged, recursive: true);
        }

    }
}

internal sealed class UpdateRuntimeException(string code) : IOException("The independent update runtime could not be staged.")
{
    public string Code { get; } = code;
}
