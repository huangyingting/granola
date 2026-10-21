import { setTimeout as delay } from 'node:timers/promises';
import {
  PROMPT_VERSION,
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
  type JobResult,
  type Segment,
} from '@windows-ai-notes/contracts/server';
import type { Database } from '@windows-ai-notes/db';
import type { RecordingBlobs } from '@windows-ai-notes/storage';
import { transcribeRecording } from './recording.js';
import { withUsage } from './usage.js';

export async function runOnce(
  db: Database,
  providers: AiProviders,
  shutdown = new AbortController().signal,
  storage: RecordingBlobs | null = null,
): Promise<boolean> {
  const job = await db.claim();
  if (!job) return false;
  const providerAbort = new AbortController();
  const monitorStop = new AbortController();
  const monitor = (async () => {
    try {
      while (!monitorStop.signal.aborted) {
        await delay(5000, undefined, { signal: monitorStop.signal });
        if (!(await db.renew(job))) {
          providerAbort.abort();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error(
          JSON.stringify({ code: 'lease_renewal_failed', job_id: job.id }),
        );
        providerAbort.abort();
      }
    }
  })();
  try {
    const signal = AbortSignal.any([shutdown, providerAbort.signal]);
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
      if (job.input.kind === 'summary') {
        summaryEvidence(job.input.snapshot);
        signal.throwIfAborted();
        const call = await db.usage.start(job, {
          operation: 'summary',
          provider: providers.provider,
          configurationVersion: providers.configurationVersion,
          budget: SUMMARY_USAGE_RESERVATION,
        });
        const snapshot = job.input.snapshot;
        const generated = await withUsage(db, call, (report) =>
          providers.summarize(snapshot, signal, report),
        );
        result = {
          kind: 'summary',
          summary: validateSummary(generated.summary, job.input.snapshot),
          provider: providers.provider,
          configuration_version: providers.configurationVersion,
          prompt_version: PROMPT_VERSION,
          usage: generated.usage,
        };
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
      retryable: failure.retryable,
    });
  } finally {
    monitorStop.abort();
    await monitor;
  }
  return true;
}
