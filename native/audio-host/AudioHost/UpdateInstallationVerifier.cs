using System.Diagnostics;
using System.ComponentModel;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateInstallation(string Directory, string Executable, string ApplicationVersion, string ProductName, string Architecture);
public sealed record UpdateInstallationResult(int Version, bool Registered, string Code, UpdateInstallation? Installation)
{
    public static UpdateInstallationResult Rejected(string code) => new(1, false, code, null);
}

internal sealed record UpdateRegistration(string? Location, string? DisplayName, string? DisplayVersion,
    string? Uninstall, string? QuietUninstall);

public static class UpdateInstallationVerifier
{
    // Preserve electron-builder's existing UUID-v5 identity; this is not a new installation.
    public const string ApplicationGuid = "dbdb543e-07bd-5ef6-99a5-00d80b9bdfb6";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + ApplicationGuid;

    public static UpdateInstallationResult Verify(string executable, string version, string product)
    {
        if (!UpdateTrustVerifier.IsStableVersion(version) || !ValidProduct(product) ||
            !CanonicalPath(executable) || !string.Equals(Path.GetFileName(executable), $"{product}.exe", StringComparison.OrdinalIgnoreCase))
            return UpdateInstallationResult.Rejected("update_installation_arguments");
        try
        {
            if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
                return UpdateInstallationResult.Rejected("update_installation_platform");
            if (!UpdatePathLock.IsFixedDiskPath(executable))
                return UpdateInstallationResult.Rejected("update_installation_location");
            var directory = Path.GetDirectoryName(executable);
            if (directory is null)
                return UpdateInstallationResult.Rejected("update_installation_arguments");
            if (!UpdatePathLock.SameDirectory(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory),
                Path.Combine(directory, "resources", "audio-host")))
                return UpdateInstallationResult.Rejected("update_installation_helper");
            RequireRegularPath(executable, directory: false);
            RequireRegularPath(Path.Combine(AppContext.BaseDirectory, "AudioHost.exe"), directory: false);
            using var current = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var machineInstall = machine.OpenSubKey(@"Software\" + ApplicationGuid);
            using var machineUninstall = machine.OpenSubKey(UninstallKey);
            if (machineInstall is not null || machineUninstall is not null)
                return UpdateInstallationResult.Rejected("update_installation_machine");
            using var installed = current.OpenSubKey(@"Software\" + ApplicationGuid);
            using var uninstall = current.OpenSubKey(UninstallKey);
            if (installed is null || uninstall is null)
                return UpdateInstallationResult.Rejected("update_installation_missing");
            var registration = new UpdateRegistration(ReadString(installed, "InstallLocation"),
                ReadString(uninstall, "DisplayName"), ReadString(uninstall, "DisplayVersion"),
                ReadString(uninstall, "UninstallString"), ReadString(uninstall, "QuietUninstallString"));
            if (registration.Location is null || !Matches(registration, registration.Location, version, product) ||
                !UpdatePathLock.IsFixedDiskPath(registration.Location))
                return UpdateInstallationResult.Rejected("update_installation_mismatch");
            RequireRegularPath(registration.Location, directory: true);
            if (!UpdatePathLock.SameDirectory(registration.Location, directory))
                return UpdateInstallationResult.Rejected("update_installation_mismatch");
            var uninstaller = Path.Combine(directory, $"Uninstall {product}.exe");
            RequireRegularPath(uninstaller, directory: false);
            var metadata = FileVersionInfo.GetVersionInfo(executable);
            var removal = FileVersionInfo.GetVersionInfo(uninstaller);
            if (metadata.ProductName != product || !SameVersion(metadata.ProductVersion, version) ||
                removal.ProductName != product || !SameVersion(removal.ProductVersion, version) ||
                removal.InternalName != "io.github.windowsainotes.desktop.uninstaller.x64.v1" ||
                removal.OriginalFilename != $"windows-ai-notes-{version}-x64-uninstaller.exe")
                return UpdateInstallationResult.Rejected("update_installation_identity");
            using var stream = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var pe = new PEReader(stream);
            if (pe.PEHeaders.CoffHeader.Machine != Machine.Amd64)
                return UpdateInstallationResult.Rejected("update_installation_architecture");
            return new(1, true, "update_installation_verified",
                new(directory, executable, version, product, "x64"));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or
            ArgumentException or System.Security.SecurityException or BadImageFormatException or Win32Exception)
        {
            return UpdateInstallationResult.Rejected("update_installation_unavailable");
        }
    }

    internal static bool Matches(UpdateRegistration value, string directory, string version, string product) =>
        CanonicalPath(directory) && value.Location is not null && CanonicalPath(value.Location) &&
        string.Equals(value.Location, directory, StringComparison.OrdinalIgnoreCase) &&
        value.DisplayName == $"{product} {version}" && value.DisplayVersion == version &&
        MatchesCommand(value.Uninstall, Path.Combine(directory, $"Uninstall {product}.exe"), "/currentuser") &&
        MatchesCommand(value.QuietUninstall, Path.Combine(directory, $"Uninstall {product}.exe"), "/currentuser /S");

    private static bool MatchesCommand(string? actual, string executable, string arguments) =>
        actual is not null && actual.Length == executable.Length + arguments.Length + 3 &&
        actual[0] == '"' && actual.EndsWith($"\" {arguments}", StringComparison.Ordinal) &&
        string.Equals(actual.Substring(1, executable.Length), executable, StringComparison.OrdinalIgnoreCase);

    internal static bool CanonicalPath(string path) =>
        path.Length is > 3 and <= 2048 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\' &&
        path.LastIndexOf(':') == 1 && !path.Any(char.IsControl) && !path.Any(c => c is '"' or '<' or '>' or '|' or '?' or '*' or '/') &&
        path.Split('\\').Skip(1).All(part => part.Length > 0 && !part.EndsWith('.') && !part.EndsWith(' ')) &&
        string.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase);

    internal static void RequireRegularPath(string path, bool directory)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0 ||
            ((attributes & FileAttributes.Directory) != 0) != directory)
            throw new IOException("An update path is not a regular local file or directory.");
        for (var parent = Path.GetDirectoryName(path); parent is not null; parent = Path.GetDirectoryName(parent))
            if ((File.GetAttributes(parent) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != FileAttributes.Directory)
                throw new IOException("An update path contains a nonregular directory.");
    }

    private static string? ReadString(RegistryKey key, string name) =>
        key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is string value &&
        key.GetValueKind(name) == RegistryValueKind.String && value.Length <= 2048 && !value.Any(char.IsControl)
            ? value : null;

    private static bool ValidProduct(string product) =>
        product.Length is > 0 and <= 200 && product == product.Trim() &&
        !product.Any(char.IsControl) && !product.Any(c => c is '\\' or '/' or ':' or '"' or '<' or '>' or '|' or '?' or '*');

    private static bool SameVersion(string? actual, string expected) => actual == expected || actual == $"{expected}.0";
}
