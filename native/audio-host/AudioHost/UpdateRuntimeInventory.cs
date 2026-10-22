using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

internal sealed class UpdateRuntimeInventory : IDisposable
{
    private readonly List<SafeFileHandle> directories = [];
    private readonly List<(string Relative, FileStream Stream)> files = [];
    internal IReadOnlyList<(string Relative, FileStream Stream)> Files => files;
    internal long Bytes { get; private set; }

    internal static UpdateRuntimeInventory Open(string directory, string[] required)
    {
        if (!OperatingSystem.IsWindows() || !UpdateInstallationVerifier.CanonicalPath(directory) ||
            !UpdatePathLock.IsFixedDiskPath(directory))
            throw new UpdateRuntimeException("update_worker_location");
        var inventory = new UpdateRuntimeInventory();
        try
        {
            var ancestors = new Stack<string>();
            for (var ancestor = directory; ancestor is not null; ancestor = Path.GetDirectoryName(ancestor))
                ancestors.Push(ancestor);
            foreach (var ancestor in ancestors) inventory.directories.Add(UpdatePathLock.OpenDirectory(ancestor));
            inventory.Read(directory, directory, 0);
            if (inventory.files.Count == 0 || required.Any(name => !inventory.files.Any(file =>
                string.Equals(file.Relative, name, StringComparison.OrdinalIgnoreCase))))
                throw new UpdateRuntimeException("update_worker_source");
            inventory.files.Sort((left, right) => StringComparer.Ordinal.Compare(left.Relative, right.Relative));
            return inventory;
        }
        catch
        {
            inventory.Dispose();
            throw;
        }
    }

    internal string Manifest()
    {
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var (relative, stream) in files)
        {
            stream.Position = 0;
            var hash = SHA256.HashData(stream);
            stream.Position = 0;
            Append(digest, relative, stream.Length, hash);
        }
        return Convert.ToHexStringLower(digest.GetHashAndReset());
    }

    internal static void Append(IncrementalHash manifest, string relative, long length, byte[] hash)
    {
        manifest.AppendData(Encoding.UTF8.GetBytes(relative + "\0"));
        Span<byte> size = stackalloc byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(size, length);
        manifest.AppendData(size);
        manifest.AppendData(hash);
    }

    private void Read(string root, string directory, int depth)
    {
        if (depth > 8 || directories.Count >= UpdateRuntimeStager.MaximumFiles)
            throw new UpdateRuntimeException("update_worker_source");
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            if ((File.GetAttributes(path) & FileAttributes.Directory) != 0)
            {
                directories.Add(UpdatePathLock.OpenDirectory(path));
                Read(root, path, depth + 1);
                continue;
            }
            if (files.Count >= UpdateRuntimeStager.MaximumFiles)
                throw new UpdateRuntimeException("update_worker_source");
            var handle = UpdatePathLock.OpenFile(path);
            FileStream stream;
            try { stream = new FileStream(handle, FileAccess.Read); }
            catch { handle.Dispose(); throw; }
            files.Add((Path.GetRelativePath(root, path).Replace('\\', '/'), stream));
            if (stream.Length > UpdateRuntimeStager.MaximumBytes - Bytes)
                throw new UpdateRuntimeException("update_worker_source");
            Bytes += stream.Length;
        }
    }

    public void Dispose()
    {
        foreach (var file in files) file.Stream.Dispose();
        for (var index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
    }
}
