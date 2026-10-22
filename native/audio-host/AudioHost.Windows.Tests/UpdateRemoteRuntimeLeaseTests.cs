using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateRemoteRuntimeLeaseTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"notes-main-runtime-lease-{Guid.NewGuid():D}");
    private readonly string directory;
    private readonly string installation;
    private string Filepath => Path.Combine(directory, "runtime.bin");

    public UpdateRemoteRuntimeLeaseTests()
    {
        Directory.CreateDirectory(root);
        directory = Path.Combine(root, $"worker-{Guid.NewGuid():D}");
        installation = Path.Combine(root, "installation");
        Directory.CreateDirectory(installation);
        new DirectoryInfo(directory).Create(UpdatePrivateDirectory.Security());
        File.WriteAllBytes(Filepath, [1, 2, 3]);
    }

    [Fact]
    public async Task MainRetainsFileAndAncestorLocksAfterTheStagerReleasesItsOwnCopies()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var local = Open();
        using var remote = local.RetainForParent(fixture.Parent);
        local.Dispose();
        Assert.Throws<IOException>(() => { using var overwrite = File.OpenWrite(Filepath); });
        Assert.Throws<IOException>(() => File.Delete(Filepath));
        Assert.Throws<IOException>(() => Directory.Move(directory, directory + "-replaced"));
        Assert.False(fixture.Parent.HasExited);
        remote.Dispose();
        Assert.False(fixture.Parent.HasExited);
        using var released = File.OpenWrite(Filepath);
    }

    [Fact]
    public async Task ExactParentExitClosesItsRetainedHandlesWithoutReopeningItsPid()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var local = Open();
        using var remote = local.RetainForParent(fixture.Parent);
        local.Dispose();
        await fixture.ExitParentAsync();
        using (var released = File.OpenWrite(Filepath)) { }
        remote.Dispose();
        Assert.Throws<WindowsAiNotes.Updates.UpdateHandoffException>(() => local.RetainForParent(fixture.Parent));
    }

    [Fact]
    public async Task PartialDuplicationFailureReleasesEarlierMainOwnedHandlesWhileMainIsStillAlive()
    {
        await using var fixture = await UpdateParentHandoffTests.Fixture.OpenAsync();
        using var first = UpdatePathLock.OpenFile(Filepath);
        using var invalid = new SafeFileHandle(nint.Zero, ownsHandle: false);
        Assert.Throws<Win32Exception>(() => UpdateRemoteRuntimeLease.Open(fixture.Parent, [first, invalid]));
        first.Dispose();
        Assert.False(fixture.Parent.HasExited);
        using var released = File.OpenWrite(Filepath);
    }

    private UpdateRuntimeLease Open()
    {
        using var inventory = UpdateRuntimeInventory.Open(directory, ["runtime.bin"]);
        return UpdateRuntimeLease.Open(directory, installation, inventory.Manifest(), ["runtime.bin"]);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
