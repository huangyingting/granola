import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createProxy } from 'node:http';
import {
  createServer as createTlsServer,
  type ServerOptions,
} from 'node:https';
import { connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  summarySnapshotSchema,
  summarySnapshotCitations,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';
import {
  SYNTHETIC_AZURE_HOST,
  SYNTHETIC_AZURE_KEY,
} from './service-process.fixture.js';

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The private provider fixture did not acquire a port.');
  return address.port;
}

export async function workerProvider(directory: string) {
  const certificate = join(directory, 'provider-cert.pem');
  const key = join(directory, 'provider-key.pem');
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${SYNTHETIC_AZURE_HOST}`,
      '-addext',
      `subjectAltName=DNS:${SYNTHETIC_AZURE_HOST}`,
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { timeout: 10_000, maxBuffer: 16_384 },
  );
  const context: ServerOptions = {
    key: await readFile(key),
    cert: await readFile(certificate),
  };
  const sockets = new Set<Duplex>();
  const requests: {
    snapshot: SummarySnapshot;
    requestId: string;
    closed: boolean;
    complete: () => void;
  }[] = [];
  let unexpected = 0;
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const peerClosed = (error: Error) =>
    'code' in error && ['ECONNRESET', 'EPIPE'].includes(String(error.code));
  const tls = createTlsServer(context, (request, response) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on('data', (bytes: Buffer) => {
      length += bytes.length;
      if (length > 65_536) {
        unexpected++;
        request.destroy();
      } else chunks.push(bytes);
    });
    request.once('error', (error) => {
      if (!peerClosed(error)) unexpected++;
    });
    request.once('end', () => {
      try {
        if (
          request.method !== 'POST' ||
          request.url !==
            '/openai/deployments/synthetic/chat/completions?api-version=2024-10-21' ||
          request.headers['api-key'] !== SYNTHETIC_AZURE_KEY
        )
          throw new Error('Unexpected synthetic dispatch.');
        const wire = z
          .object({
            stream: z.literal(true),
            messages: z
              .array(
                z.object({
                  role: z.enum(['system', 'user']),
                  content: z.string().max(65_536),
                }),
              )
              .length(2),
          })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const message = wire.messages.find((value) => value.role === 'user');
        if (!message) throw new Error('The frozen evidence is absent.');
        const snapshot = summarySnapshotSchema.parse(
          JSON.parse(message.content),
        );
        const requestId = z
          .uuid()
          .parse(request.headers['x-ms-client-request-id']);
        const observed = {
          snapshot,
          requestId,
          closed: false,
          complete() {
            if (response.destroyed || response.writableEnded)
              throw new Error(
                'The held provider response is no longer writable.',
              );
            const summary = {
              overview: {
                text: snapshot.notes,
                citations: summarySnapshotCitations(snapshot),
              },
              topics: [],
              decisions: [],
              action_items: [],
              open_questions: [],
            };
            const frames = [
              {
                choices: [
                  {
                    index: 0,
                    delta: { content: JSON.stringify(summary) },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
              {
                choices: [],
                usage: { prompt_tokens: 5, completion_tokens: 4 },
              },
            ];
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(
              `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
            );
          },
        };
        requests.push(observed);
        response.once('close', () => {
          observed.closed = !response.writableEnded;
        });
      } catch {
        unexpected++;
        response.writeHead(400).end();
      }
    });
  });
  tls.on('connection', track);
  tls.on('tlsClientError', (error) => {
    if (!peerClosed(error)) unexpected++;
  });
  const proxy = createProxy((_request, response) => {
    unexpected++;
    response.writeHead(403).end();
  });
  proxy.on('connection', track);
  let tlsPort = 0;
  proxy.on('connect', (request, client, head) => {
    if (request.url !== `${SYNTHETIC_AZURE_HOST}:443`) {
      unexpected++;
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream: Socket = connect(tlsPort, '127.0.0.1');
    track(upstream);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once('error', (error) => {
      if (!peerClosed(error)) unexpected++;
      client.destroy();
    });
    client.once('error', (error) => {
      if (!peerClosed(error)) unexpected++;
      upstream.destroy();
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  async function close() {
    const closed = Promise.allSettled(
      [proxy, tls]
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
    for (const socket of sockets) socket.destroy();
    const failures = (await closed).filter(
      (result) => result.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Private provider cleanup failed.',
      );
  }
  try {
    tlsPort = await listen(tls);
    const port = await listen(proxy);
    return {
      proxy: { url: `http://127.0.0.1:${port}`, certificate },
      requests,
      get unexpected() {
        return unexpected;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
