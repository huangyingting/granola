import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createServer } from '@windows-ai-notes/api/server';
import { Database } from '@windows-ai-notes/db';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import {
  desktopStateSchema,
  type DesktopChange,
} from '@windows-ai-notes/contracts/desktop';
import { AccountSession, OidcClient } from './auth.js';
import { WorkspaceController } from './workspace.js';
import { SyncEngine, workspaceProfile } from './sync.js';
import { oidcFixture } from './oidc.fixture.js';
import { ApiClient } from './http.js';
import { transcriptPageSchema } from '@windows-ai-notes/contracts/server';
import { RecordingBlobs } from '@windows-ai-notes/storage';
import { AudioHostClient } from './audio.js';
import { RecordingController } from './recording.js';
import { runOnce } from '@windows-ai-notes/worker';
import { DesktopDelivery } from './delivery.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'main-process accounts and workspace coordination with the real provisioned API',
  () => {
    let admin: Database;
    let db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    let issuer: Awaited<ReturnType<typeof oidcFixture>>;
    let local: LocalStore;
    let controller: WorkspaceController;
    let base: string;
    let directory: string;
    let key: Buffer;
    let actor: { user_id: string; workspace_id: string };
    let events: DesktopChange[];
    const deliveries: DesktopDelivery[] = [];
    const schema = `notes_workspace_${randomUUID().replaceAll('-', '')}`;
    const fields = (text: string) => ({
      title: 'Synthetic meeting',
      content: richTextFromPlainText(text),
      tags: [],
    });
    const open = (browser = issuer.browser, delivery?: DesktopDelivery) =>
      new WorkspaceController(local, browser, (event) => events.push(event), {
        allowLoopback: true,
        ...(delivery ? { delivery } : {}),
      });
    function observe() {
      const records: Record<string, unknown>[] = [];
      const delivery = new DesktopDelivery(
        new Writable({
          write(chunk, _encoding, done) {
            records.push(JSON.parse(String(chunk)));
            done();
          },
        }),
      );
      deliveries.push(delivery);
      return { delivery, records };
    }
    const connect = () =>
      controller.execute({
        operation: 'connect',
        scope: controller.scope,
        service_url: base,
      });
    const activate = (
      copy_offline = false,
      workspace_id = actor.workspace_id,
    ) =>
      controller.execute({
        operation: 'activateWorkspace',
        scope: controller.scope,
        workspace_id,
        copy_offline,
      });
    const create = (text: string) =>
      controller.execute({
        operation: 'create',
        scope: controller.scope,
        value: fields(text),
      });
    const accountSession = () =>
      new AccountSession(
        local,
        new OidcClient(issuer.configuration, true),
        base,
        true,
      );
    async function seed(text = 'Remote notes.') {
      return db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic cloud meeting',
          notes: text,
        },
        randomUUID(),
      );
    }
    async function secondWorkspace() {
      const id = randomUUID();
      await db.pool.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
        id,
        'Second synthetic workspace',
      ]);
      await db.pool.query(
        'INSERT INTO memberships(workspace_id,user_id) VALUES($1,$2)',
        [id, actor.user_id],
      );
      return id;
    }
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
    });
    beforeEach(async () => {
      issuer = await oidcFixture();
      actor = await db.provision(
        issuer.configuration.issuer,
        issuer.state.subject,
      );
      app = await createServer(db, {
        mode: 'oidc',
        host: '127.0.0.1',
        issuer: issuer.configuration.issuer,
        audience: issuer.configuration.audience,
        jwksUrl: `${issuer.state.issuer}keys`,
        requiredScope: 'notes.access',
        desktop: issuer.configuration,
      });
      base = await app.listen({ host: '127.0.0.1', port: 0 });
      directory = mkdtempSync(join(tmpdir(), 'windows-notes-workspace-'));
      key = randomBytes(32);
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      events = [];
      controller = open();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      controller?.dispose();
      for (const delivery of deliveries.splice(0)) delivery.close();
      await app?.close();
      await issuer?.close();
      local?.close();
      key?.fill(0);
      rmSync(directory, { recursive: true, force: true });
      expect(issuer.state.failures).toEqual([]);
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    it('drains a retired synchronization even after dispose clears its active reference', async () => {
      await connect();
      await activate();
      await controller.synchronize();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(SyncEngine.prototype, 'synchronize').mockImplementationOnce(
        async () => {
          await pending;
          return { more: false };
        },
      );
      const synchronizing = controller.synchronize();
      const rejected = expect(synchronizing).rejects.toMatchObject({
        code: 'sync_cancelled',
      });
      controller.dispose();
      let closed = false;
      const closing = controller.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await Promise.all([closing, rejected]);
      expect(closed).toBe(true);
    });
    it('loads current authenticated AI allowance without caching it and fences late results after a scope change', async () => {
      await expect(
        controller.accountUsage(controller.scope),
      ).rejects.toMatchObject({ code: 'account_usage_unavailable' });
      await connect();
      await activate();
      const usage = await controller.accountUsage(controller.scope);
      expect(usage.limits.audio_ms).toBe('28800000');
      expect(usage.uncertain_requests).toBe('0');
      await db.usage.setLimits(actor.user_id, {
        input_tokens: 10,
        output_tokens: 5,
        audio_ms: 1000,
      });
      expect(
        (await controller.accountUsage(controller.scope)).limits.audio_ms,
      ).toBe('1000');
      let reached!: () => void;
      let release!: () => void;
      const seen = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        async (...arguments_: Parameters<typeof fetch>) => {
          const response = await original(...arguments_);
          if (String(arguments_[0]).endsWith('/v1/usage')) {
            const body = await response.text();
            reached();
            await waiting;
            return new Response(body, {
              status: response.status,
              headers: response.headers,
            });
          }
          return response;
        },
      );
      try {
        const scope = controller.scope;
        const late = controller.accountUsage(scope);
        await seen;
        await controller.execute({ operation: 'workOffline', scope });
        release();
        await expect(late).rejects.toMatchObject({ code: 'workspace_changed' });
        await expect(controller.accountUsage(scope)).rejects.toMatchObject({
          code: 'workspace_changed',
        });
      } finally {
        release();
        vi.unstubAllGlobals();
      }
    });
    it('requires explicit offline-copy consent, uses new IDs, keeps originals and deduplicates repeated imports', async () => {
      await create('Device-only private text.');
      const original = controller.snapshot().selected!;
      await connect();
      expect(controller.profile).toBe('offline');
      await activate();
      await controller.synchronize();
      expect(controller.snapshot().documents).toHaveLength(0);
      expect(local.get('offline', original.id)).toEqual(original);
      await activate(true);
      const copied = controller.snapshot().documents[0]!;
      expect(copied.id).not.toBe(original.id);
      await controller.synchronize();
      expect((await db.document(actor.user_id, copied.id)).notes).toBe(
        'Device-only private text.',
      );
      await activate(true);
      await controller.synchronize();
      expect(controller.snapshot().documents).toHaveLength(1);
      expect(local.list('offline')).toHaveLength(1);
      expect(desktopStateSchema.parse(controller.snapshot())).toEqual(
        controller.snapshot(),
      );
      const publicState = JSON.stringify(controller.snapshot());
      expect(publicState).not.toContain('access_token');
      expect(publicState).not.toContain('refresh_token');
      expect(publicState).not.toContain('notes.sqlite');
    });
    it('restarts with isolated encrypted credentials, drafts, immutable transcripts and selected workspace', async () => {
      const remote = await seed();
      const segment = {
        id: randomUUID(),
        start_ms: 0,
        end_ms: 1000,
        text: 'Synthetic cached evidence.',
      };
      await db.editTranscript(actor.user_id, remote.id, 0, [segment]);
      await connect();
      await activate();
      await controller.synchronize();
      const previous = controller.snapshot();
      expect(previous.transcript?.segments).toEqual([segment]);
      expect(
        readFileSync(join(directory, 'notes.sqlite-wal')).includes(
          Buffer.from('synthetic-refresh-'),
        ),
      ).toBe(false);
      controller.dispose();
      local.close();
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      expect(controller.snapshot()).toMatchObject({
        documents: previous.documents,
        selected_id: remote.id,
        transcript: previous.transcript,
        connection: { active_workspace: actor.workspace_id, status: 'ready' },
      });
      expect(accountSession().summary().status).toBe('active');
      expect(issuer.state.tokenCalls).toBe(1);
    });
    it.skipIf(!process.env.TEST_S3_ENDPOINT)(
      'durably reconciles lost transcription replies across restart, reviews candidates and fences late scope responses through real OIDC and private storage',
      async () => {
        const config = {
          endpoint: process.env.TEST_S3_ENDPOINT!,
          region: 'us-east-1',
          bucket: `notes-transcription-client-${randomUUID()}`,
          encryption: 'none' as const,
          credentials: {
            accessKeyId: 'storage-test-only',
            secretAccessKey: 'storage-test-only-secret',
          },
        };
        const s3 = new S3Client({ ...config, forcePathStyle: true });
        const nativeClients = new Set<AudioHostClient>();
        let recorder: RecordingController | undefined;
        let release: (() => void) | undefined;
        let pending: Promise<unknown> | undefined;
        await s3.send(new CreateBucketCommand({ Bucket: config.bucket }));
        try {
          await app.close();
          const blobs = new RecordingBlobs(config);
          app = await createServer(
            db,
            {
              mode: 'oidc',
              host: '127.0.0.1',
              issuer: issuer.configuration.issuer,
              audience: issuer.configuration.audience,
              jwksUrl: `${issuer.state.issuer}keys`,
              requiredScope: 'notes.access',
              desktop: issuer.configuration,
            },
            blobs,
          );
          base = await app.listen({ host: '127.0.0.1', port: 0 });
          const remote = await seed(
            'Notes stay independent of generated transcripts.',
          );
          await connect();
          await activate();
          await controller.synchronize();
          const profile = controller.profile;
          const spec = {
            track_id: randomUUID(),
            kind: 'microphone' as const,
            capture_scope: 'endpoint' as const,
            device_selection_policy: 'explicit' as const,
            device_id: 'synthetic',
          };
          const recording = local.beginRecording(profile, remote.id, [spec]);
          local.updateRecording(profile, remote.id, recording.id, {
            state: 'sealed',
          });
          const chunk = randomUUID();
          recorder = new RecordingController(
            local,
            () => {
              const client = new AudioHostClient(
                process.execPath,
                [
                  fileURLToPath(
                    new URL('../fixtures/audio-host.mjs', import.meta.url),
                  ),
                  'archive',
                  JSON.stringify(spec),
                  recording.id,
                  spec.track_id,
                  chunk,
                ],
                () => {},
              );
              nativeClients.add(client);
              return client;
            },
            () => {},
            async () => {},
          );
          recorder.resumeUploads(controller.recordingUploadContext());
          recorder.requestUpload(profile, remote.id, recording.id, false);
          await vi.waitFor(() =>
            expect(
              local.recordingUploadStatus(profile, remote.id, recording.id)
                ?.state,
            ).toBe('complete'),
          );
          await recorder.stop(() => {});
          const intentName = `recording-finalization:${recording.id}`;
          const original = ApiClient.prototype.finalizeRecording;
          let lose = true,
            hold = false,
            heldJob: string | undefined;
          const requests = vi
            .spyOn(ApiClient.prototype, 'finalizeRecording')
            .mockImplementation(async function (
              this: ApiClient,
              id,
              body,
              key,
              signal,
            ) {
              expect(
                local.getArtifact(profile, remote.id, intentName, z.unknown()),
              ).toMatchObject({ body, key, job_id: null });
              const job = await original.call(this, id, body, key, signal);
              if (lose) {
                lose = false;
                throw new TypeError(
                  'Synthetic response loss after enqueue commit.',
                );
              }
              if (hold) {
                heldJob = job.id;
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              }
              return job;
            });
          const command = () => ({
            operation: 'finalizeRecordingTranscript' as const,
            scope: controller.scope,
            id: remote.id,
            recording_id: recording.id,
            locale: 'en-US' as const,
            accept_incomplete: false,
            confirmed: true as const,
            new_attempt: true,
            consent_id: randomUUID(),
          });
          await expect(controller.finalizeRecording(command())).rejects.toThrow(
            'Synthetic response loss',
          );
          expect(await db.jobs(actor.user_id, remote.id)).toHaveLength(1);
          await db.editTranscript(actor.user_id, remote.id, 0, [
            {
              id: randomUUID(),
              start_ms: 0,
              end_ms: 1,
              text: 'A manual transcript won the race.',
            },
          ]);
          await controller.synchronize();
          controller.dispose();
          local.close();
          local = new LocalStore(join(directory, 'notes.sqlite'), key);
          controller = open();
          await controller.finalizeRecording(command());
          expect(requests).toHaveBeenCalledTimes(2);
          expect(requests.mock.calls[1]!.slice(1, 3)).toEqual(
            requests.mock.calls[0]!.slice(1, 3),
          );
          expect(requests.mock.calls[1]![1].base_revision).toBe(0);
          await runOnce(
            db,
            {
              provider: 'fixture',
              configurationVersion: 'desktop-finalization-v1',
              transcribe: async () => ({
                segments: [
                  {
                    id: randomUUID(),
                    start_ms: 0,
                    end_ms: 500,
                    text: 'Generated source evidence.',
                  },
                ],
                usage: { input_tokens: 0, output_tokens: 0, audio_ms: 2048 },
              }),
              summarize: async () => {
                throw new Error('Unexpected summary request.');
              },
            },
            undefined,
            blobs,
          );
          await controller.synchronize();
          expect(controller.snapshot()).toMatchObject({
            transcript_revision: 1,
            jobs: [{ result: { applied: false, transcript_revision: 2 } }],
          });
          const candidate = await controller.transcriptPage(
            controller.scope,
            remote.id,
            2,
            0,
          );
          expect(candidate).toMatchObject({
            is_candidate: true,
            recording: { id: recording.id },
          });
          const timeline = await controller.transcriptTimeline(
            controller.scope,
            remote.id,
            2,
            0,
          );
          expect(timeline.entries).toHaveLength(4);
          const draft = controller.snapshot().selected!;
          await controller.execute({
            operation: 'save',
            scope: controller.scope,
            id: remote.id,
            local_revision: draft.local_revision,
            value: fields('Pending note edits survive transcript application.'),
          });
          await controller.applyTranscript({
            operation: 'applyTranscript',
            scope: controller.scope,
            id: remote.id,
            source_revision: 2,
            base_revision: 1,
            confirmed: true,
          });
          expect(controller.snapshot().transcript_revision).toBe(3);
          expect((await db.document(actor.user_id, remote.id)).notes).toBe(
            'Pending note edits survive transcript application.',
          );
          controller.dispose();
          local.close();
          local = new LocalStore(join(directory, 'notes.sqlite'), key);
          controller = open();
          const offline = vi
            .spyOn(ApiClient.prototype, 'transcriptTimeline')
            .mockRejectedValue(
              new TypeError('Synthetic offline timeline transport.'),
            );
          expect(
            await controller.transcriptTimeline(
              controller.scope,
              remote.id,
              2,
              0,
            ),
          ).toEqual(timeline);
          expect(offline).not.toHaveBeenCalled();
          offline.mockRestore();
          hold = true;
          pending = controller.finalizeRecording(command());
          const failure = expect(pending).rejects.toMatchObject({
            code: 'workspace_changed',
          });
          await vi.waitFor(() => expect(heldJob).toBeTypeOf('string'));
          await controller.execute({
            operation: 'workOffline',
            scope: controller.scope,
          });
          release!();
          await failure;
          expect(
            local.getArtifact(profile, remote.id, intentName, z.unknown()),
          ).toMatchObject({ job_id: null });
          expect(
            local.getArtifact(
              profile,
              remote.id,
              `job:${heldJob}`,
              z.unknown(),
            ),
          ).toBeNull();
        } finally {
          release?.();
          if (pending) await Promise.allSettled([pending]);
          await recorder?.stop(() => {});
          for (const client of nativeClients) await client.close();
          await app.close();
          await db.pool.query(
            "UPDATE jobs SET state='cancelled',lease_token=lease_token+1 WHERE owner_id=$1 AND state IN ('queued','running','retry_wait')",
            [actor.user_id],
          );
          let continuation: string | undefined;
          do {
            const page = await s3.send(
              new ListObjectsV2Command({
                Bucket: config.bucket,
                ContinuationToken: continuation,
              }),
            );
            for (const item of page.Contents ?? [])
              if (item.Key)
                await s3.send(
                  new DeleteObjectCommand({
                    Bucket: config.bucket,
                    Key: item.Key,
                  }),
                );
            continuation = page.NextContinuationToken;
          } while (continuation);
          await s3.send(new DeleteBucketCommand({ Bucket: config.bucket }));
          s3.destroy();
        }
      },
    );
    it('rejects stale renderer writes after changing scopes without altering either profile', async () => {
      await create('Original device-only text.');
      await connect();
      await activate(true);
      const previous = controller.snapshot();
      const copied = previous.documents[0]!;
      await controller.execute({
        operation: 'workOffline',
        scope: controller.scope,
      });
      await expect(
        controller.execute({
          operation: 'save',
          scope: previous.scope,
          id: copied.id,
          local_revision: copied.local_revision,
          value: fields('Must not cross scopes.'),
        }),
      ).rejects.toMatchObject({ code: 'workspace_changed' });
      expect(
        richTextToPlainText(
          local.get(
            workspaceProfile(base, actor.user_id, actor.workspace_id, true),
            copied.id,
          ).content,
        ),
      ).toBe('Original device-only text.');
      expect(richTextToPlainText(controller.snapshot().selected!.content)).toBe(
        'Original device-only text.',
      );
    });
    it('synchronizes only the first bounded transcript page and preserves opened pages through encrypted restart', async () => {
      const remote = await seed();
      const segments = Array.from({ length: 1207 }, (_, index) => ({
        id: randomUUID(),
        start_ms: index * 1000,
        end_ms: index * 1000 + 999,
        text: `Synthetic immutable segment ${index}.`,
      }));
      const { delivery, records } = observe();
      controller.dispose();
      controller = open(issuer.browser, delivery);
      await db.transaction((tx) =>
        db.transcripts.write(
          tx,
          actor.user_id,
          remote.id,
          0,
          'azure_speech_fast',
          segments,
        ),
      );
      await connect();
      await activate();
      await controller.synchronize();
      const state = controller.snapshot();
      expect(state.transcript).toMatchObject({
        total_segments: 1207,
        offset: 0,
        has_more: true,
        segments: segments.slice(0, 50),
      });
      expect(state.presentations).toContainEqual(
        expect.objectContaining({
          kind: 'transcript_page',
          revision: 1,
          offset: 0,
        }),
      );
      expect(
        records.find((value) => value.origin === 'synchronization'),
      ).toMatchObject({ outcome: 'validated_in_main' });
      expect(
        (await controller.transcriptPage(state.scope, remote.id, 1, 50))
          .segments,
      ).toEqual(segments.slice(50, 100));
      const marker = delivery
        .markers(state.scope, remote.id)
        .find((value) => value.offset === 50)!;
      expect(marker).toMatchObject({ kind: 'transcript_page', revision: 1 });
      expect(delivery.present(state.scope, remote.id, marker.token)).toBe(true);
      expect(JSON.stringify(records)).not.toContain(
        'Synthetic immutable segment',
      );
      const profile = controller.profile;
      controller.dispose();
      local.close();
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      const request = vi
        .spyOn(ApiClient.prototype, 'transcriptPage')
        .mockRejectedValue(new Error('Synthetic offline connection.'));
      expect(
        (await controller.transcriptPage(controller.scope, remote.id, 1, 50))
          .segments,
      ).toEqual(segments.slice(50, 100));
      expect(request).not.toHaveBeenCalled();
      await expect(
        controller.transcriptPage(controller.scope, remote.id, 1, 100),
      ).rejects.toThrow('Synthetic offline connection.');
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:100',
          transcriptPageSchema,
        ),
      ).toBeNull();
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:50',
          transcriptPageSchema,
        )?.segments,
      ).toEqual(segments.slice(50, 100));
    });
    it('does not fail a successful selected-document deletion because delivery instrumentation reads a missing draft', async () => {
      const remote = await seed(),
        { delivery } = observe();
      controller.dispose();
      controller = open(issuer.browser, delivery);
      await connect();
      await activate();
      await controller.synchronize();
      expect(controller.snapshot().selected_id).toBe(remote.id);
      await db.deleteDocument(actor.user_id, remote.id);
      await controller.synchronize();
      expect(controller.snapshot()).toMatchObject({
        selected_id: null,
        connection: { status: 'ready', error: null },
      });
      expect(delivery.markers(controller.scope, remote.id)).toEqual([]);
    });
    it('rejects page responses arriving after scope changes, document deletion and changed immutable headers', async () => {
      const { delivery, records } = observe();
      controller.dispose();
      controller = open(issuer.browser, delivery);
      const remote = await seed();
      const segments = Array.from({ length: 60 }, (_, index) => ({
        id: randomUUID(),
        start_ms: index,
        end_ms: index + 1,
        text: `Segment ${index}.`,
      }));
      await db.editTranscript(actor.user_id, remote.id, 0, segments);
      await connect();
      await activate();
      await controller.synchronize();
      const page = await db.transcripts.page(actor.user_id, remote.id, 1, 50);
      const profile = controller.profile;
      const read = vi
        .spyOn(ApiClient.prototype, 'transcriptPage')
        .mockResolvedValue({ ...page, total_segments: 61, has_more: true });
      await expect(
        controller.transcriptPage(controller.scope, remote.id, 1, 50),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
      read.mockResolvedValueOnce({ ...page, is_candidate: true });
      await expect(
        controller.transcriptPage(controller.scope, remote.id, 1, 50),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
      read.mockResolvedValueOnce({ ...page, based_on_revision: 7 });
      await expect(
        controller.transcriptPage(controller.scope, remote.id, 1, 50),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:50',
          transcriptPageSchema,
        ),
      ).toBeNull();
      read.mockImplementationOnce(async () => {
        local.remoteDeleted(profile, remote.id);
        return page;
      });
      await expect(
        controller.transcriptPage(controller.scope, remote.id, 1, 50),
      ).rejects.toMatchObject({ code: 'local_document_missing' });
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:50',
          transcriptPageSchema,
        ),
      ).toBeNull();
      const restored = await db.document(actor.user_id, remote.id);
      local.applyRemote(profile, {
        ...restored,
        created_at: restored.created_at.toISOString(),
        updated_at: restored.updated_at.toISOString(),
      });
      let finish!: (value: typeof page) => void;
      let signal: AbortSignal | undefined;
      read.mockImplementationOnce((_id, _revision, _offset, pending) => {
        signal = pending;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const scope = controller.scope;
      const pending = controller.transcriptPage(scope, remote.id, 1, 50);
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'workspace_changed',
      });
      await controller.execute({ operation: 'workOffline', scope });
      expect(signal?.aborted).toBe(true);
      finish(page);
      await rejected;
      expect(
        records.filter(
          (value) =>
            value.code === 'desktop_delivery_received' && value.offset === 50,
        ),
      ).toEqual([]);
      expect(delivery.markers(scope, remote.id)).toEqual([]);
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:50',
          transcriptPageSchema,
        ),
      ).toBeNull();
    });
    it('reads legacy full-transcript caches without a connection and purges paged evidence on confirmed revocation', async () => {
      const remote = await seed();
      const segments = Array.from({ length: 60 }, (_, index) => ({
        id: randomUUID(),
        start_ms: index,
        end_ms: index + 1,
        text: `Legacy cached segment ${index}.`,
      }));
      await db.editTranscript(actor.user_id, remote.id, 0, segments);
      await connect();
      await activate();
      await controller.synchronize();
      const profile = controller.profile;
      local.putArtifact(profile, remote.id, 'transcript:1', {
        document_id: remote.id,
        revision: 1,
        source: 'manual',
        segments,
      });
      const read = vi.spyOn(ApiClient.prototype, 'transcriptPage');
      expect(
        (await controller.transcriptPage(controller.scope, remote.id, 1, 50))
          .segments,
      ).toEqual(segments.slice(50));
      expect(read).not.toHaveBeenCalled();
      local.putArtifact(
        profile,
        remote.id,
        'transcript:1',
        await db.transcripts.page(actor.user_id, remote.id, 1),
      );
      await controller.transcriptPage(controller.scope, remote.id, 1, 50);
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:50',
          transcriptPageSchema,
        ),
      ).not.toBeNull();
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        actor.user_id,
      ]);
      await expect(
        controller.transcriptPage(controller.scope, remote.id, 1, 51),
      ).rejects.toMatchObject({ code: 'identity_not_provisioned' });
      expect(controller.profile).toBe('offline');
      expect(
        local.getArtifact(
          profile,
          remote.id,
          'transcript-page:1:50',
          transcriptPageSchema,
        ),
      ).toBeNull();
      expect(controller.snapshot().documents).toEqual([]);
    });
    it('exposes both versions and resolves conflicts or remote deletion only through explicit new-copy decisions', async () => {
      const remote = await seed();
      await connect();
      await activate();
      await controller.synchronize();
      const saved = controller.snapshot().documents[0]!;
      await controller.execute({
        operation: 'save',
        scope: controller.scope,
        id: saved.id,
        local_revision: saved.local_revision,
        value: fields('My unsent version.'),
      });
      await db.edit(actor.user_id, remote.id, remote.revision, {
        notes: 'Another device version.',
      });
      await controller.synchronize();
      expect(controller.snapshot().conflict).toMatchObject({
        remote: { content: richTextFromPlainText('Another device version.') },
        deleted_remote: false,
        remote_revision: 2,
      });
      const resolved = await controller.execute({
        operation: 'resolve',
        scope: controller.scope,
        id: saved.id,
        choice: 'copy',
      });
      expect(resolved.selected_id).not.toBe(saved.id);
      await controller.synchronize();
      expect(
        (await db.document(actor.user_id, resolved.selected_id!)).notes,
      ).toBe('My unsent version.');
      const current = local.get(controller.profile, saved.id);
      await controller.execute({
        operation: 'save',
        scope: controller.scope,
        id: saved.id,
        local_revision: current.local_revision,
        value: fields('Recovery after deletion.'),
      });
      await db.deleteDocument(actor.user_id, saved.id);
      await controller.synchronize();
      await controller.execute({
        operation: 'select',
        scope: controller.scope,
        id: saved.id,
      });
      expect(controller.snapshot().conflict).toMatchObject({
        remote: null,
        deleted_remote: true,
      });
      await expect(
        controller.execute({
          operation: 'resolve',
          scope: controller.scope,
          id: saved.id,
          choice: 'local',
        }),
      ).rejects.toMatchObject({ code: 'deleted_document' });
      const recovery = await controller.execute({
        operation: 'resolve',
        scope: controller.scope,
        id: saved.id,
        choice: 'copy',
      });
      expect(recovery.selected_id).not.toBe(saved.id);
      await controller.synchronize();
      expect(
        (await db.document(actor.user_id, recovery.selected_id!)).notes,
      ).toBe('Recovery after deletion.');
    });
    it.each([true, false])(
      'atomically disconnects all cached workspaces with preserve_unsent=%s',
      async (preserve) => {
        const other = await secondWorkspace();
        await create('Existing offline draft.');
        await connect();
        await activate();
        await create('Unsent in workspace A.');
        const firstProfile = controller.profile;
        await activate(false, other);
        await create('Unsent in workspace B.');
        const secondProfile = controller.profile;
        expect(controller.snapshot().connection.unsent_count).toBe(2);
        const result = await controller.execute({
          operation: 'disconnect',
          scope: controller.scope,
          preserve_unsent: preserve,
        });
        expect(result.documents).toHaveLength(preserve ? 3 : 1);
        expect(result.connection.user_id).toBeNull();
        expect(local.list(firstProfile)).toHaveLength(0);
        expect(local.list(secondProfile)).toHaveLength(0);
        expect(accountSession().summary().status).toBe('signed_out');
        expect(issuer.state.revoked).toHaveLength(1);
      },
    );
    it('rolls back copied drafts, cache purge and credential deletion together when logout storage fails', async () => {
      await connect();
      await activate();
      await create('Unsent text must survive.');
      const profile = controller.profile;
      const purge = vi
        .spyOn(local, 'purgeProfile')
        .mockImplementationOnce(() => {
          throw new LocalError(
            'synthetic_disk_full',
            'Synthetic storage failure.',
          );
        });
      await expect(
        controller.execute({
          operation: 'disconnect',
          scope: controller.scope,
          preserve_unsent: true,
        }),
      ).rejects.toMatchObject({ code: 'synthetic_disk_full' });
      expect(local.list('offline')).toHaveLength(0);
      expect(local.list(profile)).toHaveLength(1);
      expect(accountSession().summary().status).toBe('active');
      purge.mockRestore();
      const result = await controller.execute({
        operation: 'disconnect',
        scope: controller.scope,
        preserve_unsent: true,
      });
      expect(result.documents).toHaveLength(1);
    });
    it('purges account-wide revocation across inactive workspaces and rejects late renderer saves', async () => {
      const other = await secondWorkspace();
      await seed();
      await connect();
      await activate();
      await controller.synchronize();
      const firstProfile = controller.profile;
      await activate(false, other);
      await create('Forbidden pending workspace text.');
      const previous = controller.snapshot();
      const secondProfile = controller.profile;
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        actor.user_id,
      ]);
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'identity_not_provisioned',
      });
      expect(local.list(firstProfile)).toHaveLength(0);
      expect(local.list(secondProfile)).toHaveLength(0);
      expect(controller.snapshot().connection).toMatchObject({
        status: 'reauth_required',
        workspaces: [],
        active_workspace: null,
      });
      expect(accountSession().summary().status).toBe('signed_out');
      expect(events.at(-1)).toMatchObject({
        kind: 'revoked',
        scope: previous.scope + 1,
      });
      const stale = previous.documents[0]!;
      await expect(
        controller.execute({
          operation: 'save',
          scope: previous.scope,
          id: stale.id,
          local_revision: stale.local_revision,
          value: fields('Late forbidden write.'),
        }),
      ).rejects.toMatchObject({ code: 'workspace_changed' });
      expect(controller.snapshot().documents).toHaveLength(0);
    });
    it('purges only a removed membership and retains access to other workspaces', async () => {
      const other = await secondWorkspace();
      await seed();
      await connect();
      await activate(false, other);
      await create('Other workspace draft.');
      const otherProfile = controller.profile;
      await activate();
      await controller.synchronize();
      const revokedProfile = controller.profile;
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',
        [actor.user_id, actor.workspace_id],
      );
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'workspace_access_revoked',
      });
      expect(local.list(revokedProfile)).toHaveLength(0);
      expect(local.list(otherProfile)).toHaveLength(1);
      expect(accountSession().summary().status).toBe('active');
      await activate(false, other);
      await controller.synchronize();
      expect(controller.snapshot().documents[0]?.status).toBe('synced');
    });
    it('refreshes once after an API 401 and respects explicit server backoff without replay storms', async () => {
      await connect();
      await activate();
      const realFetch = globalThis.fetch;
      let unauthorized = true;
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          if (String(input) === `${base}/v1/me` && unauthorized) {
            unauthorized = false;
            return new Response(
              JSON.stringify({
                code: 'unauthorized',
                message: 'Synthetic expired access.',
                retryable: false,
                request_id: randomUUID(),
              }),
              { status: 401 },
            );
          }
          return realFetch(input, init);
        });
      await controller.synchronize();
      expect(issuer.state.refreshCalls).toBe(1);
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      spy.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              code: 'rate_limited',
              message: 'Synthetic backoff.',
              retryable: true,
              request_id: randomUUID(),
            }),
            { status: 429, headers: { 'retry-after': '2' } },
          ),
      );
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'rate_limited',
      });
      const calls = spy.mock.calls.length;
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'sync_backoff',
      });
      expect(spy.mock.calls).toHaveLength(calls);
      expect(controller.snapshot().connection.next_retry_at).toBe(now + 2500);
    });
    it('retains the account and queued edits through a retryable identity-key outage and automatically resumes', async () => {
      await connect();
      await activate();
      const created = await create(
        'Queued notes survive a key-service outage.',
      );
      const profile = controller.profile;
      const scope = controller.scope;
      const realFetch = globalThis.fetch;
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) =>
          String(input).startsWith(`${base}/`)
            ? new Response(
                JSON.stringify({
                  code: 'identity_provider_unavailable',
                  message: 'Synthetic key-service outage.',
                  retryable: true,
                  request_id: randomUUID(),
                }),
                { status: 503 },
              )
            : realFetch(input, init),
        );
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'identity_provider_unavailable',
        status: 503,
        retryable: true,
      });
      expect(controller.snapshot().connection).toMatchObject({
        status: 'attention',
        user_id: actor.user_id,
        active_workspace: actor.workspace_id,
        unsent_count: 1,
        error: { code: 'identity_provider_unavailable', retryable: true },
      });
      expect(controller.snapshot().selected).toMatchObject({
        content: richTextFromPlainText(
          'Queued notes survive a key-service outage.',
        ),
      });
      expect(controller.profile).toBe(profile);
      expect(controller.scope).toBe(scope);
      expect(accountSession().summary().status).toBe('active');
      expect(issuer.state.refreshCalls).toBe(0);
      const calls = spy.mock.calls.length;
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'sync_backoff',
      });
      expect(spy.mock.calls).toHaveLength(calls);
      expect(controller.snapshot().connection.next_retry_at).toBeGreaterThan(
        Date.now(),
      );
      spy.mockRestore();
      controller.start();
      await vi.waitFor(
        () => expect(controller.snapshot().connection.status).toBe('ready'),
        { timeout: 5000 },
      );
      expect(
        (await db.document(actor.user_id, created.selected_id!)).notes,
      ).toBe('Queued notes survive a key-service outage.');
      expect(controller.snapshot().connection.unsent_count).toBe(0);
      expect(issuer.state.refreshCalls).toBe(0);
      expect(accountSession().summary().status).toBe('active');
    }, 10_000);
    it('rearms an early synchronization retry without sending a request before its deadline', async () => {
      await connect();
      await activate();
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const requests = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        Response.json(
          {
            code: 'identity_provider_unavailable',
            message: 'Synthetic early-wake outage.',
            retryable: true,
            request_id: randomUUID(),
          },
          { status: 503 },
        ),
      );
      await expect(controller.synchronize()).rejects.toMatchObject({
        code: 'identity_provider_unavailable',
      });
      expect(controller.snapshot().connection.next_retry_at).toBe(now + 1500);
      expect(requests).toHaveBeenCalledTimes(1);
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const wake = () => {
        const call = timers.mock.calls.at(-1);
        const result = timers.mock.results.at(-1);
        if (!call || result?.type !== 'return')
          throw new Error('Expected a pending synchronization retry.');
        clearTimeout(result.value);
        call[0]();
      };
      controller.start();
      expect(timers.mock.calls[0]?.[1]).toBe(1500);
      clock.mockReturnValue(now + 1499);
      wake();
      await Promise.resolve();
      expect(timers).toHaveBeenCalledTimes(2);
      expect(timers.mock.calls[1]?.[1]).toBe(1);
      expect(requests).toHaveBeenCalledTimes(1);
      expect(controller.snapshot().connection.status).toBe('attention');
      clock.mockReturnValue(now + 1500);
      wake();
      clock.mockRestore();
      await vi.waitFor(
        () => expect(controller.snapshot().connection.status).toBe('ready'),
        { timeout: 5000 },
      );
      expect(requests.mock.calls.length).toBeGreaterThan(1);
      expect(issuer.state.refreshCalls).toBe(0);
    });
    it('does not replace a cached account with a different browser identity without disconnecting first', async () => {
      await seed();
      await connect();
      await activate();
      await controller.synchronize();
      const previous = controller.profile;
      issuer.state.subject = randomUUID();
      await db.provision(issuer.configuration.issuer, issuer.state.subject);
      await expect(connect()).rejects.toMatchObject({
        code: 'account_mismatch',
      });
      expect(controller.profile).toBe(previous);
      expect(controller.snapshot().connection).toMatchObject({
        user_id: actor.user_id,
        status: 'reauth_required',
      });
      expect(local.list(previous)).toHaveLength(1);
      expect(accountSession().summary().status).toBe('signed_out');
    });
    it('cancels a stalled system-browser opener and never resurrects a session', async () => {
      controller.dispose();
      let began!: () => void;
      const opened = new Promise<void>((resolve) => {
        began = resolve;
      });
      controller = open(async () => {
        began();
        await new Promise<void>(() => {});
      });
      const pending = connect();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'authentication_cancelled',
      });
      await opened;
      await controller.execute({ operation: 'cancelConnect' });
      await rejection;
      expect(controller.snapshot().connection.status).toBe('offline');
      expect(accountSession().summary().status).toBe('signed_out');
    });
    it.each(['sync', 'activate', 'connect'] as const)(
      'blocks revoked content even when cache removal fails during %s',
      async (operation) => {
        await connect();
        await activate();
        await create('Forbidden unsent workspace text.');
        const profile = controller.profile;
        const previousScope = controller.scope;
        await db.pool.query(
          'UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',
          [actor.user_id, actor.workspace_id],
        );
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const purge = vi.spyOn(local, 'purgeProfile').mockImplementation(() => {
          throw new LocalError(
            'synthetic_storage_failure',
            'Synthetic cache removal failure.',
          );
        });
        await expect(
          operation === 'sync'
            ? controller.synchronize()
            : operation === 'activate'
              ? activate()
              : connect(),
        ).rejects.toMatchObject({ code: 'synthetic_storage_failure' });
        expect(controller.scope).toBeGreaterThan(previousScope);
        expect(controller.snapshot().documents).toHaveLength(0);
        expect(controller.snapshot().connection.error?.code).toBe(
          'revoked_cache_removal_failed',
        );
        expect(events.some((event) => event.kind === 'revoked')).toBe(true);
        expect(local.list(profile)).toHaveLength(1);
        purge.mockRestore();
        const result = await controller.execute({
          operation: 'disconnect',
          scope: controller.scope,
          preserve_unsent: true,
        });
        expect(result.documents).toHaveLength(0);
        expect(local.list(profile)).toHaveLength(0);
        log.mockRestore();
      },
    );
    it('does not discard device-only editor scope when a background account is deactivated', async () => {
      await create('Independent device-only text.');
      await connect();
      const scope = controller.scope;
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        actor.user_id,
      ]);
      await expect(connect()).rejects.toMatchObject({
        code: 'identity_not_provisioned',
      });
      expect(controller.scope).toBe(scope);
      expect(events.at(-1)?.kind).toBe('status');
      expect(richTextToPlainText(controller.snapshot().selected!.content)).toBe(
        'Independent device-only text.',
      );
    });
    it('bounds every renderer state to one full draft and fifty summaries while preserving editor selection during searches', async () => {
      const text = 'Synthetic bounded performance note. '.repeat(1000);
      const drafts = Array.from({ length: 100 }, (_, index) =>
        local.create('offline', {
          ...fields(text),
          title: `Meeting-index-${index}-unique`,
        }),
      );
      await controller.execute({
        operation: 'select',
        scope: controller.scope,
        id: drafts[0]!.id,
      });
      const first = controller.snapshot();
      expect(first.documents).toHaveLength(50);
      expect(first.has_more).toBe(true);
      expect(first.selected?.id).toBe(drafts[0]!.id);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(90_000);
      expect(desktopStateSchema.parse(first)).toEqual(first);
      const second = await controller.execute({
        operation: 'search',
        scope: controller.scope,
        query: '',
        offset: 50,
      });
      expect(second.documents).toHaveLength(50);
      expect(second.has_more).toBe(false);
      expect(second.selected?.id).toBe(drafts[0]!.id);
      const searched = await controller.execute({
        operation: 'search',
        scope: controller.scope,
        query: 'index-99-unique',
        offset: 0,
      });
      expect(searched.documents.map((draft) => draft.id)).toEqual([
        drafts[99]!.id,
      ]);
      expect(searched.selected?.id).toBe(drafts[0]!.id);
      const saved = await controller.execute({
        operation: 'save',
        scope: controller.scope,
        id: drafts[0]!.id,
        local_revision: 1,
        value: fields('Saved while excluded from the search results.'),
      });
      expect(saved.selected?.local_revision).toBe(2);
      expect(saved.documents.map((draft) => draft.id)).toEqual([
        drafts[99]!.id,
      ]);
    });
  },
);
