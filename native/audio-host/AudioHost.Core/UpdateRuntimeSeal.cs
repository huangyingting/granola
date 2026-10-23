using System.Text.Json;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.Updates;

public sealed record UpdateRuntimeMember(string Path, long Bytes, string Sha256);
public sealed record UpdateRuntimeSeal(int Version, string ApplicationVersion, UpdateRuntimeMember[] Files)
{
    public const int MaximumBytes = 256 * 1024;
    public const int MaximumFiles = 511;
    public const long MaximumPayloadBytes = 512 * 1024 * 1024;
    private static readonly JsonSerializerOptions Options = new(AudioJson.Options)
    {
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        MaxDepth = 4
    };

    public static UpdateRuntimeSeal Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is 0 or > MaximumBytes) throw Invalid();
        UpdateRuntimeSeal? seal;
        try { seal = JsonSerializer.Deserialize<UpdateRuntimeSeal>(bytes, Options); }
        catch (JsonException) { throw Invalid(); }
        if (seal is null || seal.Version != 1 || !UpdateVersion.IsStable(seal.ApplicationVersion) ||
            seal.Files is not { Length: > 0 and <= MaximumFiles })
            throw Invalid();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? previous = null;
        long total = 0;
        foreach (var file in seal.Files)
        {
            if (file is null || !ValidPath(file.Path) || IsOperationalFile(file.Path) ||
                file.Path.Equals("AudioHost.exe", StringComparison.OrdinalIgnoreCase) ||
                !names.Add(file.Path) || (previous is not null && StringComparer.Ordinal.Compare(previous, file.Path) >= 0) ||
                file.Bytes < 0 || file.Bytes > MaximumPayloadBytes - total ||
                file.Sha256 is not { Length: 64 } ||
                file.Sha256.Any(c => c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
                throw Invalid();
            previous = file.Path;
            total += file.Bytes;
        }
        return seal;
    }

    public static bool IsOperationalFile(string path) =>
        path.Equals("update-runtime-state.json", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("update-outcome.json", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("update-runtime-files.json", StringComparison.OrdinalIgnoreCase);

    public static bool ValidPath(string? path)
    {
        if (path is not { Length: > 0 and <= 240 } || path.Any(c => c < ' ' || c > '~' || c is '\\' or ':' or '"' or '<' or '>' or '|' or '?' or '*'))
            return false;
        foreach (var part in path.Split('/'))
        {
            if (part.Length == 0 || part != part.Trim() || part.EndsWith('.') || part is "." or "..") return false;
            var stem = part.Split('.')[0];
            if (stem.Equals("CON", StringComparison.OrdinalIgnoreCase) || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase) ||
                stem.Equals("AUX", StringComparison.OrdinalIgnoreCase) || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase) ||
                (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) ||
                stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && char.IsAsciiDigit(stem[3])))
                return false;
        }
        return true;
    }

    private static UpdateHandoffException Invalid() => new("update_runtime_seal_invalid");
}
