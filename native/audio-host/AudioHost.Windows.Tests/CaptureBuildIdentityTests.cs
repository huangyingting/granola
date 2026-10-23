using System.Security.Cryptography;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class CaptureBuildIdentityTests
{
    [Fact]
    public void DefaultCallbackCaptureDoesNotRequestBuildFingerprinting() =>
        Assert.Null(CaptureBuildIdentity.ForProfile(null));

    [Fact]
    public void ExperimentalProfileFingerprintsTheActualLoadedCaptureAssemblies()
    {
        var build = Assert.IsType<CaptureBuildProvenance>(CaptureBuildIdentity.ForProfile("wasapi_qpc_v1"));
        var expected = new[]
        {
            typeof(CaptureBuildIdentity).Assembly, typeof(CaptureClock).Assembly,
            typeof(IWaveIn).Assembly, typeof(WasapiCapture).Assembly
        };
        Assert.Equal(4, expected.Select(assembly => assembly.GetName().Name).Distinct().Count());
        Assert.Equal(["audio_host", "audio_core", "naudio_core", "naudio_wasapi"], build.Components.Select(component => component.Role));
        for (var i = 0; i < expected.Length; i++)
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(expected[i].Location))), build.Components[i].Sha256);
    }

    [Fact]
    public void UnsupportedProfilesDoNotSelectAnImplicitCaptureIdentity() =>
        Assert.Equal("invalid_request", Assert.Throws<AudioException>(() => CaptureBuildIdentity.ForProfile("other")).Code);
}
