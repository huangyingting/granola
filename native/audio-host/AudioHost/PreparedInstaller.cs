using System.ComponentModel;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace WindowsAiNotes.AudioHost;

public sealed class PreparedInstaller : IDisposable
{
    private readonly FileStream file;
    private readonly List<SafeFileHandle> directories;
    public string Path { get; }
    public VerifiedUpdateArtifact Artifact { get; }
    public bool IsDisposed { get; private set; }

    private PreparedInstaller(string path, VerifiedUpdateArtifact artifact, FileStream file, List<SafeFileHandle> directories)
    {
        Path = path;
        Artifact = artifact;
        this.file = file;
        this.directories = directories;
    }

    public static UpdateTrustResult Open(string path, UpdateTrustPolicy policy, string currentVersion,
        long expectedBytes, string expectedSha512, out PreparedInstaller? prepared)
    {
        prepared = null;
        if (!UpdateTrustVerifier.IsStableVersion(currentVersion) || !UpdateTrustVerifier.IsStableVersion(policy.ProductVersion) ||
            System.Version.Parse(policy.ProductVersion) <= System.Version.Parse(currentVersion))
            return UpdateTrustResult.Rejected("update_verification_arguments");
        return OpenArtifact(path, policy, expectedBytes, expectedSha512, installer: true, out prepared);
    }

    internal static UpdateTrustResult OpenArtifact(string path, UpdateTrustPolicy policy, long expectedBytes,
        string expectedSha512, bool installer, out PreparedInstaller? prepared)
    {
        prepared = null;
        if (!OperatingSystem.IsWindows() || !UpdateInstallationVerifier.CanonicalPath(path) ||
            expectedBytes is <= 0 or > UpdateTrustVerifier.MaximumArtifactBytes || !ValidHash(expectedSha512))
            return UpdateTrustResult.Rejected("update_verification_arguments");
        var directories = new List<SafeFileHandle>();
        FileStream? file = null;
        try
        {
            if (!UpdatePathLock.IsFixedDiskPath(path))
                return UpdateTrustResult.Rejected("update_artifact_invalid");
            var parents = new Stack<string>();
            for (var parent = System.IO.Path.GetDirectoryName(path); parent is not null;
                parent = System.IO.Path.GetDirectoryName(parent))
                parents.Push(parent);
            foreach (var parent in parents)
            {
                directories.Add(UpdatePathLock.OpenDirectory(parent));
            }
            var result = UpdateTrustVerifier.OpenVerifiedArtifact(path, policy, installer, out file);
            if (!result.Verified) return result;
            if (file is null || result.Artifact is null || result.Artifact.Bytes != expectedBytes ||
                !CryptographicOperations.FixedTimeEquals(Convert.FromBase64String(result.Artifact.Sha512),
                    Convert.FromBase64String(expectedSha512)))
                return UpdateTrustResult.Rejected("update_artifact_mismatch");
            prepared = new(path, result.Artifact, file, directories);
            file = null;
            directories = [];
            return result;
        }
        catch (UpdatePathInvalidException)
        {
            return UpdateTrustResult.Rejected("update_artifact_invalid");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or Win32Exception or ArgumentException)
        {
            return UpdateTrustResult.Rejected("update_artifact_unavailable");
        }
        finally
        {
            file?.Dispose();
            foreach (var directory in directories) directory.Dispose();
        }
    }

    public void Dispose()
    {
        if (IsDisposed) return;
        IsDisposed = true;
        try
        {
            file.Dispose();
        }
        finally
        {
            foreach (var directory in directories) directory.Dispose();
        }
    }

    private static bool ValidHash(string value)
    {
        Span<byte> bytes = stackalloc byte[64];
        return value.Length == 88 && Convert.TryFromBase64String(value, bytes, out var length) &&
            length == 64 && Convert.ToBase64String(bytes) == value;
    }

}
