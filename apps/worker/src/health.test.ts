import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { loadWorkerHealthPort, startWorkerHealth } from './health.js';

describe('optional Worker health configuration', () => {
  it('does not enable a listener by default', () => {
    expect(loadWorkerHealthPort({})).toBeUndefined();
  });
  it.each(['1', '4412', '65535'])('accepts the explicit port %s', (port) => {
    expect(loadWorkerHealthPort({ WORKER_HEALTH_PORT: port })).toBe(
      Number(port),
    );
  });
  it.each([
    '',
    '0',
    '-1',
    '65536',
    '4e3',
    '04412',
    '+4412',
    '4412 ',
    'NaN',
    'Infinity',
    '127.0.0.1:4412',
  ])('rejects invalid configuration %j before startup', (port) => {
    expect(() => loadWorkerHealthPort({ WORKER_HEALTH_PORT: port })).toThrow(
      'WORKER_HEALTH_PORT',
    );
  });
  it('rejects invalid configuration through the compiled entry point before requiring Azure credentials', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
      {
        env: {
          NODE_ENV: 'test',
          WORKER_HEALTH_PORT: 'private-health-port-value',
        },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4096,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('worker_health_configuration_invalid');
    expect(result.stderr).not.toContain('private-health-port-value');
    expect(result.stderr).not.toContain('AZURE_OPENAI');
  });
});

describe('private loopback Worker startup and database readiness', () => {
  let db: Database;
  let health: Awaited<ReturnType<typeof startWorkerHealth>>;
  let shutdown: AbortController;
  const queryResult = {
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [{ '?column?': 1 }],
  };
  beforeEach(async () => {
    shutdown = new AbortController();
    db = new Database('postgres://unused:unused@127.0.0.1:1/unused');
    vi.spyOn(db.pool, 'query').mockImplementation(async () => queryResult);
    health = await startWorkerHealth(0, db, shutdown.signal);
  });
  afterEach(async () => {
    try {
      await health?.close();
    } finally {
      try {
        await db?.close();
      } finally {
        vi.restoreAllMocks();
      }
    }
  });
  async function probe(path = '/health') {
    const response = await fetch(health.url + path, {
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  }
  it('binds only loopback and does not query the database or announce readiness before initialization', async () => {
    expect(new URL(health.url).hostname).toBe('127.0.0.1');
    const response = await probe();
    expect(response.status).toBe(503);
    expect(response.body).toBe('{"status":"unavailable"}');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await probe('/health/live')).status).toBe(200);
    expect(db.pool.query).not.toHaveBeenCalled();
  });
  it('checks actual database availability after initialization without caching successes or failures', async () => {
    health.markReady();
    expect((await probe()).status).toBe(200);
    expect(db.pool.query).toHaveBeenLastCalledWith('SELECT 1');
    vi.mocked(db.pool.query).mockRejectedValueOnce(
      new Error('private-database-health-error'),
    );
    const failed = await probe();
    expect(failed.status).toBe(503);
    expect(failed.body).toBe('{"status":"unavailable"}');
    expect((await probe('/health/live')).status).toBe(200);
    expect((await probe()).status).toBe(200);
    expect(db.pool.query).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])(
    'coalesces simultaneous readiness queries but not later probes (failure: %j)',
    async (failure) => {
      health.markReady();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(db.pool.query).mockImplementation(async () => {
        await blocked;
        if (failure) throw new Error('private-health-error');
        return queryResult;
      });
      const checks = vi.spyOn(db, 'checkHealth');
      const pending = Promise.all(Array.from({ length: 8 }, () => probe()));
      try {
        await vi.waitFor(() => expect(checks).toHaveBeenCalledTimes(8));
        expect(db.pool.query).toHaveBeenCalledTimes(1);
        expect((await probe('/health/live')).status).toBe(200);
      } finally {
        release();
        await pending;
      }
      expect((await pending).map((response) => response.status)).toEqual(
        Array.from({ length: 8 }, () => (failure ? 503 : 200)),
      );
      vi.mocked(db.pool.query).mockImplementation(async () => queryResult);
      expect((await probe()).status).toBe(200);
      expect(db.pool.query).toHaveBeenCalledTimes(2);
    },
  );
  it('does not publish a successful readiness result when shutdown happens during the SQL check', async () => {
    health.markReady();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(db.pool.query).mockImplementation(async () => {
      await blocked;
      return queryResult;
    });
    const pending = probe();
    try {
      await vi.waitFor(() => expect(db.pool.query).toHaveBeenCalledOnce());
      shutdown.abort();
      expect(() => health.markReady()).toThrow('stopping Worker');
    } finally {
      release();
    }
    expect((await pending).status).toBe(503);
    expect((await probe('/health/live')).status).toBe(200);
    expect((await probe()).status).toBe(503);
    expect(db.pool.query).toHaveBeenCalledTimes(1);
  });
  it('drains in-flight SQL before closing and never returns late readiness success', async () => {
    health.markReady();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(db.pool.query).mockImplementation(async () => {
      await blocked;
      return queryResult;
    });
    const pending = probe();
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(db.pool.query).toHaveBeenCalledOnce());
      closing = health.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
    } finally {
      release();
    }
    expect((await pending).status).toBe(503);
    await closing;
    expect(closed).toBe(true);
    expect(() => health.markReady()).toThrow('stopping Worker');
    await expect(probe()).rejects.toThrow();
  });
  it('does not report readiness or query SQL after a pre-initialization shutdown', async () => {
    shutdown.abort();
    expect(() => health.markReady()).toThrow('stopping Worker');
    expect((await probe()).status).toBe(503);
    expect((await probe('/health/live')).status).toBe(200);
    expect(db.pool.query).not.toHaveBeenCalled();
  });
  it('fails explicitly rather than silently losing its health listener when the port is occupied', async () => {
    await expect(
      startWorkerHealth(Number(new URL(health.url).port), db, shutdown.signal),
    ).rejects.toMatchObject({
      code: 'worker_health_listen_failed',
    });
    expect((await probe('/health/live')).status).toBe(200);
  });
  it('cleans up and exits the compiled Worker naturally on bind failure without reaching the database or providers', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
      {
        env: {
          NODE_ENV: 'test',
          WORKER_HEALTH_PORT: new URL(health.url).port,
          DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
          AZURE_OPENAI_ENDPOINT: 'https://synthetic.openai.azure.com/',
          AZURE_OPENAI_API_KEY: 'synthetic-worker-key',
          AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
          AZURE_OPENAI_DEPLOYMENT: 'synthetic-worker-deployment',
          AZURE_SPEECH_KEY: 'synthetic-speech-key',
          AZURE_SPEECH_REGION: 'eastus',
        },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4096,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('worker_ready');
    expect(result.stderr).toContain('worker_health_listen_failed');
    expect(result.stderr).not.toContain('synthetic-');
  });
  it('keeps diagnostics body-free for unknown paths and invalid bodies', async () => {
    const response = await probe('/private-health-path-marker');
    expect(response.status).toBe(404);
    expect(response.body).toBe('{"status":"unavailable"}');
    const invalid = await fetch(health.url + '/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"private-health-body-marker":',
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(await invalid.text()).not.toContain('private-');
    expect(db.pool.query).not.toHaveBeenCalled();
  });
  it('bounds readiness traffic without consuming the separate liveness budget', async () => {
    health.markReady();
    for (let index = 0; index < 120; index++)
      expect((await probe()).status).toBe(200);
    const response = await probe();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect((await probe('/health/live')).status).toBe(200);
    expect(db.pool.query).toHaveBeenCalledTimes(120);
  });
});
