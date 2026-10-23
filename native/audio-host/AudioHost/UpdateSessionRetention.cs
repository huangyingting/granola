using System.ComponentModel;
using System.Security;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateRetiredReceipt(int Version, UpdateRuntimeState State, UpdateWorkerOutcome Outcome);
internal sealed record UpdateCleanupCounts(int Retired, int Removed, int Incomplete, int Rejected)
{
    internal static UpdateCleanupCounts Empty => new(0, 0, 0, 0);
}

internal static class UpdateSessionRetention
{
    internal const string ReceiptFilename = "update-retired.json";
    internal const int RetainHealthy = 2;
    internal const int MaximumRetire = 4;
    internal const int MaximumDrain = 2;
    internal const int MaximumRetired = 128;
    internal static string RetiredRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WindowsAINotes.RetiredUpdates");

    // Callers retain the application operation lock; startup also retains admission.
    internal static UpdateCleanupCounts Retire(string root, string retired)
    {
        UpdateStartupRecovery.RequireSafe(root);
        var counts = UpdateCleanupCounts.Empty;
        var held = new List<SafeFileHandle>();
        try
        {
            if (!OpenRoot(root, held, create: false)) return counts;
            var healthy = Directory.EnumerateDirectories(root)
                .Select(directory => (Directory: directory, State: UpdateRuntimeState.Read(directory)))
                .Where(item => item.State.Phase == "healthy")
                .Select(item => (item.Directory, Outcome: UpdateWorkerJournal.Read(item.Directory)
                    ?? throw new UpdateHandoffException("update_cleanup_invalid")))
                .OrderByDescending(item => item.Outcome.UpdatedAt, StringComparer.Ordinal)
                .ThenBy(item => item.Outcome.SessionId, StringComparer.Ordinal)
                .Skip(RetainHealthy).Take(MaximumRetire).ToArray();
            if (healthy.Length == 0) return counts;
            if (!UpdatePathLock.SameDirectory(Path.GetDirectoryName(root)!, Path.GetDirectoryName(retired)!))
                throw new UpdateHandoffException("update_cleanup_location");
            OpenRoot(retired, held, create: true);
            if (UpdatePathLock.SameDirectory(root, retired)) throw new UpdateHandoffException("update_cleanup_location");
            var available = MaximumRetired - Entries(retired).Length;
            for (var pending = 0; pending < healthy.Length; pending++)
            {
                var item = healthy[pending];
                if (available == 0)
                {
                    Report("update_cleanup_limit");
                    return counts with { Incomplete = counts.Incomplete + healthy.Length - pending };
                }

                try
                {
                    using var snapshot = Snapshot.Open(item.Directory);
                    var state = UpdateStateFile.Read<UpdateRuntimeState>(snapshot.Required(UpdateRuntimeState.Filename));
                    var outcome = UpdateStateFile.Read<UpdateWorkerOutcome>(snapshot.Required(UpdateWorkerJournal.Filename));
                    var receipt = new UpdateRetiredReceipt(1, state, outcome);
                    RequireReceipt(receipt, item.Directory);
                    if (!snapshot.Files.TryGetValue(UpdateRuntimeFiles.Filename, out var manifest))
                        throw new UpdateHandoffException("update_cleanup_index_missing");
                    var index = UpdateStateFile.Read<UpdateRuntimeFiles>(manifest, UpdateRuntimeSeal.MaximumBytes);
                    index.RequireManifest(state.RuntimeSha256);
                    RequireTopology(snapshot, index);
                    if (!snapshot.Files.TryGetValue(ReceiptFilename, out var previous))
                        UpdateStateFile.Write(item.Directory, ReceiptFilename, receipt, replace: false);
                    else if (UpdateStateFile.Read<UpdateRetiredReceipt>(previous) != receipt)
                        throw new UpdateHandoffException("update_cleanup_invalid");
                    snapshot.ReleaseContents();
                    UpdatePathLock.Rename(snapshot.Directories[0], Path.Combine(retired, Path.GetFileName(item.Directory)));
                    counts = counts with { Retired = counts.Retired + 1 };
                    available--;
                }
                catch (Exception error) when (Expected(error)) { counts = Failure(counts, error); }
            }
        }
        catch (Exception error) when (Expected(error)) { counts = Failure(counts, error); }
        finally { for (var index = held.Count - 1; index >= 0; index--) held[index].Dispose(); }
        return counts;
    }

