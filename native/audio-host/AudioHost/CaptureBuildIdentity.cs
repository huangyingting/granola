using System.Reflection;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

internal static class CaptureBuildIdentity
{
    internal static CaptureBuildProvenance? ForProfile(string? profile) => profile switch
    {
        null => null,
        "wasapi_qpc_v1" => CaptureBuildProvenance.Read([
            Source("audio_host", typeof(CaptureSession).Assembly),
            Source("audio_core", typeof(CaptureClock).Assembly),
            Source("naudio_core", typeof(IWaveIn).Assembly),
            Source("naudio_wasapi", typeof(WasapiCapture).Assembly)
        ]),
        _ => throw new AudioException("invalid_request", "The capture clock profile is unsupported.")
    };

    private static CaptureComponentSource Source(string role, Assembly assembly) =>
        new(role, assembly.Location, assembly.ManifestModule.ModuleVersionId);
}
