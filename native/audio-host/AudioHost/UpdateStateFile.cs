using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal static class UpdateStateFile
{
    private static readonly JsonSerializerOptions Options = new(AudioJson.Options)
    {
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        MaxDepth = 8
    };

    internal static T? Read<T>(string directory, string filename, int maximumBytes = 16_384) where T : class
    {
        var path = Path.Combine(directory, filename);
        try { _ = File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        using var handle = UpdatePathLock.OpenFile(path);
        UpdatePathLock.RequireSingleRegularFile(handle);
        using var stream = new FileStream(handle, FileAccess.Read);
        return Read<T>(stream, maximumBytes);
    }

    internal static T Read<T>(FileStream stream, int maximumBytes = 16_384) where T : class
    {
        if (maximumBytes is <= 0 or > UpdateRuntimeSeal.MaximumBytes) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        UpdatePrivateDirectory.RequireFile(stream);
        if (stream.Length <= 0 || stream.Length > maximumBytes) throw new UpdateHandoffException("update_recovery_invalid");
        stream.Position = 0;
        try
        {
            return JsonSerializer.Deserialize<T>(stream, Options)
                ?? throw new UpdateHandoffException("update_recovery_invalid");
        }
        catch (JsonException) { throw new UpdateHandoffException("update_recovery_invalid"); }
    }

    internal static void Write<T>(string directory, string filename, T value, bool replace, int maximumBytes = 16_384)
    {
        if (maximumBytes is <= 0 or > UpdateRuntimeSeal.MaximumBytes) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        var temporary = Path.Combine(directory, $".state-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileInfo(temporary).Create(FileMode.CreateNew, FileSystemRights.FullControl,
                FileShare.Read, 4096, FileOptions.WriteThrough, UpdatePrivateDirectory.LockSecurity()))
            {
                JsonSerializer.Serialize(stream, value, AudioJson.Options);
                if (stream.Position > maximumBytes) throw new UpdateHandoffException("update_recovery_invalid");
                stream.Flush(flushToDisk: true);
            }
            if (!MoveFile(temporary, Path.Combine(directory, filename), 8u | (replace ? 1u : 0u)))
                throw new IOException("The durable update state could not be committed.", new Win32Exception(Marshal.GetLastPInvokeError()));
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFile(string source, string destination, uint flags);
}
