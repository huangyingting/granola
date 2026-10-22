import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClaimedJob, TaskCompletion } from '@windows-ai-notes/db';
import { observeCompletion, workerObservability } from './observability.js';

afterEach(() => vi.restoreAllMocks());
function claim(): ClaimedJob {
  return {
    id: randomUUID(),
    originRequestId: randomUUID(),
    acceptedToClaimMs: '9007199254740993',
    reclaimedLease: false,
    documentId: 'private-document',
    ownerId: 'private-owner',
    leaseToken: 1777,
    attempt: 1,
    audio: Buffer.from('private-audio'),
    input: {
      kind: 'transcription',
      locale: 'en-US',
      base_transcript_revision: 0,
      duration_ms: 1000,
    },
  };
}
function collector() {
  const rows: Record<string, unknown>[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { output, rows, telemetry: workerObservability(output) };
}

it('isolates concurrent attempt identities and worker instances without copying private claim data or fencing tokens', async () => {
  const captured = collector(),
    other = collector();
  const job = claim(),
    shutdown = new AbortController();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    const first = captured.telemetry.job(job, shutdown.signal);
    const second = captured.telemetry.job(job, shutdown.signal);
    other.telemetry.job(job, shutdown.signal).close();
    clock.mockReturnValue(125);
    await observeCompletion(second, async () => 'succeeded');
    first.lease('renewal_refused');
    first.lease('renewal_unavailable');
    first.complete('fenced');
    first.close();
    first.lease('renewal_unavailable');
    const starts = captured.rows.filter(
      (row) => row.code === 'worker_attempt_started',
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]!.attempt_id).not.toBe(starts[1]!.attempt_id);
    expect(starts[0]!.worker_instance_id).not.toBe(
      other.rows[0]!.worker_instance_id,
    );
    expect(starts[0]).toEqual({
      version: 1,
      code: 'worker_attempt_started',
      observed_at: expect.any(String),
      worker_instance_id: expect.any(String),
      attempt_id: expect.any(String),
      job_id: job.id,
      turn_id: null,
      origin_request_id: job.originRequestId,
      task_kind: 'transcription',
      attempt: 1,
      acceptance_to_claim_ms: '9007199254740993',
      reclaimed_lease: false,
    });
    expect(
      captured.rows.filter((row) => row.code === 'worker_lease_observed'),
    ).toHaveLength(1);
    expect(captured.rows.at(-1)).toMatchObject({
      completion: 'fenced',
      processing_ms: 25,
      completion_errors: 0,
      lease_observation: 'renewal_refused',
      shutdown_requested: false,
    });
    expect(JSON.stringify(captured.rows)).not.toContain('private-');
    expect(
      captured.rows.every(
        (row) => !('lease_token' in row) && !('leaseToken' in row),
      ),
    ).toBe(true);
  } finally {
    captured.telemetry.close();
    other.telemetry.close();
  }
  expect(captured.output.listenerCount('error')).toBe(0);
});

it.each<TaskCompletion>([
  'succeeded',
  'failed',
  'retry_wait',
  'cancelled',
  'fenced',
])(
  'reports committed completion decision %s exactly once',
  async (completion) => {
    const captured = collector();
    const shutdown = new AbortController();
    try {
      const measured = captured.telemetry.job(
        {
          ...claim(),
          originRequestId: null,
          acceptedToClaimMs: null,
          reclaimedLease: true,
        },
        shutdown.signal,
      );
      shutdown.abort();
      await observeCompletion(measured, async () => completion);
      measured.close();
      expect(captured.rows).toHaveLength(2);
      expect(captured.rows[1]).toMatchObject({
        completion,
        origin_request_id: null,
        acceptance_to_claim_ms: null,
        reclaimed_lease: true,
        shutdown_requested: true,
        lease_observation: 'unobserved',
      });
    } finally {
      captured.telemetry.close();
    }
  },
);

it('rethrows finalization failures and records unobserved completion instead of inventing a persisted failed state', async () => {
  const captured = collector();
  try {
    const measured = captured.telemetry.job(
      claim(),
      new AbortController().signal,
    );
    const failure = new Error('private-transaction-error');
    await expect(
      observeCompletion(measured, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    measured.close();
    expect(captured.rows[1]).toMatchObject({
      completion: 'unobserved',
      completion_errors: 1,
    });
    expect(JSON.stringify(captured.rows)).not.toContain('private-');
    const operation = vi.fn(async (): Promise<TaskCompletion> => 'failed');
    await observeCompletion(undefined, operation);
    expect(operation).toHaveBeenCalledOnce();
  } finally {
    captured.telemetry.close();
  }
});

it('bounds blocked attempt output and explicitly reports omissions', async () => {
  const rows: Record<string, unknown>[] = [],
    callbacks: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      callbacks.push(done);
    },
  });
  const telemetry = workerObservability(output);
  try {
    telemetry.job(claim(), new AbortController().signal).complete('succeeded');
    telemetry.job(claim(), new AbortController().signal).close();
    expect(rows).toHaveLength(1);
    expect(output.writableLength).toBeLessThan(2048);
    callbacks.shift()!();
    await vi.waitFor(() => expect(rows).toHaveLength(2));
    expect(rows[1]).toMatchObject({
      code: 'worker_telemetry_dropped',
      count: '3',
    });
  } finally {
    for (const done of callbacks) done();
    telemetry.close();
    output.destroy();
  }
});

it('reports sink failure without changing authoritative completion operations', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('private-sink-error'));
    },
  });
  const telemetry = workerObservability(output);
  try {
    const measured = telemetry.job(claim(), new AbortController().signal);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    const operation = vi.fn(async (): Promise<TaskCompletion> => 'succeeded');
    await observeCompletion(measured, operation);
    expect(operation).toHaveBeenCalledOnce();
  } finally {
    telemetry.close();
  }
  expect(
    errors.mock.calls.map(([line]) => JSON.parse(String(line))),
  ).toContainEqual(
    expect.objectContaining({ code: 'worker_telemetry_unavailable' }),
  );
  expect(JSON.stringify(errors.mock.calls)).not.toContain('private-');
});
