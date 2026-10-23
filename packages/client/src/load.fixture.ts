import { createServer, request as httpRequest } from 'node:http';
import { z } from 'zod';

const elapsed = z.number().finite().nonnegative();
export const latencySummarySchema = z
  .strictObject({
    samples: z.number().int().min(1).max(10_000),
    minimum_ms: elapsed,
    p50_ms: elapsed,
    p95_ms: elapsed,
    maximum_ms: elapsed,
  })
  .refine(
    (value) =>
      value.minimum_ms <= value.p50_ms &&
      value.p50_ms <= value.p95_ms &&
      value.p95_ms <= value.maximum_ms,
  );

export function latencySummary(values: readonly number[]) {
  if (
    !values.length ||
    values.length > 10_000 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error('Latency samples must be finite, nonnegative and bounded.');
  const sorted = [...values].sort((left, right) => left - right);
  return latencySummarySchema.parse({
    samples: sorted.length,
    minimum_ms: sorted[0],
    p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maximum_ms: sorted.at(-1),
  });
}

export const loadAcceptanceReportSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('controlled_sync_resilience'),
    scope: z.literal('synthetic_loopback_development_auth'),
    execution: z.enum(['local', 'github_actions']),
    source_commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    observed_at: z.iso.datetime(),
    production_accepted: z.literal(false),
    latency_scope: z.literal('same_process_client_proxy_api_round_trip'),
    cohort: z.strictObject({
      accounts: z.literal(2),
      devices: z.literal(4),
      initial_documents: z.literal(8),
      conflict_copies: z.literal(2),
      deleted_documents: z.literal(2),
    }),
    committed_responses_lost: z.literal(1),
    restart_scope: z.literal('api_instances_database_pools_and_client_stores'),
    server_restarts: z.number().int().min(1).max(10),
    sync_attempt_latency: z.strictObject({
      initial: latencySummarySchema,
      recovered: latencySummarySchema,
      conflicts: latencySummarySchema,
      deletion: latencySummarySchema,
    }),
    burst: z
      .strictObject({
        requests: z.literal(128),
        concurrency: z.literal(8),
        accepted: latencySummarySchema,
        rate_limited: latencySummarySchema,
      })
      .refine(
        (value) =>
          value.accepted.samples + value.rate_limited.samples ===
          value.requests,
      ),
  })
  .refine((value) =>
    value.execution === 'github_actions'
      ? value.source_commit !== null
      : value.source_commit === null,
  );

export async function measured<T>(
  values: number[],
  operation: () => Promise<T>,
) {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    values.push(performance.now() - started);
  }
}

export async function concurrentBurst(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<void>,
) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 256 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  )
    throw new Error('The acceptance burst exceeds its bounded workload.');
  let cursor = 0;
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (cursor < count) {
        const index = cursor++;
        await operation(index);
      }
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'The acceptance burst failed.',
    );
}

export function acceptanceDatabaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'Controlled acceptance requires a valid isolated test database.',
    );
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname.length < 2 ||
    url.hash
  )
    throw new Error(
      'Controlled acceptance requires an explicitly configured literal-loopback test database.',
    );
  return url;
}

export async function responseLossProxy(destination: string) {
  const target = new URL(destination);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error(
      'The acceptance proxy requires an isolated literal-loopback origin.',
    );
  let armed = false;
  let dropped = 0;
  let unexpectedErrors = 0;
  const server = createServer((incoming, outgoing) => {
    let url: URL;
    try {
      url = new URL(incoming.url ?? '/', target);
    } catch {
      unexpectedErrors++;
      outgoing.writeHead(400).end();
      return;
    }
    if (url.origin !== target.origin || !url.pathname.startsWith('/v1/')) {
      unexpectedErrors++;
      outgoing.writeHead(400).end();
      return;
    }

    const lose =
      armed &&
      incoming.method === 'POST' &&
      url.pathname === '/v1/documents' &&
      typeof incoming.headers['idempotency-key'] === 'string';
    if (lose) armed = false;
    const upstream = httpRequest(
      url,
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host },
        agent: false,
        timeout: 25_000,
      },
      (response) => {
        if (response.statusCode === undefined) {
          unexpectedErrors++;
          response.resume();
          outgoing.writeHead(502).end();
          return;
        }
        if (lose && response.statusCode === 201) {
          response.resume();
          response.once('end', () => {
            dropped++;
            outgoing.destroy();
          });
        } else {
          if (lose) unexpectedErrors++;
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        }
        response.once('error', () => {
          unexpectedErrors++;
          outgoing.destroy();
        });
      },
    );
    upstream.once('timeout', () =>
      upstream.destroy(new Error('Acceptance upstream timed out.')),
    );
    upstream.once('error', () => {
      unexpectedErrors++;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.once('error', () => {
      unexpectedErrors++;
      upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The acceptance proxy did not acquire a loopback port.');
  return {
    base: `http://127.0.0.1:${address.port}`,
    arm() {
      if (armed || dropped)
        throw new Error('Only one committed-response loss may be armed.');
      armed = true;
    },
    get dropped() {
      return dropped;
    },
    get unexpectedErrors() {
      return unexpectedErrors;
    },
    async close() {
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await stopped;
    },
  };
}
