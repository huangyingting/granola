using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;

namespace WindowsAiNotes.Audio;

public sealed record CaptureBuildComponent(string Role, string Sha256);
public sealed record CaptureComponentSource(string Role, string Path, Guid ModuleVersionId);

public sealed class CaptureBuildProvenance
{
    public const string Domain = "windows-ai-notes.capture-components.v1\n";
    public const long MaxComponentBytes = 16 * 1024 * 1024;
    private static readonly string[] roles = ["audio_host", "audio_core", "naudio_core", "naudio_wasapi"];
    public IReadOnlyList<CaptureBuildComponent> Components { get; }
    public string Sha256 { get; }

    private CaptureBuildProvenance(CaptureBuildComponent[] components)
    {
        Components = Array.AsReadOnly(components);
        var canonical = Domain + string.Concat(components.Select(component => $"{component.Role}:{component.Sha256}\n"));
        Sha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }

    public static CaptureBuildProvenance Read(IEnumerable<CaptureComponentSource> sources)
    {
        var inputs = sources.Take(5).ToArray();
        if (inputs.Length != roles.Length || roles.Any(role => inputs.Count(input => input.Role == role) != 1)
            || inputs.Any(input => !Path.IsPathFullyQualified(input.Path) || input.ModuleVersionId == Guid.Empty))
            throw Unavailable();
        var components = new List<CaptureBuildComponent>();
        try
        {
            foreach (var role in roles)
            {
                var input = inputs.Single(input => input.Role == role);
                using var stream = new FileStream(input.Path, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (stream.Length is < 1 or > MaxComponentBytes) throw Unavailable();
                using (var image = new PEReader(stream, PEStreamOptions.LeaveOpen))
                {
                    if (!image.HasMetadata) throw Unavailable();
                    var metadata = image.GetMetadataReader();
                    if (metadata.GetGuid(metadata.GetModuleDefinition().Mvid) != input.ModuleVersionId)
                        throw Unavailable();
                }
                stream.Position = 0;
                components.Add(new(role, Convert.ToHexStringLower(SHA256.HashData(stream))));
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or BadImageFormatException)
        {
            throw Unavailable(error);
        }
        return FromComponents(components);
    }

    internal static CaptureBuildProvenance FromComponents(IEnumerable<CaptureBuildComponent> components)
    {
        var values = components.Take(5).ToArray();
        if (values.Length != roles.Length || roles.Any(role => values.Count(value => value.Role == role) != 1)
            || values.Any(value => value.Sha256.Length != 64 || value.Sha256.Any(c => !(c is >= '0' and <= '9' or >= 'a' and <= 'f'))))
            throw Unavailable();
        return new CaptureBuildProvenance(roles.Select(role => values.Single(value => value.Role == role)).ToArray());
    }

    public IReadOnlyList<TimelineEvent> Timeline(double clockMs)
    {
        if (!double.IsFinite(clockMs) || clockMs is < 0 or > 14_400_000)
            throw new ArgumentOutOfRangeException(nameof(clockMs));
        return Components.Select(component => new TimelineEvent($"capture.component.{component.Role}", clockMs, null, component.Sha256))
            .Append(new("capture.build", clockMs, null, Sha256)).ToArray();
    }

    private static AudioException Unavailable(Exception? inner = null) => new("capture_build_unavailable",
        "The native capture component identity could not be confirmed. Capture did not start.", inner: inner);
}
