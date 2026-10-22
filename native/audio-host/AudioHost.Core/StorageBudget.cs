namespace WindowsAiNotes.Audio;

public sealed record StorageStatus(long UsedBytes, long QuotaBytes, long FreeBytes,
    long MetadataReserveBytes, long DiskReserveBytes, long CaptureHeadroomBytes, string State, string? Code);

public sealed class StorageBudget
{
    public const long GiB = 1024L * 1024 * 1024;
    public const long DefaultQuotaBytes = 5 * GiB;
    public const long MaxQuotaBytes = 50 * GiB;
    public const long MetadataReserveBytes = 8 * 1024 * 1024;
    public const long DiskReserveBytes = 64 * 1024 * 1024;
    public const long CaptureHeadroomBytes = 8 * 1024 * 1024;
    public const int MaxFiles = 100_000;
    public const int MaxDirectories = 10_000;
    private readonly object gate = new();
    private readonly string root;
    private readonly Func<long> freeSpace;
    private long quotaBytes;

    public StorageBudget(string root, long quotaBytes = DefaultQuotaBytes, Func<long>? freeSpace = null)
    {
        this.root = Path.GetFullPath(root);
        ValidateQuota(quotaBytes);
        this.quotaBytes = quotaBytes;
        this.freeSpace = freeSpace ?? (() => new DriveInfo(Path.GetPathRoot(this.root)!).AvailableFreeSpace);
    }

    public static void ValidateQuota(long bytes)
    {
        if (bytes < GiB || bytes > MaxQuotaBytes || bytes % GiB != 0)
            throw new AudioException("invalid_request", "Choose a local audio limit from 1 to 50 whole GiB.");
    }

    public StorageStatus Read(long? quota = null)
    {
        lock (gate)
        {
            if (quota is not null)
            {
                ValidateQuota(quota.Value);
                quotaBytes = quota.Value;
            }
            var (used, free) = Measure();
            var code = quotaBytes - used - MetadataReserveBytes < CaptureHeadroomBytes ? "storage_limit" :
                free - DiskReserveBytes < CaptureHeadroomBytes ? "disk_full" : null;
            var warning = used >= quotaBytes * 4 / 5
                || Math.Min(quotaBytes - used - MetadataReserveBytes, free - DiskReserveBytes) < 256L * 1024 * 1024;
            return new(used, quotaBytes, free, MetadataReserveBytes, DiskReserveBytes, CaptureHeadroomBytes,
                code is not null ? "blocked" : warning ? "warning" : "ready", code);
        }
    }

    public void EnsureCaptureCapacity()
    {
        var status = Read();
        if (status.Code is { } code)
            throw new AudioException(code, code == "disk_full"
                ? "Disk space is too low to capture safely. Saved audio was preserved; free space before recording again."
                : "The device audio limit has been reached. Saved audio was preserved; remove reviewed audio or raise the limit.");
    }

    internal IDisposable Reserve(int encryptedBytes, bool media)
    {
        Monitor.Enter(gate);
        try
        {
            var (used, free) = Measure();
            if (media && encryptedBytes > quotaBytes - used - MetadataReserveBytes)
                throw new AudioException("storage_limit", "The device audio limit has been reached; saved audio was preserved.");
            if (encryptedBytes > free - (media ? DiskReserveBytes : 0))
                throw new AudioException("disk_full", "Disk space is too low for this encrypted write; saved audio was preserved.");
            // Failure/recovery manifests may use the reserve even when media is over quota.
            return new WriteLease(gate);
        }
        catch
        {
            Monitor.Exit(gate);
            throw;
        }
    }

    private (long Used, long Free) Measure()
    {
        try
        {
            long used = 0;
            var files = 0;
            var directories = 1;
            var pending = new Stack<DirectoryInfo>();
            pending.Push(new DirectoryInfo(root));
            while (pending.TryPop(out var directory))
            {
                if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new AudioException("storage_unavailable", "Audio storage contains a linked directory; capacity cannot be verified safely.");
                foreach (var entry in directory.EnumerateFileSystemInfos())
                {
                    if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                        throw new AudioException("storage_unavailable", "Audio storage contains a linked file or directory; capacity cannot be verified safely.");
                    if (entry is DirectoryInfo child)
                    {
                        if (++directories > MaxDirectories)
                            throw new AudioException("storage_unavailable", "Audio storage exceeds the bounded directory scan; review preserved files before recording.");
                        pending.Push(child);
                    }
                    else if (entry is FileInfo file)
                    {
                        if (++files > MaxFiles)
                            throw new AudioException("storage_unavailable", "Audio storage exceeds the bounded file scan; review preserved files before recording.");
                        used = checked(used + file.Length);
                        if (used > 9_007_199_254_740_991)
                            throw new AudioException("storage_unavailable", "Audio storage exceeds the supported capacity range.");
                    }
                }
            }
            var free = freeSpace();
            if (free < 0 || free > 9_007_199_254_740_991)
                throw new AudioException("storage_unavailable", "The disk reported an unsupported free-space value.");
            return (used, free);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or OverflowException)
        {
            throw new AudioException("storage_unavailable", "Audio storage capacity could not be verified. No saved files were deleted.", true, error);
        }
    }

    private sealed class WriteLease(object gate) : IDisposable
    {
        public void Dispose() => Monitor.Exit(gate);
    }
}
