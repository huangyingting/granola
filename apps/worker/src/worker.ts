import { setTimeout as delay } from 'node:timers/promises';
import { PROMPT_VERSION, type AiProviders } from '@windows-ai-notes/ai';
import {
  ServiceError,
  resultSchema,
  segmentsSchema,
  validateSummary,
  type JobResult,
  type Segment,
} from '@windows-ai-notes/contracts/server';
import type { Database } from '@windows-ai-notes/db';

export async function runOnce(
  db: Database,
  providers: AiProviders,
  shutdown = new AbortController().signal,
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
    let result: JobResult;
    let transcript: Segment[] | undefined;
    if (job.input.kind === 'summary') {
      const generated = await providers.summarize(job.input.snapshot, signal);
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
      const generated = await providers.transcribe(
        job.audio,
        job.input.locale,
        signal,
      );
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
