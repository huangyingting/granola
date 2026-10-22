import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { uploadObservability } from './upload-observability.js';

afterEach(() => vi.restoreAllMocks());

function collector() {
  const rows: Record<string, unknown>[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { output, rows };
}

it.each([false, true])(
  'reports one actual verification result, monotonic processing time and observed abort=%s',
  async (aborted) => {
    const captured = collector();
    const app = Fastify();
    const observer = uploadObservability(app, captured.output);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const request = randomUUID();
    try {
      const measured = observer.start(request);
      measured.stage('commit');
      now.mockReturnValue(1025);
      measured.verified(aborted);
      measured.verified(false);
      measured.failed(new Error('private-late-error'), false);
      expect(captured.rows).toEqual([
        {
          code: 'upload_verification_completed',
          finished_at: expect.any(String),
          request_id: request,
          stage: 'commit',
          outcome: 'verified',
          aborted,
          duration_ms: 25,
        },
      ]);
    } finally {
      await app.close();
    }
    expect(captured.output.listenerCount('error')).toBe(0);
  },
);

it.each([
  'checksum_mismatch',
  'invalid_audio',
  'upload_missing',
  'storage_unavailable',
  'immutable_object_conflict',
  'recording_not_found',
  'document_not_found',
  'recording_retention_expired',
  'verification_superseded',
])(
  'classifies %s without copying provider or resource error details',
  async (code) => {
    const captured = collector();
    const app = Fastify();
    const observer = uploadObservability(app, captured.output);
    try {
      const error = new ServiceError(code, 'private-message', 409, false, {
        purge_workspace_id: 'private-document',
      });
      error.name = 'private-error-name';
      const measured = observer.start(randomUUID());
      measured.stage('validate');
      measured.failed(error, false);
      expect(captured.rows[0]).toMatchObject({
        outcome: code,
        stage: 'validate',
      });
      expect(JSON.stringify(captured.rows)).not.toContain('private-');
    } finally {
      await app.close();
    }
  },
);

it.each([
  new ServiceError('private-arbitrary-code', 'private-message', 500),
  new ServiceError('__proto__', 'private-message', 500),
  Object.assign(new Error('private-message'), {
    name: 'private-name',
    code: 'checksum_mismatch',
  }),
  'private-thrown-value',
])('keeps unsupported failures explicit and body-free: %j', async (error) => {
  const captured = collector();
  const app = Fastify();
  const observer = uploadObservability(app, captured.output);
  try {
    observer.start(randomUUID()).failed(error, true);
    expect(captured.rows[0]).toMatchObject({
      stage: 'read',
      outcome: 'operation_failed',
      aborted: true,
    });
    expect(JSON.stringify(captured.rows)).not.toContain('private-');
  } finally {
    await app.close();
  }
});

it('bounds blocked output and reports exact omissions instead of queuing verification events', async () => {
  const rows: Record<string, unknown>[] = [];
  const callbacks: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      callbacks.push(done);
    },
  });
  const app = Fastify();
  const observer = uploadObservability(app, output);
  try {
    for (let index = 0; index < 3; index++)
      observer.start(randomUUID()).failed(new Error('private-error'), false);
    expect(rows).toHaveLength(1);
    expect(output.writableLength).toBeLessThan(1024);
    callbacks.shift()!();
    await vi.waitFor(() => expect(rows).toHaveLength(2));
    expect(rows[1]).toMatchObject({
      code: 'upload_verification_telemetry_dropped',
      count: '2',
    });
  } finally {
    for (const done of callbacks) done();
    await app.close();
    output.destroy();
  }
});

it('reports output failure without exposing its cause or interrupting verification bookkeeping', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('private-sink-error'));
    },
  });
  const app = Fastify();
  const observer = uploadObservability(app, output);
  try {
    observer.start(randomUUID()).verified(false);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(() => observer.start(randomUUID()).verified(false)).not.toThrow();
  } finally {
    await app.close();
  }
  const rows = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(rows).toContainEqual(
    expect.objectContaining({
      code: 'upload_verification_telemetry_unavailable',
    }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({
      code: 'upload_verification_telemetry_dropped',
      count: '1',
    }),
  );
  expect(JSON.stringify(rows)).not.toContain('private-');
});