    internal static UpdateCleanupCounts Drain(string retired, CancellationToken token = default)
    {
        var counts = UpdateCleanupCounts.Empty;
        var held = new List<SafeFileHandle>();
        try
        {
            if (!OpenRoot(retired, held, create: false)) return counts;
            foreach (var directory in Entries(retired).Take(MaximumDrain))
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    using (var snapshot = Snapshot.Open(directory)) Remove(snapshot, token);
                    try
                    {
                        _ = File.GetAttributes(directory);
                        throw new UpdateHandoffException("update_cleanup_pending");
                    }
                    catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { }
                    counts = counts with { Removed = counts.Removed + 1 };
                }
                catch (Exception error) when (Expected(error)) { counts = Failure(counts, error); }
            }
        }
        catch (Exception error) when (Expected(error)) { counts = Failure(counts, error); }
        finally { for (var index = held.Count - 1; index >= 0; index--) held[index].Dispose(); }
        return counts;
    }

    private static void Remove(Snapshot snapshot, CancellationToken token)
    {
        if (snapshot.Files.Count == 0 && snapshot.Directories.Count == 1)
        {
            UpdatePathLock.Delete(snapshot.Directories[0]);
            return;
        }
        var receipt = UpdateStateFile.Read<UpdateRetiredReceipt>(snapshot.Required(ReceiptFilename));
        RequireReceipt(receipt, snapshot.Root);
        if (!snapshot.Files.TryGetValue(UpdateRuntimeFiles.Filename, out var manifest))
        {
            if (snapshot.Files.Count != 1 || snapshot.Directories.Count != 1)
                throw new UpdateHandoffException("update_cleanup_invalid");
        }
        else
        {
            var index = UpdateStateFile.Read<UpdateRuntimeFiles>(manifest, UpdateRuntimeSeal.MaximumBytes);
            index.RequireManifest(receipt.State.RuntimeSha256);
            RequireTopology(snapshot, index);
            if (snapshot.Files.TryGetValue(UpdateRuntimeState.Filename, out var state) &&
                UpdateStateFile.Read<UpdateRuntimeState>(state) != receipt.State)
                throw new UpdateHandoffException("update_cleanup_invalid");
            if (snapshot.Files.TryGetValue(UpdateWorkerJournal.Filename, out var outcome) &&
                UpdateStateFile.Read<UpdateWorkerOutcome>(outcome) != receipt.Outcome)
                throw new UpdateHandoffException("update_cleanup_invalid");
            foreach (var file in index.Files)
            {
                token.ThrowIfCancellationRequested();
                if (!snapshot.Files.TryGetValue(file.Path, out var stream)) continue;
                stream.Position = 0;
                if (stream.Length != file.Bytes || !CryptographicOperations.FixedTimeEquals(
                    SHA256.HashData(stream), Convert.FromHexString(file.Sha256)))
                    throw new UpdateHandoffException("update_cleanup_changed");
                Delete(stream);
            }
            for (var indexDirectory = snapshot.Directories.Count - 1; indexDirectory > 0; indexDirectory--)
            {
                token.ThrowIfCancellationRequested();
                UpdatePathLock.Delete(snapshot.Directories[indexDirectory]);
                snapshot.Directories[indexDirectory].Dispose();
            }
            foreach (var name in new[] { UpdateRuntimeState.Filename, UpdateWorkerJournal.Filename })
                if (snapshot.Files.TryGetValue(name, out var metadata)) Delete(metadata);
            Delete(manifest);
        }
        token.ThrowIfCancellationRequested();
        Delete(snapshot.Required(ReceiptFilename));
        UpdatePathLock.Delete(snapshot.Directories[0]);
    }

    private static void Delete(FileStream stream)
    {
        UpdatePathLock.Delete(stream.SafeFileHandle);
        stream.Dispose();
    }

    private static void RequireTopology(Snapshot snapshot, UpdateRuntimeFiles index)
    {
        var allowed = index.Files.Select(file => file.Path).Concat(
            [ReceiptFilename, UpdateRuntimeFiles.Filename, UpdateRuntimeState.Filename, UpdateWorkerJournal.Filename])
            .ToHashSet(StringComparer.Ordinal);
        var directories = index.Files.SelectMany(file => Parents(file.Path)).ToHashSet(StringComparer.Ordinal);
        if (snapshot.Files.Keys.Any(path => !allowed.Contains(path)) ||
            snapshot.RelativeDirectories.Any(path => !directories.Contains(path)))
            throw new UpdateHandoffException("update_cleanup_invalid");
    }

    private static IEnumerable<string> Parents(string relative)
    {
        for (var offset = relative.IndexOf('/'); offset >= 0; offset = relative.IndexOf('/', offset + 1))
            yield return relative[..offset];
    }

    private static void RequireReceipt(UpdateRetiredReceipt receipt, string directory)
    {
        if (receipt.Version != 1) throw new UpdateHandoffException("update_cleanup_invalid");
        UpdateRuntimeState.RequireValid(receipt.State, directory);
        UpdateWorkerJournal.RequireValid(receipt.Outcome, directory);
        if (receipt.State.Phase != "healthy" || receipt.Outcome.Phase != "healthy" ||
            receipt.State.Health != receipt.Outcome.Restart)
            throw new UpdateHandoffException("update_cleanup_invalid");
        UpdateHealthyResolution.Require(receipt.State, receipt.Outcome);
    }

    private static string[] Entries(string root)
    {
        var entries = Directory.EnumerateFileSystemEntries(root).Take(MaximumRetired + 1).ToArray();
        if (entries.Length > MaximumRetired) throw new UpdateHandoffException("update_cleanup_limit");
        if (entries.Any(path => !UpdateRuntimeLease.ValidDirectoryName(Path.GetFileName(path))))
            throw new UpdateHandoffException("update_cleanup_invalid");
        return entries.Order(StringComparer.Ordinal).ToArray();
    }

    private static bool OpenRoot(string root, List<SafeFileHandle> held, bool create)
    {
        if (!UpdateInstallationVerifier.CanonicalPath(root) || !UpdatePathLock.IsFixedDiskPath(root))
            throw new UpdateHandoffException("update_cleanup_location");
        held.AddRange(UpdatePathLock.OpenAncestors(Path.GetDirectoryName(root)!));
        try { _ = File.GetAttributes(root); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            if (!create) return false;
            new DirectoryInfo(root).Create(UpdatePrivateDirectory.Security());
        }
        held.Add(UpdatePathLock.OpenDirectory(root));
        UpdatePrivateDirectory.Require(root);
        return true;
    }

    private static UpdateCleanupCounts Failure(UpdateCleanupCounts counts, Exception error)
    {
        var code = error is UpdateHandoffException handoff ? handoff.Code : "update_cleanup_incomplete";
        Report(code);
        return error is UpdateHandoffException && code is not ("update_cleanup_index_missing" or "update_cleanup_pending" or "update_cleanup_limit")
            ? counts with { Rejected = counts.Rejected + 1 } : counts with { Incomplete = counts.Incomplete + 1 };
    }

    private static void Report(string code) => Console.Error.WriteLine($"{code}: update session maintenance remains pending; notes were not changed.");
    internal static bool Expected(Exception error) => error is IOException or UnauthorizedAccessException or SecurityException or
        Win32Exception or ArgumentException or BadImageFormatException;

    private sealed class Snapshot : IDisposable
    {
        internal string Root { get; }
        internal Dictionary<string, FileStream> Files { get; } = new(StringComparer.Ordinal);
        internal List<SafeFileHandle> Directories { get; } = [];
        internal List<string> RelativeDirectories { get; } = [];
        private long bytes;

        private Snapshot(string root) { Root = root; }

        internal static Snapshot Open(string root)
        {
            var result = new Snapshot(root);
            try
            {
                result.Read(root, 0);
                return result;
            }
            catch { result.Dispose(); throw; }
        }

        internal FileStream Required(string name) => Files.TryGetValue(name, out var stream)
            ? stream : throw new UpdateHandoffException("update_cleanup_invalid");

        private void Read(string directory, int depth)
        {
            if (depth > 8 || Directories.Count >= UpdateRuntimeStager.MaximumFiles)
                throw new UpdateHandoffException("update_cleanup_invalid");
            Directories.Add(UpdatePathLock.OpenForRemoval(directory, directory: true));
            UpdatePrivateDirectory.Require(directory, requireProtected: depth == 0);
            if (depth > 0) RelativeDirectories.Add(Relative(directory));
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                if ((File.GetAttributes(path) & FileAttributes.Directory) != 0) { Read(path, depth + 1); continue; }
                if (Files.Count >= UpdateRuntimeStager.MaximumFiles + 4)
                    throw new UpdateHandoffException("update_cleanup_invalid");
                var handle = UpdatePathLock.OpenForRemoval(path, directory: false);
                FileStream stream;
                try { stream = new FileStream(handle, FileAccess.Read); }
                catch { handle.Dispose(); throw; }
                Files.Add(Relative(path), stream);
                UpdatePrivateDirectory.RequireFile(stream);
                if (stream.Length > UpdateRuntimeStager.MaximumBytes + 1024 * 1024 - bytes)
                    throw new UpdateHandoffException("update_cleanup_invalid");
                bytes += stream.Length;
            }
        }

        private string Relative(string path) => Path.GetRelativePath(Root, path).Replace('\\', '/');
        internal void ReleaseContents()
        {
            foreach (var stream in Files.Values) stream.Dispose();
            for (var index = Directories.Count - 1; index > 0; index--) Directories[index].Dispose();
        }
        public void Dispose()
        {
            ReleaseContents();
            if (Directories.Count > 0) Directories[0].Dispose();
        }
    }
}
