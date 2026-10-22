using System.Buffers;
using System.Buffers.Binary;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

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
    private static readonly string[] RequiredFiles =
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

    internal static StagedUpdateRuntime Copy(string source, string installation, string parent, string[] required)
    {
        if (!OperatingSystem.IsWindows() || !UpdateInstallationVerifier.CanonicalPath(source) ||
            !UpdateInstallationVerifier.CanonicalPath(installation) || !UpdateInstallationVerifier.CanonicalPath(parent) ||
            !UpdatePathLock.IsFixedDiskPath(source) || !UpdatePathLock.IsFixedDiskPath(parent))
            throw new UpdateRuntimeException("update_worker_location");
        var directories = new List<Microsoft.Win32.SafeHandles.SafeFileHandle>();
        var files = new List<(string Relative, FileStream Stream)>();
        string? staged = null;
        var succeeded = false;
        long bytes = 0;
        try
        {
            LockAncestors(source);
            LockAncestors(parent);
            for (var ancestor = parent; ancestor is not null; ancestor = Path.GetDirectoryName(ancestor))
                if (UpdatePathLock.SameDirectory(ancestor, installation))
                    throw new UpdateRuntimeException("update_worker_location");
            ReadDirectory(source, 0);
            if (files.Count == 0 || required.Any(name => !files.Any(file =>
                string.Equals(file.Relative, name, StringComparison.OrdinalIgnoreCase))))
                throw new UpdateRuntimeException("update_worker_source");
            if (new DriveInfo(Path.GetPathRoot(parent)!).AvailableFreeSpace < bytes * 2 + 64 * 1024 * 1024)
                throw new UpdateRuntimeException("update_worker_capacity");

            using var identity = WindowsIdentity.GetCurrent();
            var owner = identity.User ?? throw new UnauthorizedAccessException("No current-user identity is available.");
            var security = new DirectorySecurity();
            security.SetOwner(owner);
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var sid in new[] { owner, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None, AccessControlType.Allow));
            var destination = Path.Combine(parent, $"worker-{Guid.NewGuid():D}");
            new DirectoryInfo(destination).Create(security);
            staged = destination;
            directories.Add(UpdatePathLock.OpenDirectory(destination));
            using var manifest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (var (relative, stream) in files.OrderBy(file => file.Relative, StringComparer.Ordinal))
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
                manifest.AppendData(Encoding.UTF8.GetBytes(relative + "\0"));
                var size = new byte[8];
                BinaryPrimitives.WriteInt64LittleEndian(size, stream.Length);
                manifest.AppendData(size);
                manifest.AppendData(hash);
            }
            var result = new StagedUpdateRuntime(destination, Path.Combine(destination, "AudioHost.exe"),
                files.Count, bytes, Convert.ToHexStringLower(manifest.GetHashAndReset()));
            succeeded = true;
            return result;
        }
        finally
        {
            foreach (var file in files) file.Stream.Dispose();
            for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
            if (staged is not null && !succeeded) Directory.Delete(staged, recursive: true);
        }

        void LockAncestors(string path)
        {
            var parents = new Stack<string>();
            for (var ancestor = path; ancestor is not null; ancestor = Path.GetDirectoryName(ancestor))
                parents.Push(ancestor);
            foreach (var ancestor in parents) directories.Add(UpdatePathLock.OpenDirectory(ancestor));
        }

        void ReadDirectory(string directory, int depth)
        {
            if (depth > 8 || directories.Count >= MaximumFiles)
                throw new UpdateRuntimeException("update_worker_source");
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                if ((File.GetAttributes(path) & FileAttributes.Directory) != 0)
                {
                    directories.Add(UpdatePathLock.OpenDirectory(path));
                    ReadDirectory(path, depth + 1);
                    continue;
                }
                if (files.Count >= MaximumFiles) throw new UpdateRuntimeException("update_worker_source");
                var handle = UpdatePathLock.OpenFile(path);
                FileStream stream;
                try { stream = new FileStream(handle, FileAccess.Read); }
                catch { handle.Dispose(); throw; }
                files.Add((Path.GetRelativePath(source, path).Replace('\\', '/'), stream));
                var length = stream.Length;
                if (length > MaximumBytes - bytes) throw new UpdateRuntimeException("update_worker_source");
                bytes += length;
            }
        }
    }
}

internal sealed class UpdateRuntimeException(string code) : IOException("The independent update runtime could not be staged.")
{
    public string Code { get; } = code;
}
