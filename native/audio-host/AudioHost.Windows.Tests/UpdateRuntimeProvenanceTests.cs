using System.ComponentModel;
using System.Runtime.InteropServices;
using WindowsAiNotes.AudioHost;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateRuntimeProvenanceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-runtime-provenance-{Guid.NewGuid():D}");
    private readonly string runtime;

    public UpdateRuntimeProvenanceTests()
    {
        runtime = Path.Combine(root, "native");
        Directory.CreateDirectory(runtime);
        foreach (var relative in UpdateRuntimeStager.RequiredFiles)
        {
            var path = Path.Combine(runtime, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, $"Synthetic runtime member: {relative}");
        }
        // An unsigned managed PE is sufficient for resource mechanics, never trusted provenance.
        File.Copy(typeof(UpdateInstallerWorker).Assembly.Location, Path.Combine(runtime, "AudioHost.exe"), overwrite: true);
    }

    [Fact]
    public void EmbedsTheExactDependencyInventoryWithoutASidecarAndNeverCallsItTrusted()
    {
        var original = File.ReadAllBytes(Path.Combine(runtime, "AudioHost.exe"));
        var originalFiles = Directory.GetFiles(runtime, "*", SearchOption.AllDirectories).Order().ToArray();
        UpdateRuntimeProvenance.Seal(runtime, "0.1.1");
        Assert.Equal(originalFiles, Directory.GetFiles(runtime, "*", SearchOption.AllDirectories).Order());
        var bytes = UpdateRuntimeResource.Read(Path.Combine(runtime, "AudioHost.exe"));
        Assert.NotNull(bytes);
        var seal = UpdateRuntimeSeal.Parse(bytes);
        Assert.Equal("0.1.1", seal.ApplicationVersion);
        Assert.DoesNotContain(seal.Files, file => file.Path == "AudioHost.exe");
        Assert.Equal(UpdateRuntimeStager.RequiredFiles.Length - 1, seal.Files.Length);
        Assert.NotEqual(original, File.ReadAllBytes(Path.Combine(runtime, "AudioHost.exe")));
        using var inventory = UpdateRuntimeInventory.Open(runtime, UpdateRuntimeStager.RequiredFiles);
        UpdateRuntimeProvenance.RequireContents(inventory, seal);
        Assert.Throws<IOException>(() => File.WriteAllText(Path.Combine(runtime, "AudioHost.dll"), "changed"));
        Assert.Throws<IOException>(() => Directory.Move(runtime, runtime + "-moved"));
        Assert.Equal("update_runtime_already_sealed", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeProvenance.Seal(runtime, "0.1.1")).Code);
        Assert.Equal("update_signature_invalid", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeProvenance.Open(runtime, "0.1.1", new('a', 64), "Synthetic publisher")).Code);
    }

    [Theory]
    [InlineData("dependency")]
    [InlineData("same-size")]
    [InlineData("configuration")]
    [InlineData("extra")]
    [InlineData("missing")]
    [InlineData("renamed")]
    public void DetectsEveryDependencyConfigurationAndFileSetChange(string scenario)
    {
        UpdateRuntimeProvenance.Seal(runtime, "0.1.1");
        var seal = UpdateRuntimeSeal.Parse(UpdateRuntimeResource.Read(Path.Combine(runtime, "AudioHost.exe"))!);
        var member = Path.Combine(runtime, scenario == "configuration" ? "AudioHost.runtimeconfig.json" : "AudioHost.dll");
        switch (scenario)
        {
            case "same-size":
                var bytes = File.ReadAllBytes(member);
                bytes[0] ^= 1;
                File.WriteAllBytes(member, bytes);
                break;
            case "extra": File.WriteAllText(Path.Combine(runtime, "unexpected.dll"), "extra"); break;
            case "missing": File.Delete(member); break;
            case "renamed": File.Move(member, Path.Combine(runtime, "renamed.dll")); break;
            default: File.WriteAllText(member, "Synthetic changed payload."); break;
        }
        // Use no required-name shortcut: the signed inventory must detect the exact set itself.
        using var inventory = UpdateRuntimeInventory.Open(runtime, []);
        Assert.Equal("update_runtime_payload_changed", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeProvenance.RequireContents(inventory, seal)).Code);
    }

    [Fact]
    public void StagingAndLaterJournalWritesDoNotChangeSignedCodeProvenanceOrItsWholeRuntimeHash()
    {
        UpdateRuntimeProvenance.Seal(runtime, "0.1.1");
        var seal = UpdateRuntimeSeal.Parse(UpdateRuntimeResource.Read(Path.Combine(runtime, "AudioHost.exe"))!);
        var cache = Path.Combine(root, "cache");
        Directory.CreateDirectory(cache);
        var staged = UpdateRuntimeStager.Copy(runtime, runtime, cache, UpdateRuntimeStager.RequiredFiles);
        UpdateRuntimeState.Claim(staged.Directory, staged.Sha256);
        var journal = new UpdateWorkerJournal(staged.Directory, "0.1.1", "0.1.2");
        journal.Write("preparing", "update_worker_preparing");
        using var inventory = UpdateRuntimeInventory.Open(staged.Directory, UpdateRuntimeStager.RequiredFiles);
        Assert.Equal(staged.Sha256, inventory.Manifest());
        UpdateRuntimeProvenance.RequireContents(inventory, seal);
        journal.Write("prepared", "update_worker_prepared");
        journal.Write("committed", "update_worker_committed");
        Assert.Equal(staged.Sha256, inventory.Manifest());
        UpdateRuntimeProvenance.RequireContents(inventory, seal);
        Assert.Equal("committed", UpdateRuntimeState.Read(staged.Directory).Phase);
    }

    [Fact]
    public void RefusesToSealMutableWorkerStateAsAReleasePayload()
    {
        File.WriteAllText(Path.Combine(runtime, UpdateWorkerJournal.Filename), "{}");
        Assert.Equal("update_runtime_seal_invalid", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeProvenance.Seal(runtime, "0.1.1")).Code);
        Assert.Null(UpdateRuntimeResource.Read(Path.Combine(runtime, "AudioHost.exe")));
    }

    [Fact]
    public void RejectsAHardlinkedDependencyWithoutGrantingASeal()
    {
        var path = Path.Combine(runtime, "AudioHost.dll");
        Assert.True(CreateHardLink(Path.Combine(root, "aliased.dll"), path, 0), new Win32Exception(Marshal.GetLastPInvokeError()).Message);
        Assert.Throws<UpdatePathInvalidException>(() => UpdateRuntimeProvenance.Seal(runtime, "0.1.1"));
        Assert.Null(UpdateRuntimeResource.Read(Path.Combine(runtime, "AudioHost.exe")));
    }

    [Theory]
    [InlineData("bad")]
    [InlineData("0.1.1-preview")]
    public void RejectsInvalidVersionsBeforeChangingTheExecutable(string version)
    {
        var path = Path.Combine(runtime, "AudioHost.exe");
        var original = File.ReadAllBytes(path);
        Assert.Equal("update_runtime_version", Assert.Throws<UpdateHandoffException>(() =>
            UpdateRuntimeProvenance.Seal(runtime, version)).Code);
        Assert.Equal(original, File.ReadAllBytes(path));
    }

    public void Dispose() => Directory.Delete(root, recursive: true);

    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string file, string existing, nint security);
}
