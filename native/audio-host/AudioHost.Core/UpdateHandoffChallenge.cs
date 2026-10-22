using System.Security.Cryptography;
using System.Text.Json;
using WindowsAiNotes.Audio;

namespace WindowsAiNotes.Updates;

public sealed record UpdateHandoffDecision(int Version, string Operation, string Challenge);

public sealed class UpdateHandoffException(string code) : IOException($"The update handoff was rejected ({code}).")
{
    public string Code { get; } = code;
}

public sealed class UpdateHandoffChallenge
{
    public const int MaximumMessageBytes = 1024;
    private static readonly JsonSerializerOptions Options = new(AudioJson.Options)
    {
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        MaxDepth = 8
    };
    private readonly byte[] challenge = RandomNumberGenerator.GetBytes(32);
    private int consumed;
    public string Value => Convert.ToHexStringLower(challenge);

    public string Consume(ReadOnlySpan<byte> message)
    {
        if (Interlocked.Exchange(ref consumed, 1) != 0)
            throw new UpdateHandoffException("update_handoff_consumed");
        if (message.Length is 0 or > MaximumMessageBytes)
            throw new UpdateHandoffException("update_handoff_protocol");
        UpdateHandoffDecision? decision;
        try { decision = JsonSerializer.Deserialize<UpdateHandoffDecision>(message, Options); }
        catch (JsonException) { throw new UpdateHandoffException("update_handoff_protocol"); }
        if (decision is null || decision.Version != 1 || decision.Operation is not ("commit" or "cancel") ||
            decision.Challenge is not { Length: 64 } ||
            decision.Challenge.Any(c => c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            throw new UpdateHandoffException("update_handoff_protocol");
        if (!CryptographicOperations.FixedTimeEquals(challenge, Convert.FromHexString(decision.Challenge)))
            throw new UpdateHandoffException("update_handoff_challenge");
        return decision.Operation;
    }
}
