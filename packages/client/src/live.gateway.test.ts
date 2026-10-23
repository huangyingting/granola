import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
} from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { createServer } from '@windows-ai-notes/api/server';
import {
  liveAudioBatchSchema,
  type LivePcmFrame,
} from '@windows-ai-notes/contracts';
import {
  SEGMENTED_LIVE_PROFILE,
  type LiveRecognitionEvent,
  type LiveServerMessage,
  type LiveSource,
} from '@windows-ai-notes/contracts/realtime';
import { ApiClient, ClientError } from './http.js';
import { AudioHostClient } from './audio.js';
import type { LiveConnection } from './live.js';
import { LocalStore } from '@windows-ai-notes/local';
import { RecordingController } from './recording.js';

type Provider = NonNullable<Parameters<typeof createServer>[3]>;
type Session = Awaited<ReturnType<Provider['open']>>;
type Completion = Awaited<ReturnType<Session['finish']>>;
const url = process.env.TEST_DATABASE_URL;
const source = (): LiveSource => ({
  recording_id: randomUUID(),
  preview_id: randomUUID(),
  track_id: randomUUID(),
  capture_epoch: randomUUID(),
});
function frames(selected: LiveSource, sequence = 0): LivePcmFrame[] {
  return Array.from({ length: 10 }, (_, index) => ({
    ...selected,
    format_version: 1,
    sequence: sequence + index,
    sample_start: 4000 + (sequence + index) * 800,
    sample_count: 800,
    sample_rate: 16_000,
    channels: 1,
    bits_per_sample: 16,
    clock_start_ms: (sequence + index) * 50,
    clock_end_ms: (sequence + index + 1) * 50,
    data_base64: Buffer.alloc(1600, 0x2b).toString('base64'),
  }));
}
describe.skipIf(!url)(
  'Main client through the authenticated durable live gateway',
  () => {
    const schema = `notes_live_client_${randomUUID().replaceAll('-', '')}`;
    let admin: Database;
    let db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    let base: string;
    const clients: LiveConnection[] = [];
    const received: LivePcmFrame[] = [];
    let late: (() => void) | undefined;
    let lateReceipts = false;
    let opened = 0;
    let segmented = false;
    const provider: Provider = {
      provider: 'fixture',
      configurationVersion: 'live-client-fixture-v1',
      get profiles() {
        return segmented ? [SEGMENTED_LIVE_PROFILE] : [];
      },
      async open(
        selected,
        _locale,
        signal,
        emit,
        progress,
        _identity,
        profile,
      ) {
        opened++;
        const epoch = randomUUID();
        const media: LivePcmFrame[] = [];
        let resolve!: (value: Completion) => void;
        let reject!: (error: Error) => void;
        let finalized = 0;
        const completion = new Promise<Completion>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        completion.catch(() => undefined);
        const settle = () =>
          resolve({
            provider_epoch: epoch,
            samples: media.length * 800,
            usage: {
              audio_ms: media.length * 50,
              input_tokens: 0,
              output_tokens: 0,
            },
          });
        const cancel = async () => {
          if (lateReceipts) late = settle;
          else
            reject(new ClientError('fixture_cancelled', 'Fixture cancelled.'));
        };
        signal.addEventListener(
          'abort',
          () => {
            void cancel();
          },
          { once: true },
        );
        return {
          providerEpoch: epoch,
          completion,
          get finalizedSamples() {
            return finalized;
          },
          write(frame) {
            media.push(frame);
            received.push(frame);
            const batchSize = profile ? 400 : 10;
            if (media.length % batchSize === 0) {
              finalized = media.length * 800;
              progress?.({
                provider_epoch: epoch,
                finalized_samples: finalized,
              });
              const event: LiveRecognitionEvent = {
                schema_version: 1,
                source: selected,
                provider_epoch: epoch,
                event_type: 'transcript.final',
                segment_id: randomUUID(),
                version: 1,
                sample_start: media.at(-batchSize)!.sample_start,
                sample_end: frame.sample_start + 800,
                text: 'Synthetic meeting evidence.',
                discard_reason: null,
                provider_result_id: `synthetic-${media.length}`,
              };
              emit(event);
            }
          },
          finish() {
            settle();
            return completion;
          },
          cancel,
        };
      },
    };
    beforeAll(async () => {
      admin = new Database(url!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(url!);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(scoped.href);
      await db.migrate();
      app = await createServer(
        db,
        { mode: 'development', host: '127.0.0.1' },
        null,
        provider,
      );
      base = await app.listen({ host: '127.0.0.1', port: 0 });
    });
    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.cancel()));
      await vi.waitFor(async () =>
        expect(
          (
            await db.pool.query(
              'SELECT id FROM live_leases WHERE closed_at IS NULL',
            )
          ).rows,
        ).toEqual([]),
      );
      late?.();
      late = undefined;
      lateReceipts = false;
      segmented = false;
      received.length = 0;
    });
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function actor() {
      const subject = randomUUID();
      const user = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const doc = await db.createDocument(
        user.user_id,
        {
          workspace_id: user.workspace_id,
          title: 'Synthetic live client',
          notes: 'Keep manual notes intact.',
        },
        randomUUID(),
      );
      const api = new ApiClient(
        base,
        async () => ({ 'x-dev-subject': subject }),
        { allowLoopback: true },
      );
      return { user, doc, api };
    }
    async function open(
      api: ApiClient,
      doc: string,
      selected: LiveSource,
      events: LiveServerMessage[],
      signal = new AbortController().signal,
    ) {
      const connection = await api.openLiveSource(doc, {
        source: selected,
        locale: 'en-US',
        consent: true,
        signal,
        authorize: () => {},
        onEvent: (event) => {
          events.push(event);
          return undefined;
        },
      });
      clients.push(connection);
      return connection;
    }
    it.each([false, true])(
      'streams beyond one window using final-only credit, then settles known usage without uploading or editing notes (segmented=%s)',
      async (profile) => {
        segmented = profile;
        const { user, doc, api } = await actor();
        const selected = source();
        const events: LiveServerMessage[] = [];
        const connection = await open(api, doc.id, selected, events);
        expect(connection.ready).toMatchObject(
          profile
            ? { profile: SEGMENTED_LIVE_PROFILE, max_unfinalized_ms: 25_000 }
            : { max_unfinalized_ms: 5000 },
        );
        expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
          '60000',
        );
        const batches = profile ? 52 : 8;
        for (let index = 0; index < batches; index++) {
          await expect(
            connection.write(frames(selected, index * 10)),
          ).resolves.toMatchObject({
            acknowledgment: 'authorization_only',
            accepted_samples: (index + 1) * 8000,
            source: selected,
            provider_epoch: connection.ready.provider_epoch,
          });
          if (!profile || index === 39)
            await vi.waitFor(() =>
              expect(
                events.filter(
                  (event) => event.event_type === 'transcript.final',
                ),
              ).toHaveLength(profile ? 1 : index + 1),
            );
        }
        await expect(connection.finish()).resolves.toMatchObject({
          reason: 'finished',
          usage_status: 'settled',
          canonical: false,
        });
        await connection.closed;
        expect(received).toEqual(
          Array.from({ length: batches }, (_, index) =>
            frames(selected, index * 10),
          ).flat(),
        );
        expect(
          events.filter((event) => event.event_type === 'transcript.final'),
        ).toHaveLength(profile ? 1 : 8);
        expect(await db.usage.snapshot(user.user_id)).toMatchObject({
          settled: { audio_ms: profile ? '26000' : '4000' },
          uncertain_requests: '0',
          settled_requests: '1',
        });
        expect(await api.document(doc.id)).toMatchObject({
          notes: 'Keep manual notes intact.',
          transcript_revision: 0,
        });
        expect((await db.pool.query('SELECT id FROM recordings')).rows).toEqual(
          [],
        );
      },
    );
    it("does not reach the provider for another account's document", async () => {
      const owner = await actor();
      const other = await actor();
      const count = opened;
      await expect(
        open(other.api, owner.doc.id, source(), []),
      ).rejects.toMatchObject({ status: 404 });
      expect(opened).toBe(count);
      expect(
        (await db.usage.snapshot(other.user.user_id)).uncertain_requests,
      ).toBe('0');
    });
    it('keeps framed native capture controllable after gateway revocation and retains unknown usage', async () => {
      const { user, doc, api } = await actor();
      const notifications: string[] = [];
      const host = new AudioHostClient(
        process.execPath,
        [
          fileURLToPath(new URL('../fixtures/audio-host.mjs', import.meta.url)),
          'capture',
        ],
        (event) => notifications.push(event.event_type),
      );
      const recording = randomUUID();
      const track = randomUUID();
      try {
        await host.request({
          command: 'start_recording',
          recording_id: recording,
          tracks: [
            {
              track_id: track,
              kind: 'microphone',
              capture_scope: 'endpoint',
              device_selection_policy: 'explicit',
              device_id: 'synthetic',
            },
          ],
        });
        const preview = liveAudioBatchSchema.parse(
          (
            await host.request({
              command: 'start_live_preview',
              recording_id: recording,
              max_buffered_ms: 2500,
            })
          ).payload,
        );
        const selected: LiveSource = {
          recording_id: recording,
          track_id: track,
          preview_id: preview.preview_id,
          capture_epoch: preview.capture_epoch,
        };
        const connection = await open(api, doc.id, selected, []);
        const read = async () =>
          liveAudioBatchSchema.parse(
            (
              await host.request({
                command: 'read_live_audio',
                recording_id: recording,
                preview_id: preview.preview_id,
              })
            ).payload,
          ).frames;
        for (let i = 0; i < 10; i++) await connection.write(await read());
        await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
          user.user_id,
        ]);
        await expect(connection.write(await read())).rejects.toBeInstanceOf(
          ClientError,
        );
        await expect(connection.completion).rejects.toBeInstanceOf(ClientError);
        await connection.closed;
        expect(received).toHaveLength(10);
        expect(notifications).not.toContain('recording.live_audio');
        await host.request({
          command: 'stop_live_preview',
          recording_id: recording,
          preview_id: preview.preview_id,
        });
        expect(
          (
            await host.request({
              command: 'pause_recording',
              recording_id: recording,
            })
          ).event_type,
        ).toBe('recording.paused');
        expect(
          (
            await host.request({
              command: 'resume_recording',
              recording_id: recording,
            })
          ).event_type,
        ).toBe('recording.resumed');
        expect(
          (
            await host.request({
              command: 'stop_recording',
              recording_id: recording,
            })
          ).payload,
        ).toMatchObject({
          state: 'sealed',
          tracks: [{ track_id: track, saved_samples: 64_000 }],
        });
        await db.pool.query('UPDATE users SET active=true WHERE id=$1', [
          user.user_id,
        ]);
        expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
          '60000',
        );
      } finally {
        await host.close();
      }
    });
    it('connects the consented recording controller through the gateway and clears revoked captions without stopping saved capture', async () => {
      const { user, api } = await actor();
      const directory = mkdtempSync(
        join(tmpdir(), 'notes-live-gateway-desktop-'),
      );
      const key = randomBytes(32);
      const local = new LocalStore(join(directory, 'notes.sqlite'), key);
      const profile = `cloud:${user.user_id}`;
      const draft = local.create(profile);
      const doc = await db.createDocument(
        user.user_id,
        {
          id: draft.id,
          workspace_id: user.workspace_id,
          title: draft.title,
          notes: 'Keep manual notes intact.',
        },
        randomUUID(),
      );
      const notifications: string[] = [];
      const capture = new RecordingController(
        local,
        (observe) =>
          new AudioHostClient(
            process.execPath,
            [
              fileURLToPath(
                new URL('../fixtures/audio-host.mjs', import.meta.url),
              ),
              'capture-live',
            ],
            (event) => {
              notifications.push(event.event_type);
              observe(event);
            },
          ),
        () => {},
        async () => {},
      );
      const context = { profile, scope: 1, api, authorize: () => {} };
      const state = () => capture.snapshot(profile, draft.id);
      try {
        await capture.start(
          profile,
          draft.id,
          [
            {
              track_id: randomUUID(),
              kind: 'microphone',
              capture_scope: 'endpoint',
              device_selection_policy: 'explicit',
              device_id: 'synthetic',
            },
          ],
          () => {},
        );
        const recording = state().active!.id;
        capture.resumeUploads(context);
        capture.startLive(profile, draft.id, recording, {
          context,
          locale: 'en-US',
          confirmed: true,
          authorize: () => {},
          prepare: async () => {},
        });
        await vi.waitFor(
          () =>
            expect(state().live?.segments[0]?.event.text).toBe(
              'Synthetic meeting evidence.',
            ),
          { timeout: 3000 },
        );
        expect(local.recordingUpload(profile, draft.id, recording)).toBeNull();
        expect(notifications).not.toContain('recording.live_audio');
        await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
          user.user_id,
        ]);
        await vi.waitFor(() => expect(state().live?.running).toBe(false), {
          timeout: 3000,
        });
        expect(state().live?.phase).toBe('attention');
        expect(['document_not_found', 'live_lease_lost']).toContain(
          state().live?.error?.code,
        );
        expect(state().live?.segments).toEqual([]);
        expect(state().live?.sources).toEqual([]);
        expect(state().active?.state).toBe('recording');
        expect(state().error).toBeNull();
        await capture.control(profile, draft.id, recording, 'pause', () => {});
        await capture.control(profile, draft.id, recording, 'resume', () => {});
        await capture.stop(() => {});
        expect(state().recordings[0]?.tracks[0]?.saved_samples).toBe(64_000);
        await db.pool.query('UPDATE users SET active=true WHERE id=$1', [
          user.user_id,
        ]);
        expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
          '60000',
        );
        expect(await api.document(doc.id)).toMatchObject({
          notes: 'Keep manual notes intact.',
          transcript_revision: 0,
        });
        expect((await db.pool.query('SELECT id FROM recordings')).rows).toEqual(
          [],
        );
      } finally {
        await capture.stop(() => {});
        local.close();
        key.fill(0);
        rmSync(directory, { recursive: true, force: true });
      }
    });
    it('aborts immediately and permits a late known receipt to settle the original reservation', async () => {
      const { user, doc, api } = await actor();
      const controller = new AbortController();
      const selected = source();
      lateReceipts = true;
      const connection = await open(
        api,
        doc.id,
        selected,
        [],
        controller.signal,
      );
      await connection.write(frames(selected));
      controller.abort();
      await expect(connection.completion).rejects.toMatchObject({
        code: 'live_cancelled',
      });
      await connection.closed;
      await vi.waitFor(() => expect(late).toBeTypeOf('function'));
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
      late!();
      late = undefined;
      await vi.waitFor(async () =>
        expect(await db.usage.snapshot(user.user_id)).toMatchObject({
          settled: { audio_ms: '500' },
          settled_requests: '1',
          uncertain_requests: '0',
        }),
      );
    });
  },
);
