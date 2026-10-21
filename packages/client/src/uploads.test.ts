import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Database } from '@windows-ai-notes/db';
import { createServer } from '@windows-ai-notes/api/server';
import { RecordingBlobs } from '@windows-ai-notes/storage';
import { AudioHostClient } from './audio.js';
import { ApiClient, ClientError } from './http.js';
import { RecordingUploadTransport } from './uploads.js';
import {
  recordingCapabilitiesSchema,
  uploadAuthorizationSchema,
  remoteChunkSchema,
} from '@windows-ai-notes/contracts/uploads';

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_S3_ENDPOINT;
const fixture = fileURLToPath(
  new URL('../fixtures/audio-host.mjs', import.meta.url),
);
describe.skipIf(!databaseUrl || !endpoint)(
  'native framed media through real HTTP, PostgreSQL and private S3',
  () => {
    const schema = `notes_upload_client_${randomUUID().replaceAll('-', '')}`;
    const bucket = `notes-client-${randomUUID()}`;
    const config = {
      endpoint: endpoint ?? 'http://127.0.0.1:59000',
      region: 'us-east-1',
      bucket,
      encryption: 'none' as const,
      credentials: {
        accessKeyId: 'storage-test-only',
        secretAccessKey: 'storage-test-only-secret',
      },
    };
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    let bucketCreated = false;
    let schemaCreated = false;
    let admin: Database;
    let db: Database;
    let blobs: RecordingBlobs;
    let app: Awaited<ReturnType<typeof createServer>>;
    let base: string;
    beforeAll(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketCreated = true;
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
      blobs = new RecordingBlobs(config);
      app = await createServer(
        db,
        { mode: 'development', host: '127.0.0.1' },
        blobs,
      );
      base = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 30_000);
    afterAll(async () => {
      await app?.close();
      blobs?.close();
      await db?.close();
      if (admin) {
        if (schemaCreated)
          await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
      if (bucketCreated) {
        let continuation: string | undefined;
        do {
          const page = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ...(continuation ? { ContinuationToken: continuation } : {}),
            }),
          );
          for (const object of page.Contents ?? [])
            if (object.Key)
              await s3.send(
                new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
              );
          continuation = page.NextContinuationToken;
        } while (continuation);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
      s3.destroy();
    });
    async function context() {
      const subject = randomUUID();
      const actor = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const doc = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic native transfer',
          notes: '',
        },
        randomUUID(),
      );
      const recording = randomUUID(),
        track = randomUUID(),
        chunk = randomUUID();
      const native = new AudioHostClient(
        process.execPath,
        [fixture, 'range', '', recording, track, chunk],
        () => {},
      );
      try {
        const event = await native.request({
          command: 'list_recording_chunks',
          recording_id: recording,
          track_id: track,
          sequence_start: 0,
        });
        if (event.event_type !== 'recording.chunks' || !event.payload.chunks[0])
          throw new Error('The synthetic native archive returned no chunk.');
        const upload = event.payload.chunks[0];
        await db.recordings.create(
          actor.user_id,
          doc.id,
          {
            id: recording,
            created_at: new Date().toISOString(),
            tracks: [
              {
                spec: {
                  track_id: track,
                  kind: 'microphone',
                  capture_scope: 'endpoint',
                  device_selection_policy: 'explicit',
                  device_id: 'synthetic',
                },
                actual_device_id: 'synthetic',
              },
            ],
          },
          randomUUID(),
        );
        const api = new ApiClient(
          base,
          async () => ({
            'x-dev-subject': subject,
            Authorization: 'Bearer synthetic-client-token',
            Cookie: 'synthetic=private',
          }),
          { allowLoopback: true },
        );
        const transport = new RecordingUploadTransport(api, {
          allowLoopback: true,
        });
        return { ...actor, doc, native, upload, api, transport };
      } catch (error) {
        await native.close();
        throw error;
      }
    }
    it('uploads only authenticated native bytes and reconciles verified completion without rereading local audio', async () => {
      const c = await context();
      const progress = vi.fn();
      try {
        const result = await c.transport.chunk(
          c.upload,
          (signal) =>
            c.native.readChunk(c.upload.chunk.recording_id, c.upload, signal),
          { authorize: () => {}, progress },
        );
        expect(result).toEqual({ upload: c.upload, state: 'verified' });
        expect(progress).toHaveBeenCalledWith(
          c.upload.size_bytes,
          c.upload.size_bytes,
        );
        const source = vi.fn(() =>
          c.native.readChunk(c.upload.chunk.recording_id, c.upload),
        );
        expect(
          await c.transport.chunk(c.upload, source, { authorize: () => {} }),
        ).toEqual(result);
        expect(source).not.toHaveBeenCalled();
      } finally {
        await c.native.close();
      }
    });
    it('rejects wrong bytes before PUT and does not claim an unverified transfer succeeded', async () => {
      const c = await context();
      try {
        await expect(
          c.transport.chunk(
            c.upload,
            async function* () {
              yield Buffer.alloc(c.upload.size_bytes, 1);
            },
            { authorize: () => {} },
          ),
        ).rejects.toMatchObject({ code: 'audio_checksum_mismatch' });
        expect(
          (await db.recordings.chunk(c.user_id, c.upload.chunk.chunk_id)).state,
        ).toBe('pending');
        const objects = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'recordings/v1/staging/',
          }),
        );
        const grants = await db.pool.query<{ id: string }>(
          'SELECT id FROM recording_objects WHERE recording_id=$1',
          [c.upload.chunk.recording_id],
        );
        expect(grants.rows).toHaveLength(1);
        expect(
          objects.Contents?.some((object) =>
            object.Key?.endsWith(grants.rows[0]!.id),
          ) ?? false,
        ).toBe(false);
      } finally {
        await c.native.close();
      }
    });
    it('fences ownership changes between native ranges before any object upload', async () => {
      const c = await context();
      let allowed = true;
      try {
        await expect(
          c.transport.chunk(
            c.upload,
            async function* (signal) {
              for await (const part of c.native.readChunk(
                c.upload.chunk.recording_id,
                c.upload,
                signal,
              )) {
                allowed = false;
                yield part;
              }
            },
            {
              authorize: () => {
                if (!allowed)
                  throw new ClientError(
                    'scope_changed',
                    'The recording workspace changed.',
                  );
              },
            },
          ),
        ).rejects.toMatchObject({ code: 'scope_changed' });
        expect(
          (await db.recordings.chunk(c.user_id, c.upload.chunk.chunk_id)).state,
        ).toBe('pending');
      } finally {
        await c.native.close();
      }
    });
    it('never sends API credentials to object storage', async () => {
      const c = await context();
      const actual = globalThis.fetch;
      const headers: Headers[] = [];
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation((input, init) => {
          if (
            new URL(input instanceof Request ? input.url : input).origin ===
            endpoint
          )
            headers.push(new Headers(init?.headers));
          return actual(input, init);
        });
      try {
        await c.transport.chunk(
          c.upload,
          (signal) =>
            c.native.readChunk(c.upload.chunk.recording_id, c.upload, signal),
          { authorize: () => {} },
        );
        expect(headers).toHaveLength(1);
        expect(headers[0]!.has('x-dev-subject')).toBe(false);
        expect(headers[0]!.has('authorization')).toBe(false);
        expect(headers[0]!.has('cookie')).toBe(false);
      } finally {
        fetch.mockRestore();
        await c.native.close();
      }
    });
    it('reconciles a lost verified-completion response without rereading or uploading media', async () => {
      const c = await context();
      const actual = globalThis.fetch;
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          const response = await actual(input, init);
          if (
            new URL(
              input instanceof Request ? input.url : input,
            ).pathname.endsWith('/complete') &&
            response.ok
          ) {
            await response.body?.cancel();
            throw new TypeError('Synthetic lost completion response.');
          }
          return response;
        });
      try {
        try {
          await expect(
            c.transport.chunk(
              c.upload,
              (signal) =>
                c.native.readChunk(
                  c.upload.chunk.recording_id,
                  c.upload,
                  signal,
                ),
              { authorize: () => {} },
            ),
          ).rejects.toMatchObject({ code: 'service_unavailable' });
        } finally {
          fetch.mockRestore();
        }
        const source = vi.fn(() =>
          c.native.readChunk(c.upload.chunk.recording_id, c.upload),
        );
        expect(
          (await c.transport.chunk(c.upload, source, { authorize: () => {} }))
            .state,
        ).toBe('verified');
        expect(source).not.toHaveBeenCalled();
      } finally {
        await c.native.close();
      }
    });
    it('cancels before loading native media', async () => {
      const c = await context();
      try {
        const aborted = new AbortController();
        aborted.abort();
        const source = vi.fn(() =>
          c.native.readChunk(c.upload.chunk.recording_id, c.upload),
        );
        await expect(
          c.transport.chunk(c.upload, source, {
            authorize: () => {},
            signal: aborted.signal,
          }),
        ).rejects.toMatchObject({ code: 'request_cancelled' });
        expect(source).not.toHaveBeenCalled();
      } finally {
        await c.native.close();
      }
    });
    it('rejects a real HTTP redirect instead of following it with native media', async () => {
      const c = await context();
      let followed = 0;
      const redirector = createHttpServer((request, response) => {
        request.resume();
        if (request.url?.startsWith('/unapproved')) {
          followed++;
          response.writeHead(200).end();
        } else response.writeHead(307, { Location: '/unapproved' }).end();
      });
      redirector.listen(0, '127.0.0.1');
      await once(redirector, 'listening');
      const address = redirector.address();
      if (!address || typeof address === 'string')
        throw new Error('The synthetic redirector did not bind loopback.');
      const origin = `http://127.0.0.1:${address.port}`;
      const actual = globalThis.fetch;
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          const response = await actual(input, init);
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.origin !== base || !response.ok) return response;
          if (url.pathname === '/v1/recording-capabilities')
            return Response.json({
              ...recordingCapabilitiesSchema.parse(await response.json()),
              upload_origin: origin,
            });
          if (url.pathname.endsWith('/upload')) {
            const value = uploadAuthorizationSchema.parse(
              await response.json(),
            );
            if (!value.upload)
              throw new Error('Expected synthetic upload authorization.');
            value.upload.url = value.upload.url.replace(
              new URL(config.endpoint).origin,
              origin,
            );
            return Response.json(value);
          }
          return response;
        });
      try {
        await expect(
          c.transport.chunk(
            c.upload,
            (signal) =>
              c.native.readChunk(c.upload.chunk.recording_id, c.upload, signal),
            { authorize: () => {} },
          ),
        ).rejects.toMatchObject({ code: 'audio_upload_redirect_rejected' });
        expect(followed).toBe(0);
      } finally {
        fetch.mockRestore();
        await c.native.close();
        redirector.closeAllConnections();
        const closed = once(redirector, 'close');
        redirector.close();
        await closed;
      }
    });
    it.each(['origin', 'path', 'headers', 'confirmation'])(
      'fails closed on %s tampering without forwarding native bytes to an unapproved destination',
      async (mode) => {
        const c = await context();
        const actual = globalThis.fetch;
        let objectRequests = 0;
        const fetch = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(async (input, init) => {
            const destination = new URL(
              input instanceof Request ? input.url : input,
            );
            if (destination.origin !== base) {
              objectRequests++;
              return actual(input, init);
            }
            const response = await actual(input, init);
            if (destination.pathname.endsWith('/upload') && response.ok) {
              const value = uploadAuthorizationSchema.parse(
                await response.json(),
              );
              if (!value.upload)
                throw new Error('Expected synthetic upload authorization.');
              if (mode === 'origin')
                value.upload.url = value.upload.url.replace(
                  endpoint!,
                  'https://unapproved.example.test',
                );
              if (mode === 'path')
                value.upload.url = value.upload.url.replace(
                  '/recordings/v1/staging/',
                  '/another-path/',
                );
              if (mode === 'headers')
                return Response.json({
                  ...value,
                  upload: {
                    ...value.upload,
                    headers: {
                      ...value.upload.headers,
                      Authorization: 'synthetic-should-never-be-forwarded',
                    },
                  },
                });
              return Response.json(value);
            }
            if (
              mode === 'confirmation' &&
              destination.pathname.endsWith('/complete') &&
              response.ok
            )
              return Response.json({
                ...remoteChunkSchema.parse(await response.json()),
                state: 'pending',
              });
            return response;
          });
        try {
          await expect(
            c.transport.chunk(
              c.upload,
              (signal) =>
                c.native.readChunk(
                  c.upload.chunk.recording_id,
                  c.upload,
                  signal,
                ),
              { authorize: () => {} },
            ),
          ).rejects.toMatchObject({
            code:
              mode === 'headers'
                ? 'invalid_server_response'
                : 'invalid_upload_response',
          });
          expect(objectRequests).toBe(mode === 'confirmation' ? 1 : 0);
        } finally {
          fetch.mockRestore();
          await c.native.close();
        }
      },
    );
  },
);
