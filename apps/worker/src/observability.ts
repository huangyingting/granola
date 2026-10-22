import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { boundedTelemetry } from '@windows-ai-notes/ai/telemetry';
import type {
  ClaimedChat,
  ClaimedJob,
  TaskCompletion,
} from '@windows-ai-notes/db';
import type { LeaseObservation } from './lease.js';

type AttemptCode =
  | 'worker_attempt_started'
  | 'worker_attempt_completed'
  | 'worker_lease_observed';

export function workerObservability(output: Writable = process.stdout) {
  const instance = randomUUID();
  const telemetry = boundedTelemetry(output, 'worker');
  const start = (
    claim: ClaimedJob | ClaimedChat,
    kind: ClaimedJob['input']['kind'] | 'chat',
    shutdown: AbortSignal,
  ) => {
    const context = {
      worker_instance_id: instance,
      attempt_id: randomUUID(),
      task_kind: kind,
      job_id: kind === 'chat' ? null : claim.id,
      turn_id: kind === 'chat' ? claim.id : null,
      origin_request_id: claim.originRequestId,
      attempt: claim.attempt,
      acceptance_to_claim_ms: claim.acceptedToClaimMs,
      reclaimed_lease: claim.reclaimedLease,
    };
    const emit = (code: AttemptCode, fields: object) =>
      telemetry.emit({
        version: 1,
        code,
        observed_at: new Date().toISOString(),
        ...context,
        ...fields,
      });
    const measured = new AttemptMeasurements(emit, shutdown);
    emit('worker_attempt_started', {});
    return measured;
  };
  return {
    job: (claim: ClaimedJob, shutdown: AbortSignal) =>
      start(claim, claim.input.kind, shutdown),
    chat: (claim: ClaimedChat, shutdown: AbortSignal) =>
      start(claim, 'chat', shutdown),
    close: () => telemetry.close(),
  };
}
export type WorkerObservability = ReturnType<typeof workerObservability>;

export class AttemptMeasurements {
  private readonly started = performance.now();
  private finished = false;
  private completionErrors = 0;
  private observation: LeaseObservation | 'unobserved' = 'unobserved';
  constructor(
    private readonly emit: (code: AttemptCode, fields: object) => void,
    private readonly shutdown: AbortSignal,
  ) {}
  lease(observation: LeaseObservation) {
    if (this.finished || this.observation !== 'unobserved') return;
    this.observation = observation;
    this.emit('worker_lease_observed', {
      observation,
      elapsed_ms: Math.round(performance.now() - this.started),
    });
  }
  completionFailed() {
    this.completionErrors++;
  }
  complete(completion: TaskCompletion | 'unobserved') {
    if (this.finished) return;
    this.finished = true;
    this.emit('worker_attempt_completed', {
      completion,
      processing_ms: Math.round(performance.now() - this.started),
      completion_errors: this.completionErrors,
      lease_observation: this.observation,
      shutdown_requested: this.shutdown.aborted,
    });
  }
  close() {
    this.complete('unobserved');
  }
}

export async function observeCompletion(
  measured: AttemptMeasurements | undefined,
  operation: () => Promise<TaskCompletion>,
) {
  try {
    const outcome = await operation();
    measured?.complete(outcome);
  } catch (error) {
    measured?.completionFailed();
    throw error;
  }
}
