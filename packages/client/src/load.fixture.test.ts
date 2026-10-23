import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptanceDatabaseUrl,
  concurrentBurst,
  latencySummary,
  latencySummarySchema,
  loadAcceptanceReportSchema,
  measured,
  responseLossProxy,
} from './load.fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('bounded synthetic load acceptance mechanics', () => {
  it('reports nearest-rank samples without inventing empty or invalid latency observations', () => {
    expect(latencySummary([90, 1, 40, 10])).toEqual({
      samples: 4,
      minimum_ms: 1,
      p50_ms: 10,
      p95_ms: 90,
      maximum_ms: 90,
    });
    expect(latencySummary([0])).toMatchObject({
      samples: 1,
      minimum_ms: 0,
      p95_ms: 0,
    });
    for (const invalid of [
      [],
      [-1],
      [NaN],
      [Infinity],
      Array<number>(10_001).fill(1),
    ])
      expect(() => latencySummary(invalid)).toThrow();
    expect(
      latencySummarySchema.safeParse({
        samples: 1,
        minimum_ms: 2,
        p50_ms: 1,
        p95_ms: 3,
        maximum_ms: 4,
      }).success,
    ).toBe(false);
  });
  it('measures rejected work explicitly and drains bounded concurrent workers on failure', async () => {
    const samples: number[] = [];
    await expect(
      measured(samples, async () => {
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow('synthetic failure');
    expect(samples).toHaveLength(1);
    let completed = 0,
      active = 0,
      peak = 0;
    await concurrentBurst(16, 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      completed++;
      active--;
    });
    expect(completed).toBe(16);
    expect(peak).toBe(4);
    let drained = 0;
    await expect(
      concurrentBurst(8, 4, async (index) => {
        await Promise.resolve();
        if (index === 0) throw new Error('synthetic failure');
        drained++;
      }),
    ).rejects.toThrow('acceptance burst failed');
    expect(drained).toBe(7);
    for (const [count, concurrency] of [
      [0, 1],
      [257, 1],
      [1, 9],
      [1.5, 1],
    ] as const)
      await expect(
        concurrentBurst(count, concurrency, async () => {}),
      ).rejects.toThrow('bounded workload');
  });
  it('loses only one actual successful upstream create response, after commit, and relays the next response normally', async () => {
    let committed = 0,
      status = 201;
    const upstream = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        if (status === 201) committed++;
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ committed }));
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port.');
    cleanup.push(async () => {
      const closed = new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
      upstream.closeAllConnections();
      await closed;
    });
    const proxy = await responseLossProxy(`http://127.0.0.1:${address.port}`);
    cleanup.push(() => proxy.close());
    proxy.arm();
    await expect(
      fetch(`${proxy.base}/v1/documents`, {
        method: 'POST',
        headers: { 'idempotency-key': 'synthetic-key' },
        body: '{}',
      }),
    ).rejects.toThrow();
    expect(committed).toBe(1);
    expect(proxy.dropped).toBe(1);
    const response = await fetch(`${proxy.base}/v1/documents`, {
      method: 'POST',
      headers: { 'idempotency-key': 'synthetic-key' },
      body: '{}',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ committed: 2 });
    expect(proxy.unexpectedErrors).toBe(0);
    expect(() => proxy.arm()).toThrow('Only one');
    status = 409;
    const rejected = await responseLossProxy(
      `http://127.0.0.1:${address.port}`,
    );
    cleanup.push(() => rejected.close());
    rejected.arm();
    const conflict = await fetch(`${rejected.base}/v1/documents`, {
      method: 'POST',
      headers: { 'idempotency-key': 'synthetic-conflict' },
      body: '{}',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ committed: 2 });
    expect(rejected.dropped).toBe(0);
    expect(rejected.unexpectedErrors).toBe(1);
  });
  it('cannot target a remote service or turn its synthetic report into a production approval', async () => {
    for (const target of [
      'https://service.example',
      'http://localhost:1234',
      'http://127.0.0.1:1234/path',
      'http://127.0.0.1:1234?token=synthetic',
    ])
      await expect(responseLossProxy(target)).rejects.toThrow(
        'literal-loopback',
      );
    expect(
      acceptanceDatabaseUrl(
        'postgresql://synthetic:fixture@127.0.0.1:5432/notes',
      ).hostname,
    ).toBe('127.0.0.1');
    for (const database of [
      'not-a-url',
      'postgresql://remote.example/notes',
      'postgresql://localhost/notes',
      'http://127.0.0.1/notes',
      'postgresql://127.0.0.1/',
      'postgresql://127.0.0.1',
      'postgresql://127.0.0.1/notes#private',
    ])
      expect(() => acceptanceDatabaseUrl(database)).toThrow('test database');
    const summary = latencySummary([1, 2]);
    const report = {
      version: 1,
      kind: 'controlled_sync_resilience',
      scope: 'synthetic_loopback_development_auth',
      execution: 'local',
      source_commit: null,
      observed_at: '2026-01-01T00:00:00.000Z',
      production_accepted: false,
      latency_scope: 'same_process_client_proxy_api_round_trip',
      cohort: {
        accounts: 2,
        devices: 4,
        initial_documents: 8,
        conflict_copies: 2,
        deleted_documents: 2,
      },
      committed_responses_lost: 1,
      restart_scope: 'api_instances_database_pools_and_client_stores',
      server_restarts: 5,
      sync_attempt_latency: {
        initial: summary,
        recovered: summary,
        conflicts: summary,
        deletion: summary,
      },
      burst: {
        requests: 128,
        concurrency: 8,
        accepted: { ...summary, samples: 120 },
        rate_limited: { ...summary, samples: 8 },
      },
    };
    expect(loadAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(
      loadAcceptanceReportSchema.parse({
        ...report,
        execution: 'github_actions',
        source_commit: 'a'.repeat(40),
      }),
    ).toMatchObject({
      execution: 'github_actions',
      source_commit: 'a'.repeat(40),
    });
    for (const change of [
      { production_accepted: true },
      { scope: 'production' },
      { title: 'private-marker' },
      { database_url: 'private-connection-fixture' },
      { source_commit: 'HEAD' },
      { source_commit: 'a'.repeat(40) },
      { execution: 'github_actions' },
      { restart_scope: 'postgres_crash_recovery' },
      { burst: { ...report.burst, rate_limited: { ...summary, samples: 7 } } },
    ])
      expect(
        loadAcceptanceReportSchema.safeParse({ ...report, ...change }).success,
      ).toBe(false);
  });
});
