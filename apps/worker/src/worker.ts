import {
  summaryPromptVersion,
  SUMMARY_USAGE_RESERVATION,
  summaryEvidence,
  type AiProviders,
} from '@windows-ai-notes/ai';
import { validateWav } from '@windows-ai-notes/ai/wav';
import {
  ServiceError,
  resultSchema,
  segmentsSchema,
  validateSummary,
  summarySnapshotCitations,
  type JobResult,
  type Segment,
} from '@windows-ai-notes/contracts/server';
import { digest, type Database } from '@windows-ai-notes/db';
import type { RecordingBlobs } from '@windows-ai-notes/storage';
import { transcribeRecording } from './recording.js';
import { withUsage } from './usage.js';
import { summarizeLongMeeting } from './summary.js';
import { summaryPreview } from './preview.js';
import { monitorLease } from './lease.js';
import { answerQuestion } from './chat.js';

export async function runOnce(
  db: Database,
  providers: AiProviders,
  shutdown = new AbortController().signal,
  storage: RecordingBlobs | null = null,
): Promise<boolean> {
  const question = await db.chat.claim();
  if (question) {
    await answerQuestion(db, providers, question, shutdown);
    return true;
  }
  const job = await db.claim();
  if (!job) return false;
  const lease = monitorLease(() => db.renew(job), { job_id: job.id }, shutdown);
  try {
    const signal = lease.signal;
    if (job.input.kind === 'recording_transcription') {
      if (!storage)
        throw new ServiceError(
          'storage_not_configured',
          'The worker needs private recording storage before it can transcribe saved audio.',
          503,
        );
      await transcribeRecording(db, job, providers, storage, signal);
      await db.finishRecording(job);
    } else {
      let result: JobResult;
      let transcript: Segment[] | undefined;
      if (job.input.kind === 'summary' && job.input.source) {
        result = await summarizeLongMeeting(db, job, providers, signal);
      } else if (job.input.kind === 'summary') {
        const snapshot = job.input.snapshot;
        const cached = await db.summaries.completed(job);
        if (cached) result = cached;
        else {
          const evidence = summaryEvidence(snapshot);
          signal.throwIfAborted();
          await db.summaries.begin(job, {
            provider: providers.provider,
            configurationVersion: providers.configurationVersion,
            pipelineVersion: 'direct-summary-v1',
          });
          const stage = {
            phase: 'generate' as const,
            round: 0,
            index: 0,
            input_hash: digest(evidence),
            prompt_version: summaryPromptVersion(snapshot),
            citations: summarySnapshotCitations(snapshot),
          };
          const prepared = await db.summaries.prepare(job, stage);
          if (prepared.state !== 'pending')
            throw new ServiceError(
              'summary_dispatch_unconfirmed',
              'The previous summary provider call has no saved output. Its usage is retained; explicitly confirm a resume before another request.',
              409,
            );
          const call = await db.summaries.sending(
            job,
            stage,
            SUMMARY_USAGE_RESERVATION,
          );
          const generated = await withUsage(db, call, (report) =>
            providers.summarize(
              snapshot,
              signal,
              report,
              summaryPreview(db, job),
            ),
          );
          result = {
            kind: 'summary',
            summary: validateSummary(generated.summary, snapshot),
            provider: providers.provider,
            configuration_version: providers.configurationVersion,
            prompt_version: stage.prompt_version,
            usage: generated.usage,
          };
          await db.summaries.save(job, stage, { kind: 'summary', result });
        }
      } else {
        if (!job.audio)
          throw new ServiceError(
            'recording_incomplete',
            'The queued audio clip is missing.',
            409,
          );
        const duration = validateWav(job.audio);
        signal.throwIfAborted();
        const call = await db.usage.start(job, {
          operation: 'clip',
          provider: providers.provider,
          configurationVersion: providers.configurationVersion,
          budget: {
            input_tokens: 0,
            output_tokens: 0,
            audio_ms: Math.ceil(duration),
          },
        });
        const audio = job.audio;
        const locale = job.input.locale;
        const generated = await withUsage(db, call, async (report) => {
          const output = await providers.transcribe(
            audio,
            locale,
            signal,
            (usage) => report({ ...usage, audio_ms: duration }),
          );
          return { ...output, usage: { ...output.usage, audio_ms: duration } };
        });
        transcript = segmentsSchema.parse(generated.segments);
        result = {
          kind: 'transcription',
          transcript_revision: job.input.base_transcript_revision + 1,
          segment_count: transcript.length,
          provider: providers.provider,
          configuration_version: providers.configurationVersion,
          usage: generated.usage,
        };
      }
      await db.finish(job, resultSchema.parse(result), null, transcript);
    }
  } catch (error) {
    const failure = shutdown.aborted
      ? new ServiceError(
          'worker_restarting',
          'The worker is restarting; this job can be retried.',
          503,
          true,
        )
      : error instanceof ServiceError
        ? error
        : new ServiceError(
            'internal_job_error',
            'The worker could not complete this job.',
            500,
          );
    console.error(JSON.stringify({ code: failure.code, job_id: job.id }));
    await db.finish(job, null, {
      code: failure.code,
      message: failure.message,
      retryable: job.input.kind !== 'summary' && failure.retryable,
    });
  } finally {
    await lease.stop();
  }
  return true;
}
