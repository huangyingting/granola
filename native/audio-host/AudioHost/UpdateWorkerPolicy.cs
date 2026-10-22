using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

internal sealed record UpdateWorkerPolicy(int Version, string FeedUrl, string CertificateSha256, string Publisher, string ProductName)
{
    private static readonly JsonSerializerOptions Options = new(AudioJson.Options)
    {
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        MaxDepth = 8
    };

    internal static UpdateWorkerPolicy Read(string application)
    {
        var path = Path.Combine(Path.GetDirectoryName(application)!, "resources", "update-policy.json");
        UpdateInstallationVerifier.RequireRegularPath(path, directory: false);
        using var handle = UpdatePathLock.OpenFile(path);
        using var stream = new FileStream(handle, FileAccess.Read);
        if (stream.Length is <= 0 or > 16_384)
            throw new UpdateHandoffException("update_policy_invalid");
        var bytes = new byte[(int)stream.Length];
        stream.ReadExactly(bytes);
        return Parse(bytes);
    }

    internal static UpdateWorkerPolicy Parse(ReadOnlySpan<byte> bytes)
    {
        UpdateWorkerPolicy? policy;
        try { policy = JsonSerializer.Deserialize<UpdateWorkerPolicy>(bytes, Options); }
        catch (JsonException) { throw new UpdateHandoffException("update_policy_invalid"); }
        if (policy is null || policy.Version != 1 || policy.FeedUrl is not { Length: > 0 and <= 2048 } ||
            !Uri.TryCreate(policy.FeedUrl, UriKind.Absolute, out var feed) || feed.Scheme != "https" ||
            feed.AbsoluteUri != policy.FeedUrl || feed.UserInfo.Length != 0 || feed.Query.Length != 0 || feed.Fragment.Length != 0 ||
            policy.FeedUrl.Contains('?') || policy.FeedUrl.Contains('#') || !feed.AbsolutePath.EndsWith(".json", StringComparison.Ordinal) ||
            !UpdateRuntimeLease.ValidManifest(policy.CertificateSha256 ?? "") || !ValidLabel(policy.Publisher) ||
            !ValidLabel(policy.ProductName) || policy.ProductName.Any(c => c is '\\' or '/' or ':' or '"' or '<' or '>' or '|' or '?' or '*'))
            throw new UpdateHandoffException("update_policy_invalid");
        return policy;
    }

    internal UpdateTrustPolicy Trust(string version) => new(CertificateSha256, Publisher, ProductName, version);
    private static bool ValidLabel(string? value) => value is { Length: > 0 and <= 200 } &&
        value == value.Trim() && !value.Any(char.IsControl);
}
