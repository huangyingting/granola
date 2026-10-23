namespace WindowsAiNotes.Updates;

public static class UpdateVersion
{
    public static bool IsStable(string? value) =>
        System.Version.TryParse(value, out var version) && version.Major <= 65_535 && version.Minor <= 65_535 &&
        version.Build is >= 0 and <= 65_535 && version.Revision == -1 &&
        value == $"{version.Major}.{version.Minor}.{version.Build}";
}
