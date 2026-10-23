using System.Globalization;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateRuntimeState(int Version, string SessionId, string RuntimeSha256, string Phase, string UpdatedAt,
    UpdateRestartProof? Health = null, string? Resolution = null)
{
    internal const string Filename = "update-runtime-state.json";

    internal static void Stage(string directory, string manifest)
    {
        UpdatePrivateDirectory.Require(directory);
        if (!UpdateRuntimeLease.ValidDirectoryName(Path.GetFileName(directory)) || !UpdateRuntimeLease.ValidManifest(manifest))
            throw new UpdateHandoffException("update_worker_arguments");
        UpdateStateFile.Write(directory, Filename,
            new UpdateRuntimeState(1, Path.GetFileName(directory)[7..], manifest, "staged", Now()), replace: false);
    }

    internal static UpdateRuntimeState Read(string directory)
    {
        var state = UpdateStateFile.Read<UpdateRuntimeState>(directory, Filename)
            ?? throw new UpdateHandoffException("update_recovery_invalid");
        RequireValid(state, directory);
        return state;
    }

    internal static void RequireValid(UpdateRuntimeState state, string directory)
    {
        if (state.Version != 1 || !UpdateRuntimeLease.ValidDirectoryName(Path.GetFileName(directory)) ||
            state.SessionId != Path.GetFileName(directory)[7..] || !UpdateRuntimeLease.ValidManifest(state.RuntimeSha256) ||
            state.Phase is not ("staged" or "claimed" or "committed" or "installing" or "healthy") || !ValidTime(state.UpdatedAt) ||
            (state.Phase == "healthy" ? state.Health is null || !state.Health.Valid(state.SessionId, state.Health.ApplicationVersion) :
                state.Health is not null) ||
            (state.Phase == "healthy" ? state.Resolution is not { Length: > 0 and <= 12_000 } : state.Resolution is not null))
            throw new UpdateHandoffException("update_recovery_invalid");
    }

    internal static void Claim(string directory, string manifest)
    {
        var state = Read(directory);
        if (state.Phase != "staged") throw new UpdateHandoffException("update_worker_used");
        if (state.RuntimeSha256 != manifest) throw new UpdateHandoffException("update_worker_source");
        UpdateStateFile.Write(directory, Filename, state with { Phase = "claimed", UpdatedAt = Now() }, replace: true);
    }

    internal static void RecordIntent(string directory, string phase)
    {
        if (phase is not ("committed" or "installing")) return;
        var state = Read(directory);
        if (state.Phase == phase) return;
        if ((state.Phase, phase) is not (("claimed", "committed") or ("committed", "installing")))
            throw new UpdateHandoffException("update_recovery_invalid");
        // This fence precedes the outcome and ACK/process creation, and is never erased by a later failure.
        UpdateStateFile.Write(directory, Filename, state with { Phase = phase, UpdatedAt = Now() }, replace: true);
    }

    internal static void RecordHealthy(string directory, UpdateRestartProof proof)
    {
        var state = Read(directory);
        var outcome = UpdateWorkerJournal.Read(directory);
        if (state.Phase != "installing" || outcome?.Phase != "healthy" || outcome.Restart != proof ||
            !proof.Valid(state.SessionId, outcome.OfferedVersion))
            throw new UpdateHandoffException("update_recovery_invalid");
        var resolution = UpdateHealthyResolution.Seal(state.RuntimeSha256, outcome);
        UpdateStateFile.Write(directory, Filename,
            state with { Phase = "healthy", Health = proof, Resolution = resolution, UpdatedAt = Now() }, replace: true);
    }

    internal static bool ValidTime(string value) =>
        DateTime.TryParseExact(value, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed) &&
        parsed.Kind == DateTimeKind.Utc;

    private static string Now() => DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
}
