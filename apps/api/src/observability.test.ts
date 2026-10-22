import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { registerRequestObservability } from './observability.js';
import { createServer } from './server.js';

afterEach(() => vi.restoreAllMocks());

it('logs only registered route templates, generated IDs, status and actual elapsed time', async () => {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  registerRequestObservability(app, output);
  app.post('/v1/test/:id', async () => ({ answer: 'private-response-marker' }));
  try {
    await app.inject({
      method: 'POST',
      url: '/v1/test/private-path-marker?signature=private-query-marker',
      headers: {
        'x-request-id': 'private-request-id-marker',
        authorization: 'Bearer private-token-marker',
        cookie: 'session=private-cookie-marker',
      },
      payload: { notes: 'private-meeting-marker' },
    });
    await app.inject({
      method: 'GET',
      url: '/private-unmatched-marker?secret=private-query-marker',
    });
    const first: unknown = JSON.parse(lines[0]!);
    expect(first).toEqual({
      code: 'http_request_completed',
      finished_at: expect.stringMatching(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      ),
      request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      method: 'POST',
      route: '/v1/test/:id',
      status_code: 200,
      duration_ms: expect.any(Number),
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      method: 'GET',
      route: null,
      status_code: 404,
    });
    expect(JSON.stringify(lines)).not.toContain('private-');
  } finally {
    await app.close();
  }
});

it('bounds buffered telemetry under backpressure and reports exact dropped counts before resuming', async () => {
  const lines: string[] = [];
  const callbacks: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      callbacks.push(done);
    },
  });
  const app = Fastify({ logger: false });
  registerRequestObservability(app, output);
  app.get('/test', async () => ({ ok: true }));
  try {
    for (let index = 0; index < 3; index++)
      expect((await app.inject('/test')).statusCode).toBe(200);
    expect(lines).toHaveLength(1);
    expect(output.writableLength).toBeLessThan(1024);
    callbacks.shift()!();
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(JSON.parse(lines[1]!)).toMatchObject({
      code: 'http_request_telemetry_dropped',
      count: '2',
    });
    callbacks.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await app.inject('/test')).statusCode).toBe(200);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toMatchObject({
      code: 'http_request_completed',
      route: '/test',
    });
  } finally {
    for (const callback of callbacks) callback();
    await app.close();
    output.destroy();
  }
});

it('reports a failed output without leaking its exception or changing completed application responses', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('private-output-failure-marker'));
    },
  });
  const app = Fastify({ logger: false });
  registerRequestObservability(app, output);
  app.get('/test', async () => ({ ok: true }));
  try {
    expect((await app.inject('/test')).statusCode).toBe(200);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({
      code: 'http_request_telemetry_unavailable',
    });
    expect((await app.inject('/test')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
  expect(JSON.stringify(error.mock.calls)).not.toContain('private-');
  expect(
    error.mock.calls.map(([line]) => JSON.parse(String(line))),
  ).toContainEqual(
    expect.objectContaining({
      code: 'http_request_telemetry_dropped',
      count: '1',
    }),
  );
});

it('the real API cannot leak custom error names, request headers or meeting bodies into diagnostics', async () => {
  const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const db = new Database('postgresql://unused:unused@127.0.0.1:1/unused');
  vi.spyOn(db, 'identify').mockResolvedValue(randomUUID());
  vi.spyOn(db.usage, 'snapshot').mockRejectedValue(
    Object.assign(new Error('private-error-message-marker'), {
      name: 'private-error-name-marker',
    }),
  );
  const app = await createServer(db, {
    mode: 'development',
    host: '127.0.0.1',
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage?signature=private-signed-url-marker',
      headers: {
        'x-dev-subject': randomUUID(),
        'x-request-id': 'private-request-id-marker',
      },
    });
    expect(response.statusCode).toBe(500);
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        code: 'internal_error',
        request_id: response.json().request_id,
        kind: 'error',
      }),
    );
    expect(
      JSON.stringify([...log.mock.calls, ...error.mock.calls]),
    ).not.toContain('private-');
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      request_id: response.json().request_id,
      status_code: 500,
      route: '/v1/usage',
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/operations',
          headers: { 'x-dev-subject': randomUUID() },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    await db.close();
  }
});
