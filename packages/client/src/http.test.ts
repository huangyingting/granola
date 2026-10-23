import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient, responseJson, serverUrl } from './http.js';

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
  it('does not mask a credential-provider error as a network failure', async () => {
    const failure = new Error('Synthetic locked credential vault.');
    const client = new ApiClient('https://notes.example.test', async () => {
      throw failure;
    });
    await expect(client.identity()).rejects.toBe(failure);
  });
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
