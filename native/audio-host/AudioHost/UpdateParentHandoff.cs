using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateParentReady(int Version, string Event, string Challenge, UpdateParentIdentity Parent);
public sealed record UpdateParentCommitted(int Version, string Event, UpdateParentIdentity Parent);

public static class UpdateParentHandoff
{
    // The caller owns these private channels and must close them after a failed handoff.
    public static Task WaitForCommittedExitAsync(UpdateParentLease parent, Stream input, Stream output,
        CancellationToken token = default) =>
        WaitForCommittedExitAsync(parent, input, output, TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2), token);

    internal static async Task WaitForCommittedExitAsync(UpdateParentLease parent, Stream input, Stream output,
        TimeSpan prepareTimeout, TimeSpan exitTimeout, CancellationToken token = default)
    {
        using var prepare = CancellationTokenSource.CreateLinkedTokenSource(token);
        using var exit = CancellationTokenSource.CreateLinkedTokenSource(token);
        try
        {
            token.ThrowIfCancellationRequested();
            if (parent.HasExited) throw new UpdateHandoffException("update_parent_missing");
            var challenge = new UpdateHandoffChallenge();
            prepare.CancelAfter(prepareTimeout);
            await FrameCodec.WriteJsonAsync(output,
                new UpdateParentReady(1, "update_parent_ready", challenge.Value, parent.Identity), prepare.Token).WaitAsync(prepare.Token);
            var message = await FrameCodec.ReadAsync(input, UpdateHandoffChallenge.MaximumMessageBytes, prepare.Token).WaitAsync(prepare.Token);
            if (message is null) throw new UpdateHandoffException("update_handoff_closed");
            var operation = challenge.Consume(message);
            if (operation == "cancel") throw new UpdateHandoffException("update_handoff_cancelled");
            if (parent.HasExited) throw new UpdateHandoffException("update_parent_missing");
            await FrameCodec.WriteJsonAsync(output,
                new UpdateParentCommitted(1, "update_parent_committed", parent.Identity), prepare.Token).WaitAsync(prepare.Token);
            prepare.Token.ThrowIfCancellationRequested();
            prepare.CancelAfter(Timeout.InfiniteTimeSpan);
            exit.CancelAfter(exitTimeout);
            await parent.WaitForExitAsync(exit.Token);
            exit.Token.ThrowIfCancellationRequested();
        }
        catch (UpdateHandoffException) { throw; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested &&
            (prepare.IsCancellationRequested || exit.IsCancellationRequested))
        {
            throw new UpdateHandoffException("update_handoff_timeout");
        }
        catch (AudioException)
        {
            throw new UpdateHandoffException("update_handoff_protocol");
        }
        catch (IOException)
        {
            throw new UpdateHandoffException("update_handoff_io");
        }
    }
}
