using System.Buffers.Binary;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateRuntimeTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-worker-runtime-{Guid.NewGuid():D}");
    private readonly string source;
    private readonly string parent;

    public UpdateRuntimeTests()
    {
        source = Path.Combine(root, "installed app");
        parent = Path.Combine(root, "private cache");
        Directory.CreateDirectory(Path.Combine(source, "licenses"));
        Directory.CreateDirectory(parent);
        // Copy mechanics only; these are deliberately not executable or trusted runtime fixtures.
        File.WriteAllText(Path.Combine(source, "AudioHost.exe"), "Synthetic nonexecutable runtime fixture.");
        File.WriteAllText(Path.Combine(source, "licenses", "fixture.txt"), "Synthetic license fixture.");
        File.WriteAllText(Path.Combine(source, "licenses0.txt"), "Synthetic normalized-sort fixture.");
    }

    [Fact]
    public void CopiesExactLockedBytesIntoAnIndependentCurrentUserOnlyDirectoryAndReleasesSourceHandles()
    {
        var result = UpdateRuntimeStager.Copy(source, source, parent, ["AudioHost.exe", "licenses/fixture.txt"]);
        Assert.Equal(parent, Path.GetDirectoryName(result.Directory));
        Assert.StartsWith("worker-", Path.GetFileName(result.Directory));
        Assert.Equal(Path.Combine(result.Directory, "AudioHost.exe"), result.Executable);
        Assert.Equal(3, result.Files);
        using var manifest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long bytes = 0;
        foreach (var relative in new[] { "AudioHost.exe", "licenses/fixture.txt", "licenses0.txt" })
        {
            var contents = File.ReadAllBytes(Path.Combine(source, relative));
            Assert.Equal(contents, File.ReadAllBytes(Path.Combine(result.Directory, relative)));
            bytes += contents.Length;
            manifest.AppendData(Encoding.UTF8.GetBytes(relative + "\0"));
            var size = new byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(size, contents.Length);
            manifest.AppendData(size);
            manifest.AppendData(SHA256.HashData(contents));
        }
        Assert.Equal(bytes, result.Bytes);
        Assert.Equal(Convert.ToHexStringLower(manifest.GetHashAndReset()), result.Sha256);
        using var identity = WindowsIdentity.GetCurrent();
        var security = new DirectoryInfo(result.Directory).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
        Assert.True(security.AreAccessRulesProtected);
        Assert.Equal(identity.User, security.GetOwner(typeof(SecurityIdentifier)));
        var rules = security.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>().ToArray();
        Assert.Equal(2, rules.Length);
        Assert.All(rules, rule =>
        {
            Assert.Equal(AccessControlType.Allow, rule.AccessControlType);
            Assert.True(rule.IdentityReference.Equals(identity.User) ||
                rule.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)));
            Assert.Equal(FileSystemRights.FullControl, rule.FileSystemRights);
        });
        Directory.Move(source, source + "-moved");
        Assert.True(File.Exists(result.Executable));
        File.WriteAllText(result.Executable, "Synthetic replacement after staging.");
    }

    [Fact]
    public void RejectsMissingRequiredRuntimeFilesWithoutCreatingACandidate()
    {
        var error = Assert.Throws<UpdateRuntimeException>(() =>
            UpdateRuntimeStager.Copy(source, source, parent, ["missing.dll"]));
        Assert.Equal("update_worker_source", error.Code);
        Assert.Empty(Directory.EnumerateFileSystemEntries(parent));
        File.Delete(Path.Combine(source, "AudioHost.exe"));
    }

    [Fact]
    public void RejectsAWorkerLocationInsideTheInstallationWithoutTouchingItsFiles()
    {
        var child = Path.Combine(source, "nested cache");
        Directory.CreateDirectory(child);
        var error = Assert.Throws<UpdateRuntimeException>(() =>
            UpdateRuntimeStager.Copy(source, source, child, ["AudioHost.exe"]));
        Assert.Equal("update_worker_location", error.Code);
        Assert.Empty(Directory.EnumerateFileSystemEntries(child));
        Assert.True(File.Exists(Path.Combine(source, "AudioHost.exe")));
    }

    [Fact]
    public void RejectsUnboundedRuntimeInventoriesAndReleasesEveryOpenedSourceFile()
    {
        for (var index = 0; index < UpdateRuntimeStager.MaximumFiles; index++)
            File.WriteAllText(Path.Combine(source, $"extra-{index:D4}.txt"), "");
        var error = Assert.Throws<UpdateRuntimeException>(() =>
            UpdateRuntimeStager.Copy(source, source, parent, ["AudioHost.exe"]));
        Assert.Equal("update_worker_source", error.Code);
        Assert.Empty(Directory.EnumerateFileSystemEntries(parent));
        Directory.Move(source, source + "-moved");
    }

    [Fact]
    public void RejectsOversizedRuntimeSourcesBeforeCopyingTheirContents()
    {
        var large = Path.Combine(source, "large.bin");
        using (var file = new FileStream(large, FileMode.CreateNew, FileAccess.Write))
            file.SetLength(UpdateRuntimeStager.MaximumBytes + 1);
        var error = Assert.Throws<UpdateRuntimeException>(() =>
            UpdateRuntimeStager.Copy(source, source, parent, ["AudioHost.exe"]));
        Assert.Equal("update_worker_source", error.Code);
        Assert.Empty(Directory.EnumerateFileSystemEntries(parent));
        File.Delete(large);
    }

    [Fact]
    public void PublicStagingRejectsInvalidInstallationArgumentsBeforeCreatingDirectories()
    {
        var result = UpdateRuntimeStager.Stage("relative.exe", "0.1.0", "Synthetic product", parent);
        Assert.False(result.Staged);
        Assert.Equal("update_installation_arguments", result.Code);
        Assert.Null(result.Runtime);
        Assert.Empty(Directory.EnumerateFileSystemEntries(parent));
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
