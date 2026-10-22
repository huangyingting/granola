import {
  SUMMARY_USAGE_RESERVATION,
  type AiProviders,
} from '@windows-ai-notes/ai';
import { ServiceError, type Usage } from '@windows-ai-notes/contracts/server';
import {
  insufficientQuestionEvidence,
  questionPromptVersion,
  type QuestionAnswer,
} from '@windows-ai-notes/contracts/questions';
import type { Database, ClaimedChat } from '@windows-ai-notes/db';
import { monitorLease } from './lease.js';
import { generationPreview } from './preview.js';
import { withUsage } from './usage.js';
import {
  observeCompletion,
  type AttemptMeasurements,
} from './observability.js';

export async function answerQuestion(
  db: Database,
  providers: AiProviders,
  claim: ClaimedChat,
  shutdown: AbortSignal,
  measured?: AttemptMeasurements,
) {
  const lease = monitorLease(
    () => db.chat.renew(claim),
    { turn_id: claim.id },
    shutdown,
    (value) => {
      measured?.lease(value);
      return undefined;
    },
  );
  try {
    lease.signal.throwIfAborted();
    let generated: { answer: QuestionAnswer; usage: Usage };
    if (!claim.evidence.units.length) {
      generated = {
        answer: insufficientQuestionEvidence(claim.evidence.language),
        usage: { input_tokens: 0, output_tokens: 0, audio_ms: 0 },
      };
    } else {
      if (!providers.answer)
        throw new ServiceError(
          'question_provider_unavailable',
          'This worker does not support current-meeting answers.',
          503,
        );
      const call = await db.chat.sending(claim, {
        operation: 'question-answer',
        provider: providers.provider,
        configurationVersion: providers.configurationVersion,
        budget: SUMMARY_USAGE_RESERVATION,
      });
      const answer = providers.answer.bind(providers);
      generated = await withUsage(db, call, (report) =>
        answer(
          claim.evidence,
          lease.signal,
          report,
          generationPreview((text) => db.chat.preview(claim, text)),
        ),
      );
    }
    await observeCompletion(measured, async () => {
      await db.chat.complete(claim, {
        ...generated,
        provider: providers.provider,
        configuration_version: providers.configurationVersion,
        prompt_version: questionPromptVersion(claim.evidence),
      });
      return 'succeeded';
    });
  } catch (error) {
    const failure = shutdown.aborted
      ? new ServiceError(
          'worker_restarting',
          'The worker restarted. Refresh and explicitly confirm question recovery.',
          503,
        )
      : error instanceof ServiceError
        ? error
        : new ServiceError(
            'internal_question_error',
            'The worker could not complete this question.',
            500,
          );
    console.error(JSON.stringify({ code: failure.code, turn_id: claim.id }));
    await observeCompletion(measured, () =>
      db.chat.failOutcome(claim, {
        code: failure.code,
        message: failure.message,
        retryable: false,
      }),
    );
  } finally {
    try {
      measured?.close();
    } finally {
      await lease.stop();
    }
  }
}
