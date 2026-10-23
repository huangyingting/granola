using System.Security.Cryptography;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateRestartChallenge(int Version, string Event, string SessionId, string Challenge,
    UpdateParentIdentity Identity, string ApplicationVersion);
internal sealed record UpdateRestartAuthentication(int Version, string Event, string SessionId, string Challenge,
    UpdateParentIdentity Identity, string ApplicationVersion, string AuthChallenge);
internal sealed record UpdateRestartBridgeRequest(int Version, string Event, string SessionId, string Challenge,
    UpdateParentIdentity Identity, string ApplicationVersion, string Endpoint);

internal static class UpdateRestartProtocol
{
    internal static readonly JsonSerializerOptions Options = new(AudioJson.Options)
    {
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        MaxDepth = 4
    };

    internal static string Endpoint(Guid session, string kind) =>
        $"WindowsAINotes.{kind}.{session:N}.{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))}";

    internal static bool ValidEndpoint(string endpoint, Guid session, string kind)
    {
        var prefix = $"WindowsAINotes.{kind}.{session:N}.";
        return endpoint.StartsWith(prefix, StringComparison.Ordinal) &&
            UpdateRuntimeLease.ValidManifest(endpoint[prefix.Length..]);
    }

    internal static bool ValidBinding(UpdateRestartChallenge binding) =>
        binding.Version == 1 && binding.Event == "update_restart_challenge" &&
        Guid.TryParseExact(binding.SessionId, "D", out var session) &&
        UpdateRuntimeLease.ValidDirectoryName($"worker-{binding.SessionId}") &&
        binding.SessionId == session.ToString("D") && UpdateRuntimeLease.ValidManifest(binding.Challenge) &&
        UpdateTrustVerifier.IsStableVersion(binding.ApplicationVersion) && UpdateRestartProof.ValidIdentity(binding.Identity);

    internal static bool Matches(UpdateRestartAuthentication message, UpdateRestartChallenge binding, string operation,
        string? challenge = null) =>
        message.Version == 1 && message.Event == operation && message.SessionId == binding.SessionId &&
        message.Challenge == binding.Challenge && message.Identity == binding.Identity &&
        message.ApplicationVersion == binding.ApplicationVersion && UpdateRuntimeLease.ValidManifest(message.AuthChallenge) &&
        (challenge is null || message.AuthChallenge == challenge);

    internal static UpdateRestartAuthentication Message(UpdateRestartChallenge binding, string operation, string challenge) =>
        new(1, operation, binding.SessionId, binding.Challenge, binding.Identity, binding.ApplicationVersion, challenge);

    internal static async Task<T> ReadAsync<T>(Stream stream, CancellationToken token) where T : class
    {
        var bytes = await FrameCodec.ReadAsync(stream, UpdateRestartHealth.MaximumMessageBytes, token);
        if (bytes is null) throw new UpdateHandoffException("update_restart_protocol");
        try { return JsonSerializer.Deserialize<T>(bytes, Options) ?? throw new UpdateHandoffException("update_restart_protocol"); }
        catch (JsonException) { throw new UpdateHandoffException("update_restart_protocol"); }
    }
}
