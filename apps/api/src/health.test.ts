import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { createServer } from './server.js';

let db: Database;
let app: Awaited<ReturnType<typeof createServer>>;
const headers = { 'x-dev-subject': randomUUID() };
const result = {
  command: 'SELECT',
  rowCount: 1,
  oid: 0,
  fields: [],
  rows: [{ '?column?': 1 }],
};

beforeEach(async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  db = new Database('postgresql://synthetic:synthetic@127.0.0.1:1/unused');
  vi.spyOn(db, 'assertReady').mockResolvedValue(undefined);
  vi.spyOn(db, 'identify').mockResolvedValue(randomUUID());
  vi.spyOn(db.pool, 'query').mockImplementation(async () => result);
  app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
});

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    try {
      await db?.close();
    } finally {
      vi.restoreAllMocks();
    }
  }
});

it('a business burst does not falsely mark a healthy service unavailable', async () => {
  for (let index = 0; index < 120; index++)
    expect((await app.inject({ url: '/v1/me', headers })).statusCode).toBe(200);
  expect((await app.inject({ url: '/v1/me', headers })).statusCode).toBe(429);
  expect((await app.inject('/health')).statusCode).toBe(200);
  expect((await app.inject('/health/live')).statusCode).toBe(200);
  const limited = await app.inject({ url: '/v1/me', headers });
  expect(limited.statusCode).toBe(429);
  expect(limited.json()).toMatchObject({
    code: 'rate_limited',
    retryable: true,
  });
});

it.each(['/health', '/health/live'])(
  'bounds the %s budget without consuming the API or other probe budget',
  async (url) => {
    for (let index = 0; index < 120; index++)
      expect((await app.inject(url)).statusCode).toBe(200);
    expect((await app.inject(url)).statusCode).toBe(429);
    expect((await app.inject({ url: '/v1/me', headers })).statusCode).toBe(200);
    expect(
      (await app.inject(url === '/health' ? '/health/live' : '/health'))
        .statusCode,
    ).toBe(200);
  },
);

it('allows anonymous GET and HEAD liveness without querying the database', async () => {
  const response = await app.inject('/health/live');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
  expect(response.headers).toMatchObject({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': expect.any(String),
  });
  const head = await app.inject({ method: 'HEAD', url: '/health/live' });
  expect(head.statusCode).toBe(200);
  expect(head.body).toBe('');
  expect(db.pool.query).not.toHaveBeenCalled();
  expect(db.identify).not.toHaveBeenCalled();
});

it('does not expand the unauthenticated API surface beyond the exact probe routes', async () => {
  expect((await app.inject('/v1/me')).statusCode).toBe(401);
  expect((await app.inject('/health/live/private')).statusCode).toBe(401);
  expect(db.pool.query).not.toHaveBeenCalled();
  expect(db.identify).not.toHaveBeenCalled();
});

it('readiness observes outage and recovery without caching success or failure or leaking errors', async () => {
  expect((await app.inject('/health')).statusCode).toBe(200);
  vi.mocked(db.pool.query).mockImplementationOnce(async () => {
    throw new Error('private-health-error-marker');
  });
  const unavailable = await app.inject('/health');
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json()).toMatchObject({
    code: 'database_unavailable',
    retryable: true,
  });
  expect((await app.inject('/health/live')).statusCode).toBe(200);
  expect((await app.inject('/health')).statusCode).toBe(200);
  expect(db.pool.query).toHaveBeenCalledTimes(3);
  expect(
    JSON.stringify([
      unavailable.body,
      ...vi.mocked(process.stdout.write).mock.calls,
    ]),
  ).not.toContain('private-');
});

it.each([false, true])(
  'overlapping readiness probes share one database query (failure = %s)',
  async (failure) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(db.pool.query).mockImplementation(async () => {
      await blocked;
      if (failure) throw new Error('private-health-error-marker');
      return result;
    });
    let entered = 0;
    app.addHook('preHandler', async (request) => {
      if (request.routeOptions.url === '/health') entered++;
    });
    const pending = Promise.all(
      Array.from({ length: 8 }, () => app.inject('/health')),
    );
    try {
      await vi.waitFor(() => expect(entered).toBe(8), {
        timeout: 5000,
        interval: 10,
      });
      expect(db.pool.query).toHaveBeenCalledTimes(1);
      expect((await app.inject('/health/live')).statusCode).toBe(200);
    } finally {
      release();
      await pending;
    }
    expect((await pending).map((response) => response.statusCode)).toEqual(
      Array.from({ length: 8 }, () => (failure ? 503 : 200)),
    );
  },
);
