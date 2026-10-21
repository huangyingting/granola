using System.Security.Cryptography;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class DpapiTests
{
    [Fact]
    public void CurrentUserDpapiKeyWrapRoundTripsAndRejectsCorruption()
    {
        var protector = new DpapiKeyProtector();
        var key = RandomNumberGenerator.GetBytes(32);
        var wrapped = protector.Protect(key);
        Assert.Equal(key, protector.Unprotect(wrapped));
        wrapped[^1] ^= 1;
        Assert.Throws<CryptographicException>(() => protector.Unprotect(wrapped));
    }

    [Fact]
    public void RecordingSurvivesStoreRecreationWithCurrentUserDpapi()
    {
        var root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-dpapi", Guid.NewGuid().ToString("D"));
        try
        {
            var id = Guid.NewGuid();
            var track = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic");
            var store = new RecordingStore(root, id, [track], new DpapiKeyProtector());
            var writer = new PcmChunkWriter(store, track.TrackId);
            writer.BeginEpoch(Guid.NewGuid());
            writer.Append(new byte[3200], 0, 100);
            writer.Flush();
            store.Transition("sealed", "capture.stopped", 100);
            var report = RecordingStore.Inspect(root, id, new DpapiKeyProtector());
            Assert.Equal("sealed", report.State);
            Assert.Equal(1600, report.TotalSamples);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
