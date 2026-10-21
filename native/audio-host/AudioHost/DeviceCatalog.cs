using NAudio.CoreAudioApi;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.AudioHost;

public static class DeviceCatalog
{
    public static DeviceInfo[] List()
    {
        using var enumerator = new MMDeviceEnumerator();
        var results = new List<DeviceInfo>();
        foreach (var (flow, kind) in new[] { (DataFlow.Capture, "microphone"), (DataFlow.Render, "loopback") })
        {
            string? defaultId = null;
            if (enumerator.HasDefaultAudioEndpoint(flow, Role.Multimedia))
            {
                using var endpoint = enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
                defaultId = endpoint.ID;
            }
            foreach (var endpoint in enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active))
            {
                using (endpoint)
                    results.Add(new DeviceInfo(endpoint.ID, endpoint.FriendlyName, kind, endpoint.ID == defaultId));
            }
        }
        if (results.Count > 100)
            throw new AudioException("device_limit", "More than 100 endpoints were found; the probe cannot enumerate them safely.");
        return results.ToArray();
    }

    public static MMDevice Resolve(TrackSpec spec, string? pinnedId = null)
    {
        using var enumerator = new MMDeviceEnumerator();
        var flow = spec.Kind == "microphone" ? DataFlow.Capture : DataFlow.Render;
        if (pinnedId is null && spec.DeviceSelectionPolicy == "default"
            && !enumerator.HasDefaultAudioEndpoint(flow, Role.Multimedia))
            throw new AudioException("device_unavailable", "No default endpoint is available.", true);
        var endpoint = pinnedId is not null ? enumerator.GetDevice(pinnedId)
            : spec.DeviceSelectionPolicy == "default" ? enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia)
            : enumerator.GetDevice(spec.DeviceId);
        if (endpoint.State != DeviceState.Active || endpoint.DataFlow != flow)
        {
            endpoint.Dispose();
            throw new AudioException("device_unavailable", "The selected endpoint is inactive or has the wrong capture direction.", true);
        }
        return endpoint;
    }
}
