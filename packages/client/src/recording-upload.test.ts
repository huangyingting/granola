import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import { createServer } from '@windows-ai-notes/api/server';
import { cleanupRecordingObjects } from '../../../apps/api/src/recordings.js';
import { RecordingBlobs } from '@windows-ai-notes/storage';
import type { Track } from '@windows-ai-notes/contracts';
import { remoteRecordingSchema } from '@windows-ai-notes/contracts/uploads';
import { AudioHostClient } from './audio.js';
import { ApiClient } from './http.js';
import { RecordingController } from './recording.js';
import { prepareRecordingUpload } from './recording-upload.js';

const fixture = fileURLToPath(
  new URL('../fixtures/audio-host.mjs', import.meta.url),
);
function source(): Track {
  return {
    track_id: randomUUID(),
    kind: 'microphone',
    capture_scope: 'endpoint',
    device_selection_policy: 'explicit',
    device_id: 'synthetic',
  };
}
describe('authenticated native recording upload preflight', () => {
  const clients = new Set<AudioHostClient>();
  afterEach(async () => {
    for (const client of clients) await client.close();
    clients.clear();
  });
  function context(mode: string) {
    const spec = source();
    const recording = {
      id: randomUUID(),
      document_id: randomUUID(),
      created_at: new Date().toISOString(),
      state: 'sealed' as const,
      tracks: [{ spec, actual_device_id: 'synthetic', saved_samples: 0 }],
      error: null,
      inspection: null,
    };
    const client = new AudioHostClient(
      process.execPath,
      [
        fixture,
        mode,
        JSON.stringify(spec),
        recording.id,
        spec.track_id,
        randomUUID(),
      ],
      () => {},
    );
    clients.add(client);
    return { recording, client };
  }
  it.each(['archive', 'archive-pages', 'archive-chunks'])(
    'freezes complete bounded timeline and chunk pages from %s',
    async (mode) => {
      const { client, recording } = context(mode);
      const { plan } = await prepareRecordingUpload(
        client,
        recording,
        false,
        () => {},
      );
      expect(plan.create.id).toBe(recording.id);
      expect(plan.create.created_at).toBe('2026-01-01T00:00:00.123Z');
      expect(plan.chunks).toHaveLength(mode === 'archive-chunks' ? 51 : 1);
      expect(plan.seal.events).toHaveLength(mode === 'archive-pages' ? 53 : 3);
      expect(plan.seal.tracks[0]?.end_sample).toBe(plan.chunks.length * 32768);
      expect(plan.seal.gaps).toEqual([
        {
          track_id: recording.tracks[0]!.spec.track_id,
          start_ms: plan.chunks.length * 2048,
          end_ms: 1000 + plan.chunks.length * 2048,
          reason: 'paused',
        },
      ]);
    },
  );
  it('preserves component provenance unchanged in the validated upload seal', async () => {
    const { client, recording } = context('archive-build');
    const { plan } = await prepareRecordingUpload(
      client,
      recording,
      false,
      () => {},
    );
    const vector: {
      components: { role: string; sha256: string }[];
      expected_sha256: string;
    } = JSON.parse(
      readFileSync(
        new URL('../../contracts/fixtures/capture-build.json', import.meta.url),
        'utf8',
      ),
    )[0];
    expect(plan.seal.events).toHaveLength(8);
    expect(plan.seal.events.slice(0, 5)).toEqual([
      ...vector.components.map(({ role, sha256 }) => ({
        event_type: `capture.component.${role}`,
        clock_ms: 0,
        capture_epoch: null,
        code: sha256,
      })),
      {
        event_type: 'capture.build',
        clock_ms: 0,
        capture_epoch: null,
        code: vector.expected_sha256,
      },
    ]);
    expect(plan.seal.events[5]).toMatchObject({
      event_type: 'capture.started',
      code: 'wasapi_qpc_v1',
    });
    expect(plan.seal.gaps).toEqual([
      {
        track_id: recording.tracks[0]!.spec.track_id,
        start_ms: 2048,
        end_ms: 3048,
        reason: 'paused',
      },
    ]);
  });
  it('requires separate consent for interrupted capture and preserves its real native state', async () => {
    const { client, recording } = context('archive-incomplete');
    await expect(
      prepareRecordingUpload(client, recording, false, () => {}),
    ).rejects.toMatchObject({ code: 'incomplete_upload_not_accepted' });
    expect(
      (await prepareRecordingUpload(client, recording, true, () => {})).plan
        .seal,
    ).toMatchObject({ native_state: 'failed', accept_incomplete: true });
  });
  it.each([
    'archive-orphan',
    'archive-corrupt',
    'archive-key-unavailable',
    'archive-wrong-source',
    'archive-bad-page',
    'archive-wrong-chunk',
  ])('refuses ambiguous, corrupt or changed archives: %s', async (mode) => {
    const { client, recording } = context(mode);
    await expect(
      prepareRecordingUpload(client, recording, true, () => {}),
    ).rejects.toThrow();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!databaseUrl || !endpoint)(
  'durable consent through native frames, real HTTP, PostgreSQL and private S3',
  () => {
    const schema = `notes_desktop_upload_${randomUUID().replaceAll('-', '')}`;
    const bucket = `notes-desktop-${randomUUID()}`;
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
    let bucketCreated = false,
      schemaCreated = false,
      clientSequence = 0;
    let admin: Database, db: Database, blobs: RecordingBlobs;
    let app: Awaited<ReturnType<typeof createServer>>, base: string;
    const controllers = new Set<RecordingController>(),
      stores = new Set<LocalStore>();
    const clients = new Set<AudioHostClient>(),
      directories = new Set<string>(),
      keys = new Set<Buffer>();
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
        {
          mode: 'development',
          host: '127.0.0.1',
          trustedProxies: ['127.0.0.1/32'],
        },
        blobs,
      );
      base = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 30_000);
    afterEach(async () => {
      for (const controller of controllers) await controller.stop(() => {});
      controllers.clear();
      for (const client of clients) await client.close();
      clients.clear();
      for (const store of stores) store.close();
      stores.clear();
      for (const key of keys) key.fill(0);
      keys.clear();
      for (const directory of directories)
        rmSync(directory, { recursive: true, force: true });
      directories.clear();
      vi.restoreAllMocks();
    });
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
    async function context(initialMode = 'archive') {
      const subject = randomUUID(),
        profile = `synthetic:${subject}`,
        clientAddress = `2001:db8::${(++clientSequence).toString(16)}`;
      const actor = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const doc = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic durable upload',
          notes: '',
        },
        randomUUID(),
      );
      const directory = mkdtempSync(join(tmpdir(), 'notes-upload-journal-'));
      directories.add(directory);
      const key = randomBytes(32);
      keys.add(key);
      const path = join(directory, 'notes.sqlite');
      const local = new LocalStore(path, key);
      stores.add(local);
      local.applyRemote(profile, {
        ...doc,
        created_at: doc.created_at.toISOString(),
        updated_at: doc.updated_at.toISOString(),
      });
      const spec = source(),
        chunk = randomUUID();
      const recording = local.beginRecording(profile, doc.id, [spec]);
      local.updateRecording(profile, doc.id, recording.id, { state: 'sealed' });
      let mode = initialMode;
      const requests: MockInstance<AudioHostClient['request']>[] = [];
      const reads: MockInstance<AudioHostClient['readChunk']>[] = [];
      const create = vi.fn(() => {
        const client = new AudioHostClient(
          process.execPath,
          [
            fixture,
            mode,
            JSON.stringify(spec),
            recording.id,
            spec.track_id,
            chunk,
          ],
          () => {},
        );
        clients.add(client);
        requests.push(vi.spyOn(client, 'request'));
        reads.push(vi.spyOn(client, 'readChunk'));
        return client;
      });
      const changed = vi.fn(),
        remove = vi.fn(async (_id: string) => {});
      const controller = new RecordingController(
        local,
        create,
        changed,
        remove,
      );
      controllers.add(controller);
      const api = new ApiClient(
        base,
        async () => ({
          'x-dev-subject': subject,
          'x-forwarded-for': clientAddress,
        }),
        { allowLoopback: true },
      );
      const upload = {
        profile,
        scope: 1,
        api,
        allowLoopback: true,
        authorize: () => {},
      };
      controller.resumeUploads(upload);
      const status = () =>
        local.recordingUploadStatus(profile, doc.id, recording.id);
      return {
        actor,
        doc,
        profile,
        key,
        path,
        local,
        recording,
        controller,
        create,
        changed,
        remove,
        api,
        upload,
        status,
        requests,
        reads,
        mode: (value: string) => {
          mode = value;
        },
      };
    }
    it('never uploads stopped audio without an explicit accepted durable intent', async () => {
      const c = await context();
      expect(c.create).not.toHaveBeenCalled();
      expect(c.status()).toBeNull();
      expect(
        (await db.recordings.list(c.actor.user_id, c.doc.id, 0)).recordings,
      ).toEqual([]);
      expect(() =>
        c.controller.requestUpload(
          'unrelated',
          c.doc.id,
          c.recording.id,
          false,
        ),
      ).toThrow('signed-in cloud workspace');
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      const remote = await db.recordings.get(c.actor.user_id, c.recording.id);
      expect(remote).toMatchObject({
        state: 'ready',
        chunk_count: 1,
        verified_chunks: 1,
        partial: false,
      });
      expect(
        c.local.getRecording(c.profile, c.doc.id, c.recording.id).state,
      ).toBe('sealed');
      expect(c.remove).not.toHaveBeenCalled();
      expect(
        c.controller.snapshot(c.profile, c.doc.id).uploads[0],
      ).not.toHaveProperty('plan');
    });
    it('freezes the plan before creation and reconciles a lost seal response after closing and reopening the journal', async () => {
      const c = await context();
      const actual = globalThis.fetch;
      let lose = true;
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.pathname === `/v1/documents/${c.doc.id}/recordings`)
            expect(
              c.local.recordingUpload(c.profile, c.doc.id, c.recording.id)
                ?.plan,
            ).not.toBeNull();
          const result = await actual(input, init);
          if (url.pathname.endsWith('/seal') && lose) {
            lose = false;
            throw new TypeError('Synthetic response loss after commit.');
          }
          return result;
        });
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('waiting'));
      expect(
        (await db.recordings.get(c.actor.user_id, c.recording.id)).state,
      ).toBe('ready');
      await c.controller.stop(() => {});
      fetch.mockRestore();
      c.local.close();
      stores.delete(c.local);
      const restored = new LocalStore(c.path, c.key);
      stores.add(restored);
      const saved = restored.recordingUpload(
        c.profile,
        c.doc.id,
        c.recording.id,
      )!;
      restored.saveRecordingUpload(c.profile, { ...saved, retry_at: 0 });
      const restarted = new RecordingController(
        restored,
        c.create,
        c.changed,
        c.remove,
      );
      controllers.add(restarted);
      restarted.resumeUploads(c.upload);
      await vi.waitFor(() =>
        expect(
          restored.recordingUploadStatus(c.profile, c.doc.id, c.recording.id)
            ?.state,
        ).toBe('complete'),
      );
      expect(c.create).toHaveBeenCalledTimes(1);
      expect(c.remove).not.toHaveBeenCalled();
    });
    it('retains the upload helper and fences repeated deletion after a failed close until physical exit', async () => {
      const c = await context();
      const create = c.create.getMockImplementation();
      if (!create) throw new Error('The framed upload factory is unavailable.');
      const failure = new Error(
        'Synthetic close failure before physical exit.',
      );
      let client: AudioHostClient | undefined;
      let close: MockInstance<AudioHostClient['close']> | undefined;
      c.create.mockImplementationOnce(() => {
        client = create();
        close = vi.spyOn(client, 'close').mockRejectedValue(failure);
        return client;
      });
      try {
        c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
        await vi.waitFor(() => expect(close).toHaveBeenCalled());
        if (!client)
          throw new Error('The framed upload helper was not created.');
        expect(
          (await client.request({ command: 'list_devices' })).event_type,
        ).toBe('devices');
        expect(c.status()?.state).toBe('complete');
        expect(c.controller.snapshot(c.profile, c.doc.id).error?.code).toBe(
          'audio_operation_failed',
        );
        await expect(c.controller.stop(() => {})).rejects.toBe(failure);
        c.controller.resumeUploads(c.upload);
        expect(c.controller.snapshot(c.profile, c.doc.id).busy).toBe(true);
        await expect(
          c.controller.inspect(c.profile, c.doc.id, c.recording.id, () => {}),
        ).rejects.toMatchObject({ code: 'audio_busy' });
        expect(() =>
          c.controller.requestUpload(
            c.profile,
            c.doc.id,
            c.recording.id,
            false,
          ),
        ).toThrow('current audio operation');
        c.local.remove(c.profile, c.doc.id);
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(c.controller.cleanup()).rejects.toBe(failure);
        expect(c.create).toHaveBeenCalledTimes(1);
        expect(c.remove).not.toHaveBeenCalled();
        expect(c.local.pendingRecordingDeletions()).toEqual([c.recording.id]);
      } finally {
        close?.mockRestore();
        await client?.close();
      }
      if (!client) throw new Error('The framed upload helper was not created.');
      await client.stopped;
      await c.controller.cleanup();
      expect(c.remove).toHaveBeenCalledExactlyOnceWith(c.recording.id);
      expect(c.local.pendingRecordingDeletions()).toEqual([]);
      expect(c.controller.snapshot(c.profile, null).busy).toBe(false);
    });
    it('keeps queued uploads fenced after a failed helper close and resumes them only after physical exit', async () => {
      const c = await context();
      const spec = source(),
        chunk = randomUUID();
      const next = c.local.beginRecording(c.profile, c.doc.id, [spec]);
      c.local.updateRecording(c.profile, c.doc.id, next.id, {
        state: 'sealed',
      });
      const create = c.create.getMockImplementation();
      if (!create) throw new Error('The framed upload factory is unavailable.');
      const failure = new Error(
        'Synthetic close failure before physical exit.',
      );
      let client: AudioHostClient | undefined;
      let close: MockInstance<AudioHostClient['close']> | undefined;
      c.create
        .mockImplementationOnce(() => {
          client = create();
          close = vi.spyOn(client, 'close').mockRejectedValue(failure);
          return client;
        })
        .mockImplementationOnce(() => {
          const helper = new AudioHostClient(
            process.execPath,
            [
              fixture,
              'archive',
              JSON.stringify(spec),
              next.id,
              spec.track_id,
              chunk,
            ],
            () => {},
          );
          clients.add(helper);
          return helper;
        });
      try {
        c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
        await vi.waitFor(() => expect(close).toHaveBeenCalled());
        if (!client)
          throw new Error('The framed upload helper was not created.');
        expect(
          (await client.request({ command: 'list_devices' })).event_type,
        ).toBe('devices');
        expect(c.status()?.state).toBe('complete');
        c.local.saveRecordingUpload(c.profile, {
          recording_id: next.id,
          document_id: c.doc.id,
          state: 'queued',
          verified_chunks: 0,
          total_chunks: 0,
          verified_bytes: 0,
          partial: false,
          attempts: 0,
          retry_at: 0,
          error: null,
          accept_incomplete: false,
          plan: null,
        });
        c.controller.resumeUploads(c.upload);
        expect(c.create).toHaveBeenCalledTimes(1);
        expect(
          c.local.recordingUploadStatus(c.profile, c.doc.id, next.id)?.state,
        ).toBe('queued');
      } finally {
        close?.mockRestore();
        await client?.close();
      }
      await vi.waitFor(() =>
        expect(
          c.local.recordingUploadStatus(c.profile, c.doc.id, next.id)?.state,
        ).toBe('complete'),
      );
      expect(c.create).toHaveBeenCalledTimes(2);
      expect((await db.recordings.get(c.actor.user_id, next.id)).state).toBe(
        'ready',
      );
      await c.controller.stop(() => {});
      expect(c.controller.snapshot(c.profile, c.doc.id).busy).toBe(false);
    });
    it('pauses native reads and network work durably, never automatically resuming a paused intent', async () => {
      const c = await context('archive-stall-read');
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.reads[0]).toHaveBeenCalled());
      await c.controller.pauseUpload(c.profile, c.doc.id, c.recording.id);
      expect(c.status()?.state).toBe('paused');
      expect(c.controller.snapshot(c.profile, null).busy).toBe(false);
      c.controller.resumeUploads(c.upload);
      expect(c.create).toHaveBeenCalledTimes(1);
      c.mode('archive');
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      expect(c.remove).not.toHaveBeenCalled();
    });
    it('resumes after the verified prefix instead of replaying it into API rate limits', async () => {
      const c = await context('archive-two');
      const actual = globalThis.fetch;
      const registrations: number[] = [];
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      let failedAt = 0;
      let interrupt = true;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (
          url.pathname === `/v1/recordings/${c.recording.id}/chunks` &&
          typeof init?.body === 'string'
        ) {
          const upload = JSON.parse(init.body) as {
            chunk: { sequence: number };
          };
          registrations.push(upload.chunk.sequence);
          if (upload.chunk.sequence === 1 && interrupt) {
            interrupt = false;
            failedAt = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(failedAt);
            return Response.json(
              {
                code: 'temporary_unavailable',
                message: 'Synthetic retryable interruption.',
                retryable: true,
                request_id: randomUUID(),
              },
              { status: 503, headers: { 'Retry-After': '60' } },
            );
          }
        }
        return actual(input, init);
      });
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('waiting'));
      expect(c.status()?.verified_chunks).toBe(1);
      expect(c.status()!.retry_at).toBe(failedAt + 60_500);
      random.mockReturnValue(0);
      c.controller.resumeUploads(c.upload);
      expect(c.status()!.retry_at).toBe(failedAt + 60_500);
      expect(registrations).toEqual([0, 1]);
      vi.mocked(Date.now).mockRestore();
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      expect(registrations).toEqual([0, 1, 1]);
      expect(c.reads[1]).toHaveBeenCalledTimes(1);
      expect(c.reads[1]?.mock.calls[0]?.[1].chunk.sequence).toBe(1);
    });
    it('aborts and drains an in-flight remote deletion before the local vault closes', async () => {
      const c = await context();
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      const actual = globalThis.fetch;
      let deleting = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (init?.method === 'DELETE') {
          deleting = true;
          const signal = init.signal;
          if (!signal)
            throw new Error('Deletion must carry a cancellation signal.');
          return new Promise<Response>((_resolve, reject) => {
            const cancel = () =>
              reject(new Error('Synthetic aborted deletion.'));
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
          });
        }
        return actual(input, init);
      });
      await c.controller.removeSavedAudio(c.profile, c.doc.id, c.recording.id);
      await vi.waitFor(() => expect(deleting).toBe(true));
      await c.controller.stop(() => {});
      expect(c.status()?.state).toBe('delete_pending');
      expect(c.status()?.error).toBeNull();
      expect(c.controller.snapshot(c.profile, null).busy).toBe(false);
      expect(c.remove).not.toHaveBeenCalled();
    });
    it('stops native work before revocation deletes the owned media and never recreates purged intent', async () => {
      const c = await context('archive-stall-read');
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.reads[0]).toHaveBeenCalled());
      c.local.purgeProfile(c.profile);
      c.controller.resumeUploads(null);
      await c.controller.reconcile('offline');
      expect(c.remove).toHaveBeenCalledWith(c.recording.id);
      expect(c.local.nextRecordingUpload(c.profile)).toBeNull();
      expect(c.local.pendingRecordingDeletions()).toEqual([]);
    });
    it('cancels and drains transfer on profile changes and only resumes in the original authorized profile', async () => {
      const c = await context('archive-stall-read');
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.reads[0]).toHaveBeenCalled());
      c.controller.resumeUploads({
        ...c.upload,
        profile: 'different-profile',
        scope: 2,
      });
      await c.controller.reconcile('different-profile');
      expect(c.status()?.state).toBe('queued');
      expect(
        c.controller.snapshot('different-profile', null).active_upload,
      ).toBeNull();
      expect(c.create).toHaveBeenCalledTimes(1);
      c.mode('archive');
      c.controller.resumeUploads(c.upload);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
    });
    it('preserves an interrupted capture until separately accepted, without freezing a misleading complete seal', async () => {
      const c = await context('archive-incomplete');
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('attention'));
      expect(c.status()?.error?.code).toBe('incomplete_upload_not_accepted');
      expect(
        c.local.recordingUpload(c.profile, c.doc.id, c.recording.id)?.plan,
      ).toBeNull();
      expect(
        (await db.recordings.list(c.actor.user_id, c.doc.id, 0)).recordings,
      ).toEqual([]);
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, true);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      expect(
        (await db.recordings.get(c.actor.user_id, c.recording.id)).partial,
      ).toBe(true);
      expect(
        c.local.getRecording(c.profile, c.doc.id, c.recording.id).state,
      ).toBe('interrupted');
    });
    it('keeps local audio while remote cleanup is pending and removes it only after confirmed user-requested deletion', async () => {
      const c = await context();
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      await c.controller.removeSavedAudio(c.profile, c.doc.id, c.recording.id);
      await vi.waitFor(() => expect(c.status()?.state).toBe('delete_pending'));
      expect(c.local.getRecording(c.profile, c.doc.id, c.recording.id).id).toBe(
        c.recording.id,
      );
      expect(c.remove).not.toHaveBeenCalled();
      await expect(
        db.recordings.get(c.actor.user_id, c.recording.id),
      ).rejects.toThrow();
      await db.pool.query(
        "UPDATE recording_objects SET protected_until=now()-interval '1 second',cleanup_after=now()-interval '1 second' WHERE recording_id=$1",
        [c.recording.id],
      );
      await cleanupRecordingObjects(db, blobs, new AbortController().signal);
      await c.controller.removeSavedAudio(c.profile, c.doc.id, c.recording.id);
      await vi.waitFor(() =>
        expect(c.remove).toHaveBeenCalledWith(c.recording.id),
      );
      expect(() =>
        c.local.getRecording(c.profile, c.doc.id, c.recording.id),
      ).toThrow('not available in this document');
      expect(c.local.pendingRecordingDeletions()).toEqual([]);
    });
    it('does not delete local audio after an internally contradictory cleanup confirmation', async () => {
      const c = await context();
      c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
      await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
      const actual = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
        init?.method === 'DELETE'
          ? Promise.resolve(
              Response.json({
                state: 'cleanup_confirmed',
                pending_objects: 1,
                cleanup_errors: 0,
                repeated_cleanup: true,
              }),
            )
          : actual(input, init),
      );
      await c.controller.removeSavedAudio(c.profile, c.doc.id, c.recording.id);
      await vi.waitFor(() => expect(c.status()?.error).not.toBeNull());
      expect(c.status()?.state).toBe('delete_pending');
      expect(c.local.getRecording(c.profile, c.doc.id, c.recording.id).id).toBe(
        c.recording.id,
      );
      expect(c.remove).not.toHaveBeenCalled();
    });
    it.each(['id', 'document_id', 'created_at', 'partial'] as const)(
      'rejects a falsely ready response with changed %s without reading or deleting local media',
      async (field) => {
        const c = await context();
        c.controller.requestUpload(c.profile, c.doc.id, c.recording.id, false);
        await vi.waitFor(() => expect(c.status()?.state).toBe('complete'));
        const original = c.local.recordingUpload(
          c.profile,
          c.doc.id,
          c.recording.id,
        )!;
        c.local.saveRecordingUpload(c.profile, {
          ...original,
          state: 'queued',
        });
        const actual = globalThis.fetch;
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          async (input, init) => {
            const result = await actual(input, init);
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.pathname === `/v1/documents/${c.doc.id}/recordings`) {
              const value = remoteRecordingSchema.parse(await result.json());
              return Response.json({
                ...value,
                [field]:
                  field === 'partial'
                    ? true
                    : field === 'created_at'
                      ? '2025-01-01T00:00:00Z'
                      : randomUUID(),
              });
            }
            return result;
          },
        );
        c.controller.resumeUploads(c.upload);
        await vi.waitFor(() => expect(c.status()?.state).toBe('attention'));
        expect(c.status()?.error?.code).toBe('invalid_upload_response');
        expect(c.create).toHaveBeenCalledTimes(1);
        expect(c.remove).not.toHaveBeenCalled();
      },
    );
  },
);
