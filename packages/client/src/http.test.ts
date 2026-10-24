import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient, responseJson, serverUrl } from './http.js';
import {
  jobSchema,
  jobHistorySchema,
} from '@windows-ai-notes/contracts/server';
import { canonicalJson } from '@windows-ai-notes/contracts/content';

describe('bounded service transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  async function serve(handler: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('The synthetic service did not bind.');
    return `http://127.0.0.1:${address.port}`;
  }
  async function unavailable(
    header: string | undefined,
    status = 429,
    retryable = true,
  ) {
    let requests = 0;
    const base = await serve((_request, response) => {
      requests++;
      response.writeHead(status, {
        'Content-Type': 'application/json',
        ...(header === undefined ? {} : { 'Retry-After': header }),
      });
      response.end(
        JSON.stringify({
          code: 'service_unavailable',
          message: 'Synthetic service backoff.',
          retryable,
          request_id: 'synthetic-date-backoff',
        }),
      );
    });
    return {
      client: new ApiClient(base, async () => ({}), { allowLoopback: true }),
      requests: () => requests,
    };
  }
  function history(document = randomUUID()) {
    return {
      jobs: [
        jobSchema.parse({
          id: randomUUID(),
          document_id: document,
          kind: 'summary',
          state: 'succeeded',
          attempt: 1,
          input_stale: false,
          result: {
            kind: 'summary',
            provider: 'fixture',
            configuration_version: 'conditional-history-v1',
            prompt_version: 'summary-v1',
            usage: { input_tokens: 1, output_tokens: 2, audio_ms: 0 },
            summary: {
              overview: {
                text: 'Full saved summary fixture.',
                citations: [{ source: 'note', id: document, revision: 1 }],
              },
              topics: [],
              decisions: [],
              action_items: [],
              open_questions: [],
            },
          },
          error: null,
          created_at: '2030-01-01T00:00:00.000Z',
        }),
      ],
    };
  }
  function historyTag(value: unknown) {
    return `"${createHash('sha256').update(canonicalJson(value)).digest('hex')}"`;
  }
  const transports = [
    { kind: 'JSON', deadline: 20_000 },
    { kind: 'conditional history', deadline: 20_000 },
    { kind: 'receipt history', deadline: 20_000 },
    { kind: 'job events', deadline: 60_000 },
    { kind: 'question events', deadline: 60_000 },
  ] as const;
  function read(
    kind: (typeof transports)[number]['kind'],
    client: ApiClient,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = randomUUID();
    switch (kind) {
      case 'JSON':
        return client.identity(signal);
      case 'conditional history':
        return client.jobs(id, signal, history(id));
      case 'receipt history':
        return client.jobsIfChanged(id, signal, historyTag({ jobs: [] }));
      case 'job events':
        return client.events(id, 0, async () => undefined, signal);
      case 'question events':
        return client.chatEvents(id, 0, async () => undefined, signal);
    }
  }
  function pendingCredentials() {
    let resolve!: (headers: Record<string, string>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Record<string, string>>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
    servers.length = 0;
  });
  it.each([false, true])(
    'receipt-only history returns no body only after a matching receipt with weak=%s',
    async (weak) => {
      const value = history();
      const tag = historyTag(value);
      const base = await serve((request, response) => {
        expect(request.headers['if-none-match']).toBe(tag);
        response.writeHead(304, { ETag: `${weak ? 'W/' : ''}${tag}` });
        response.end();
      });
      const client = new ApiClient(base, async () => ({}), {
        allowLoopback: true,
      });
      const parse = vi.spyOn(jobHistorySchema, 'safeParse');
      await expect(
        client.jobsIfChanged(
          value.jobs[0]!.document_id,
          new AbortController().signal,
          tag,
        ),
      ).resolves.toBeNull();
      expect(parse).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, '"other"', 'W/"other"'])(
    'receipt-only history rejects an unconfirmed 304 tag: %s',
    async (etag) => {
      const base = await serve((_request, response) => {
        response.writeHead(304, etag === undefined ? {} : { ETag: etag });
        response.end();
      });
      const client = new ApiClient(base, async () => ({}), {
        allowLoopback: true,
      });
      await expect(
        client.jobsIfChanged(
          randomUUID(),
          new AbortController().signal,
          historyTag({ jobs: [] }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_server_response', status: 304 });
    },
  );
  it('receipt-only history accepts a complete compatible 200 response', async () => {
    const value = history();
    const base = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    });
    const client = new ApiClient(base, async () => ({}), {
      allowLoopback: true,
    });
    await expect(
      client.jobsIfChanged(
        value.jobs[0]!.document_id,
        new AbortController().signal,
        historyTag({ jobs: [] }),
      ),
    ).resolves.toEqual(value);
  });
  it('receipt-only history does not treat a null 200 response as unchanged', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('null');
    });
    const client = new ApiClient(base, async () => ({}), {
      allowLoopback: true,
    });
    await expect(
      client.jobsIfChanged(
        randomUUID(),
        new AbortController().signal,
        historyTag({ jobs: [] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_server_response', status: 200 });
  });
  it.each([401, 403, 429, 500])(
    'receipt-only history preserves HTTP %i instead of returning unchanged',
    async (status) => {
      const { client } = await unavailable(undefined, status);
      await expect(
        client.jobsIfChanged(
          randomUUID(),
          new AbortController().signal,
          historyTag({ jobs: [] }),
        ),
      ).rejects.toMatchObject({ status });
    },
  );
  it.each(['not-a-tag', '""', `W/"${'a'.repeat(64)}"`])(
    'receipt-only history rejects malformed request tags before credential access: %s',
    async (etag) => {
      const credentials = vi.fn(async () => ({}));
      const client = new ApiClient('http://127.0.0.1:1', credentials, {
        allowLoopback: true,
      });
      await expect(
        client.jobsIfChanged(randomUUID(), new AbortController().signal, etag),
      ).rejects.toMatchObject({ code: 'invalid_cached_response' });
      expect(credentials).not.toHaveBeenCalled();
    },
  );
  it('receipt-only history cannot conditionally acknowledge a write', async () => {
    const credentials = vi.fn(async () => ({}));
    const client = new ApiClient('http://127.0.0.1:1', credentials, {
      allowLoopback: true,
    });
    await expect(
      client.request('/v1/documents', jobHistorySchema, {
        method: 'POST',
        etag: historyTag({ jobs: [] }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_cached_response' });
    expect(credentials).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'conditional history retains full cached results only after a matching authorized bodyless response with weak=%s',
    async (weak) => {
      const cached = history();
      const saved = structuredClone(cached);
      const tag = historyTag(saved);
      let seen: {
        path: string | undefined;
        tag: string | undefined;
        authorization: string | undefined;
      } | null = null;
      const base = await serve((request, response) => {
        seen = {
          path: request.url,
          tag: request.headers['if-none-match'],
          authorization: request.headers.authorization,
        };
        response.writeHead(304, { ETag: weak ? `W/${tag}` : tag });
        response.end();
      });
      let credentials = 0;
      const client = new ApiClient(
        base,
        async () => {
          const result = cached.jobs[0]!.result;
          if (result?.kind !== 'summary')
            throw new Error('Expected a cached summary.');
          result.summary.overview.text = 'Changed caller-owned cache value.';
          return { Authorization: `Bearer synthetic-${++credentials}` };
        },
        { allowLoopback: true },
      );
      await expect(
        client.jobs(
          cached.jobs[0]!.document_id,
          new AbortController().signal,
          cached,
        ),
      ).resolves.toEqual(saved);
      expect(seen).toEqual({
        path: `/v1/documents/${cached.jobs[0]!.document_id}/jobs?limit=20`,
        tag,
        authorization: 'Bearer synthetic-1',
      });
      expect(credentials).toBe(1);
    },
  );
  it.each([false, true])(
    'conditional history accepts a full 200 when the representation changes=%s or an older server ignores revalidation',
    async (changed) => {
      const cached = history();
      const next = changed
        ? {
            jobs: [
              { ...cached.jobs[0]!, state: 'cancelled' as const, result: null },
            ],
          }
        : cached;
      let tag: string | undefined;
      const base = await serve((request, response) => {
        tag = request.headers['if-none-match'];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(canonicalJson(next));
      });
      const client = new ApiClient(base, async () => ({}), {
        allowLoopback: true,
      });
      await expect(
        client.jobs(
          cached.jobs[0]!.document_id,
          new AbortController().signal,
          cached,
        ),
      ).resolves.toEqual(next);
      expect(tag).toBe(historyTag(cached));
    },
  );
  it.each(['unsolicited', 'missing', 'mismatched'] as const)(
    'conditional history rejects a %s revalidation receipt',
    async (kind) => {
      const cached = history();
      const base = await serve((_request, response) => {
        response.writeHead(
          304,
          kind === 'missing'
            ? {}
            : {
                ETag:
                  kind === 'mismatched'
                    ? `"${'f'.repeat(64)}"`
                    : historyTag(cached),
              },
        );
        response.end();
      });
      const client = new ApiClient(base, async () => ({}), {
        allowLoopback: true,
      });
      await expect(
        client.jobs(
          cached.jobs[0]!.document_id,
          new AbortController().signal,
          kind === 'unsolicited' ? undefined : cached,
        ),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
    },
  );
  it.each([401, 403, 429, 503])(
    'conditional history never substitutes cached success for HTTP %i',
    async (status) => {
      const cached = history();
      const workspace = randomUUID();
      const base = await serve((_request, response) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            code: 'workspace_access_revoked',
            message: 'Synthetic conditional-read failure.',
            retryable: false,
            request_id: 'synthetic-conditional-history',
            purge_workspace_id: workspace,
          }),
        );
      });
      const client = new ApiClient(base, async () => ({}), {
        allowLoopback: true,
      });
      await expect(
        client.jobs(
          cached.jobs[0]!.document_id,
          new AbortController().signal,
          cached,
        ),
      ).rejects.toMatchObject({
        status,
        code: 'workspace_access_revoked',
        purgeWorkspaceId: workspace,
      });
    },
  );
  it('conditional history rejects foreign documents, invalid cached JSON and non-read revalidation before network work', async () => {
    let requests = 0;
    const cached = history();
    const base = await serve((_request, response) => {
      requests++;
      response.end('{}');
    });
    const client = new ApiClient(base, async () => ({}), {
      allowLoopback: true,
    });
    await expect(
      client.jobs(randomUUID(), new AbortController().signal, cached),
    ).rejects.toMatchObject({ code: 'invalid_cached_response' });
    await expect(
      client.request('/v1/me', z.strictObject({ id: z.uuidv4() }), {
        cached: { id: 'invalid' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_cached_response' });
    await expect(
      client.request('/v1/me', z.strictObject({ id: z.uuidv4() }), {
        method: 'POST',
        cached: { id: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'invalid_cached_response' });
    expect(requests).toBe(0);
  });
  it('conditional history remains cancellable while waiting for revalidation', async () => {
    const cached = history();
    let started!: () => void;
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    let tag: string | undefined;
    const base = await serve((request) => {
      tag = request.headers['if-none-match'];
      started();
    });
    const client = new ApiClient(base, async () => ({}), {
      allowLoopback: true,
    });
    const controller = new AbortController();
    const pending = client.jobs(
      cached.jobs[0]!.document_id,
      controller.signal,
      cached,
    );
    await beginning;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(tag).toBe(historyTag(cached));
  });
  it('requires HTTPS and an origin-only configuration, with explicit loopback development exceptions', () => {
    expect(serverUrl('https://notes.example.test:443/')).toBe(
      'https://notes.example.test',
    );
    expect(serverUrl('http://127.0.0.1:4411/', true)).toBe(
      'http://127.0.0.1:4411',
    );
    for (const value of [
      'http://notes.example.test',
      'http://127.0.0.1',
      'file:///tmp/test',
      'https://user:password@notes.example.test',
      'https://notes.example.test/v1',
      'https://notes.example.test/?token=secret',
      'https://notes.example.test/#fragment',
    ])
      expect(() => serverUrl(value)).toThrow();
  });
  it('does not follow a service redirect or forward credentials to its destination', async () => {
    let contacted = false;
    const destination = await serve((_request, response) => {
      contacted = true;
      response.end('{}');
    });
    const source = await serve((_request, response) => {
      response.writeHead(307, { Location: `${destination}/v1/me` });
      response.end();
    });
    const client = new ApiClient(
      source,
      async () => ({ Authorization: 'Bearer synthetic-test-only' }),
      { allowLoopback: true },
    );
    await expect(client.identity()).rejects.toMatchObject({
      code: 'service_redirect_rejected',
    });
    expect(contacted).toBe(false);
  });
  it('bounds decoded response bytes and rejects malformed or unsupported JSON', async () => {
    await expect(
      responseJson(new Response('x'.repeat(1025)), z.unknown(), 1024),
    ).rejects.toMatchObject({ code: 'response_too_large' });
    await expect(
      responseJson(new Response('{'), z.unknown()),
    ).rejects.toMatchObject({ code: 'invalid_server_response' });
    await expect(
      responseJson(
        new Response('{"id":"not-a-uuid"}'),
        z.strictObject({ id: z.uuidv4() }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_server_response' });
  });
  it('preserves explicit service errors and bounded rate-limit backoff', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '900',
      });
      response.end(
        JSON.stringify({
          code: 'rate_limited',
          message: 'Try again later.',
          retryable: true,
          request_id: 'synthetic-request',
        }),
      );
    });
    const client = new ApiClient(base, async () => ({}), {
      allowLoopback: true,
    });
    await expect(client.identity()).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryable: true,
      retryAfterSeconds: 300,
    });
  });
  it.each([
    [429, 'json'],
    [503, 'json'],
    [429, 'summary'],
    [503, 'summary'],
    [429, 'question'],
    [503, 'question'],
  ] as const)(
    'preserves an HTTP-date floor from a real %i %s response without replaying it',
    async (status, path) => {
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.parse('2030-01-01T00:00:00.250Z'),
      );
      const service = await unavailable(
        'Tue, 01 Jan 2030 00:00:10 GMT',
        status,
      );
      let received = 0;
      const accept = async () => {
        received++;
      };
      const signal = new AbortController().signal;
      const operation =
        path === 'json'
          ? service.client.identity()
          : path === 'summary'
            ? service.client.events(randomUUID(), 0, accept, signal)
            : service.client.chatEvents(randomUUID(), 0, accept, signal);
      await expect(operation).rejects.toMatchObject({
        code: 'service_unavailable',
        status,
        retryable: true,
        retryAfterSeconds: 9.75,
      });
      expect(service.requests()).toBe(1);
      expect(received).toBe(0);
    },
  );
  it.each([
    {
      header: 'Tuesday, 01-Jan-30 00:00:10 GMT',
      expected: 9.75,
    },
    {
      header: 'Tue Jan  1 00:00:10 2030',
      expected: 9.75,
    },
    {
      header: 'Tue Jan 01 00:00:10 2030',
      expected: 9.75,
    },
    {
      header: 'Tue, 01 Jan 2030 00:20:00 GMT',
      expected: 300,
    },
    {
      header: 'Tue, 01 Jan 2030 00:00:00 GMT',
      expected: 0,
    },
    {
      header: 'Wednesday, 01-Jan-70 00:00:10 GMT',
      expected: 300,
    },
    {
      header: 'Monday, 01-Jan-80 00:00:00 GMT',
      expected: 300,
    },
    {
      header: 'Tuesday, 01-Jan-80 00:00:01 GMT',
      expected: 0,
    },
  ])(
    'decodes the UTC HTTP-date $header as a bounded floor',
    async ({ header, expected }) => {
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.parse('2030-01-01T00:00:00.250Z'),
      );
      const service = await unavailable(header);
      await expect(service.client.identity()).rejects.toMatchObject({
        retryAfterSeconds: expected,
      });
    },
  );
  it('interprets an obsolete year across the UTC century boundary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2099-12-31T23:59:59.250Z'),
    );
    const service = await unavailable('Friday, 01-Jan-00 00:00:10 GMT');
    await expect(service.client.identity()).rejects.toMatchObject({
      retryAfterSeconds: 10.75,
    });
  });
  it.each([
    'Sat, 31 Dec 2016 23:59:60 GMT',
    'Saturday, 31-Dec-16 23:59:60 GMT',
    'Sat Dec 31 23:59:60 2016',
  ])('accepts the leap-second HTTP-date %s', async (header) => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2016-12-31T23:59:50.250Z'),
    );
    const service = await unavailable(header);
    await expect(service.client.identity()).rejects.toMatchObject({
      retryAfterSeconds: 9.75,
    });
  });
  it.each([
    { header: undefined, expected: 30 },
    { header: '', expected: 30 },
    { header: '0', expected: 30 },
    { header: '-1', expected: 30 },
    { header: 'Infinity', expected: 30 },
    { header: 'not-a-date', expected: 30 },
    { header: '2030-01-01T00:00:10Z', expected: 30 },
    { header: 'Wed, 01 Jan 2030 00:00:10 GMT', expected: 30 },
    { header: 'Thu, 31 Feb 2030 00:00:10 GMT', expected: 30 },
    { header: 'Tue, 01 Jan 2030 00:00:10 PST', expected: 30 },
    { header: '1.25', expected: 1.25 },
    { header: '1e2', expected: 100 },
  ])(
    'preserves numeric and invalid-header compatibility for $header',
    async ({ header, expected }) => {
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.parse('2030-01-01T00:00:00.250Z'),
      );
      const service = await unavailable(header);
      await expect(service.client.identity()).rejects.toMatchObject({
        retryAfterSeconds: expected,
      });
    },
  );
  it('does not make a permanent error retryable because it carries a future date', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2030-01-01T00:00:00.250Z'),
    );
    const service = await unavailable(
      'Tue, 01 Jan 2030 00:00:10 GMT',
      403,
      false,
    );
    await expect(service.client.identity()).rejects.toMatchObject({
      status: 403,
      retryable: false,
      retryAfterSeconds: 9.75,
    });
    expect(service.requests()).toBe(1);
  });
  it.each(transports)(
    '$kind skips credential retrieval when already cancelled',
    async ({ kind }) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ id: randomUUID() }));
      const headers = vi.fn(async () => ({}));
      const client = new ApiClient('https://notes.example.test', headers);
      const controller = new AbortController();
      controller.abort();
      await expect(read(kind, client, controller.signal)).rejects.toMatchObject(
        {
          code: 'request_cancelled',
        },
      );
      expect(headers).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(
    transports.flatMap((transport) =>
      (['resolve', 'reject'] as const).map((late) => ({ ...transport, late })),
    ),
  )(
    '$kind cancels a pending credential wait before its late $late',
    async ({ kind, late }) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ id: randomUUID() }));
      const credential = pendingCredentials();
      const headers = vi.fn(() => credential.promise);
      const client = new ApiClient('https://notes.example.test', headers);
      const controller = new AbortController();
      const fulfilled = vi.fn();
      const rejected = vi.fn();
      const observing = read(kind, client, controller.signal).then(
        fulfilled,
        rejected,
      );
      try {
        expect(headers).toHaveBeenCalledTimes(1);
        controller.abort();
        await tick();
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'request_cancelled' }),
        );
      } finally {
        if (late === 'resolve')
          credential.resolve({ Authorization: 'Synthetic late credentials' });
        else credential.reject(new Error('Synthetic late vault failure.'));
        await observing;
      }
      await tick();
      expect(fulfilled).not.toHaveBeenCalled();
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(transports)(
    '$kind applies its existing $deadline ms deadline to credential retrieval',
    async ({ kind, deadline }) => {
      const expiry = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(expiry.signal);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ id: randomUUID() }));
      const credential = pendingCredentials();
      const client = new ApiClient(
        'https://notes.example.test',
        () => credential.promise,
      );
      const fulfilled = vi.fn();
      const rejected = vi.fn();
      const observing = read(kind, client, new AbortController().signal).then(
        fulfilled,
        rejected,
      );
      try {
        expect(timeout).toHaveBeenCalledExactlyOnceWith(deadline);
        expiry.abort();
        await tick();
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({
            code:
              deadline === 20_000
                ? 'request_cancelled'
                : 'event_connection_expired',
            retryable: true,
          }),
        );
      } finally {
        credential.resolve({ Authorization: 'Synthetic late credentials' });
        await observing;
      }
      expect(fulfilled).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(
    transports.flatMap((transport) =>
      [false, true].map((synchronous) => ({ ...transport, synchronous })),
    ),
  )(
    '$kind preserves a credential failure (synchronous=$synchronous) without dispatch',
    async ({ kind, synchronous }) => {
      const failure = new Error('Synthetic locked credential vault.');
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ id: randomUUID() }));
      const client = new ApiClient('https://notes.example.test', () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      });
      await expect(
        read(kind, client, new AbortController().signal),
      ).rejects.toBe(failure);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('pins transcript pages to the requested document, revision and position', async () => {
    const id = randomUUID();
    let change: Record<string, unknown> = {};
    const base = await serve((request, response) => {
      expect(request.url).toBe(
        `/v1/documents/${id}/transcript/pages?revision=2&offset=50`,
      );
      response.end(
        JSON.stringify({
          document_id: id,
          revision: 2,
          source: 'manual',
          offset: 50,
          total_segments: 51,
          segments: [
            { id: randomUUID(), start_ms: 0, end_ms: 1, text: 'Evidence.' },
          ],
          has_more: false,
          ...change,
        }),
      );
    });
    const client = new ApiClient(base, async () => ({}), {
      allowLoopback: true,
    });
    expect(
      (await client.transcriptPage(id, 2, 50, new AbortController().signal))
        .offset,
    ).toBe(50);
    for (change of [
      { document_id: randomUUID() },
      { revision: 3 },
      { offset: 49, total_segments: 50 },
    ])
      await expect(
        client.transcriptPage(id, 2, 50, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
  });
});
