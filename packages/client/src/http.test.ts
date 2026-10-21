import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
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
  afterEach(async () => {
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
