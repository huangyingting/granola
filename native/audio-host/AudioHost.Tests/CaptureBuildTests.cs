using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class CaptureBuildTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-build", Guid.NewGuid().ToString("D"));
    private static readonly string[] roles = ["audio_host", "audio_core", "naudio_core", "naudio_wasapi"];
    private sealed record Vector(string Name, CaptureBuildComponent[] Components, string ExpectedSha256);

    private static Vector[] Vectors() => JsonSerializer.Deserialize<Vector[]>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "capture-build.json")), AudioJson.Options)!;

    private CaptureComponentSource[] Sources()
    {
        Directory.CreateDirectory(root);
        var assembly = typeof(CaptureBuildTests).Assembly;
        return roles.Select(role =>
        {
            var path = Path.Combine(root, role + ".dll");
            File.Copy(assembly.Location, path, overwrite: true);
            return new CaptureComponentSource(role, path, assembly.ManifestModule.ModuleVersionId);
        }).ToArray();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void SharedCanonicalVectorsAreIndependentOfInputOrder(int index)
    {
        var vector = Vectors()[index];
        var build = CaptureBuildProvenance.FromComponents(vector.Components.Reverse());
        Assert.Equal(vector.ExpectedSha256, build.Sha256);
        Assert.Equal(roles, build.Components.Select(component => component.Role));
        var timeline = build.Timeline(125);
        Assert.Equal(5, timeline.Count);
        Assert.Equal("capture.build", timeline[^1].EventType);
        Assert.Equal(vector.ExpectedSha256, timeline[^1].Code);
        Assert.All(timeline, item => { Assert.Equal(125, item.ClockMs); Assert.Null(item.CaptureEpoch); });
    }

    [Fact]
    public void LoadedModuleIdentityAndFullFileBytesBothContributeToTheFingerprint()
    {
        var sources = Sources();
        var first = CaptureBuildProvenance.Read(sources);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sources[0].Path))), first.Components[0].Sha256);
        File.AppendAllText(sources[0].Path, "synthetic-overlay");
        var second = CaptureBuildProvenance.Read(sources);
        Assert.NotEqual(first.Sha256, second.Sha256);
        Assert.NotEqual(first.Components[0].Sha256, second.Components[0].Sha256);
        Assert.Equal(first.Components.Skip(1), second.Components.Skip(1));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("empty")]
    [InlineData("oversized")]
    [InlineData("not-managed")]
    [InlineData("wrong-module")]
    [InlineData("empty-module")]
    [InlineData("relative")]
    [InlineData("duplicate")]
    [InlineData("missing-role")]
    [InlineData("extra-role")]
    public void UncertainComponentIdentityNeverProducesAProvenanceRecord(string scenario)
    {
        var sources = Sources();
        switch (scenario)
        {
            case "missing": File.Delete(sources[0].Path); break;
            case "empty": File.WriteAllBytes(sources[0].Path, []); break;
            case "oversized":
                using (var stream = File.OpenWrite(sources[0].Path)) stream.SetLength(CaptureBuildProvenance.MaxComponentBytes + 1);
                break;
            case "not-managed": File.WriteAllBytes(sources[0].Path, Encoding.UTF8.GetBytes("synthetic non-PE")); break;
            case "wrong-module": sources[0] = sources[0] with { ModuleVersionId = Guid.NewGuid() }; break;
            case "empty-module": sources[0] = sources[0] with { ModuleVersionId = Guid.Empty }; break;
            case "relative": sources[0] = sources[0] with { Path = "relative.dll" }; break;
            case "duplicate": sources[1] = sources[1] with { Role = sources[0].Role }; break;
            case "missing-role": sources = sources[..^1]; break;
            case "extra-role": sources = [.. sources, sources[0] with { Role = "other" }]; break;
        }
        var error = Assert.Throws<AudioException>(() => CaptureBuildProvenance.Read(sources));
        Assert.Equal("capture_build_unavailable", error.Code);
        Assert.DoesNotContain(root, error.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("A")]
    [InlineData("g")]
    public void InvalidDigestValuesCannotBecomeBuildIdentity(string value)
    {
        var components = Vectors()[0].Components;
        components[0] = components[0] with { Sha256 = value.Length == 0 ? "" : new string(value[0], 64) };
        Assert.Throws<AudioException>(() => CaptureBuildProvenance.FromComponents(components));
    }

    [Fact]
    public void BuildMetadataRoundTripsThroughTheEncryptedManifestBeforeTheSingleCaptureEpoch()
    {
        var build = CaptureBuildProvenance.FromComponents(Vectors()[0].Components);
        var id = Guid.NewGuid();
        var epoch = Guid.NewGuid();
        var track = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "default", "default");
        var protector = new TestKeyProtector();
        var store = new RecordingStore(root, id, [track], protector);
        store.RecordCaptureBuild(build, 10);
        Assert.Throws<AudioException>(() => store.RecordCaptureBuild(build, 11));
        store.Transition("recording", "capture.started", 20, epoch, "wasapi_qpc_v1");
        var writer = new PcmChunkWriter(store, track.TrackId);
        writer.BeginEpoch(epoch);
        writer.Append(new byte[1600], 20, 70);
        writer.Flush();
        store.Transition("sealed", "capture.stopped", 75);
        var page = new RecordingArchive(root, protector).Describe(id);
        Assert.Equal(7, page.EventCount);
        Assert.Equal(build.Sha256, page.Events[4].Code);
        Assert.Equal("capture.started", page.Events[5].EventType);
        Assert.Equal("sealed", RecordingStore.Inspect(root, id, protector).State);
        Assert.DoesNotContain(build.Sha256, Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(store.DirectoryPath, "manifest.enc"))));
    }

    [Fact]
    public void ProvenanceCannotBeAddedAfterCaptureBeginsOrAudioIsSaved()
    {
        var build = CaptureBuildProvenance.FromComponents(Vectors()[0].Components);
        var track = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "default", "default");
        var protector = new TestKeyProtector();
        var store = new RecordingStore(root, Guid.NewGuid(), [track], protector);
        store.Transition("recording", "capture.started", 1, Guid.NewGuid(), "wasapi_qpc_v1");
        Assert.Throws<AudioException>(() => store.RecordCaptureBuild(build, 2));
        Assert.Single(store.Snapshot().Events);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(14_400_001)]
    public void InvalidObservationTimesAreRejected(double clock)
    {
        var build = CaptureBuildProvenance.FromComponents(Vectors()[0].Components);
        Assert.Throws<ArgumentOutOfRangeException>(() => build.Timeline(clock));
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
