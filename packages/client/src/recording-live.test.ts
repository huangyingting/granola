import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LivePcmFrame, Track } from '@windows-ai-notes/contracts';
import { documentSchema } from '@windows-ai-notes/contracts/server';
import { desktopCommandSchema } from '@windows-ai-notes/contracts/desktop';
import { livePreviewSchema } from '@windows-ai-notes/contracts/recording';
import type { LiveRecognitionEvent } from '@windows-ai-notes/contracts/realtime';
import { LocalStore } from '@windows-ai-notes/local';
import { ApiClient, ClientError } from './http.js';
import { AudioHostClient } from './audio.js';
import { RecordingController } from './recording.js';
import type { LiveConnection, LiveConnectionOptions } from './live.js';
import { DesktopDelivery } from './delivery.js';

class Speech implements LiveConnection {
  readonly ready: LiveConnection['ready'];
  readonly completion: LiveConnection['completion'];
  readonly closed: Promise<void>;
  private resolve!: (value: Awaited<LiveConnection['completion']>) => void;
  private reject!: (error: Error) => void;
  private close!: () => void;
  private stopped = false;
  samples = 0;
  last: LivePcmFrame | undefined;
  constructor(readonly options: LiveConnectionOptions) {
    this.ready = {
      schema_version: 1,
      event_type: 'live.ready',
      source: options.source,
      provider_epoch: randomUUID(),
      canonical: false,
      continuity: 'unverified',
      max_media_ms: 60_000,
      max_unfinalized_ms: 5000,
    };
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.completion.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.close = resolve;
    });
    options.signal.addEventListener(
      'abort',
      () => {
        void this.cancel();
      },
      { once: true },
    );
    options.onEvent(this.ready);
  }
  get unfinalizedSamples() {
    return this.samples % 1600;
  }
  async write(frames: readonly LivePcmFrame[]) {
    this.options.authorize();
    this.samples += frames.length * 800;
    this.last = frames.at(-1)!;
    const value = {
      schema_version: 1 as const,
      event_type: 'live.accepted' as const,
      source: this.options.source,
      provider_epoch: this.ready.provider_epoch,
      acknowledgment: 'authorization_only' as const,
      next_sequence: this.last.sequence + 1,
      next_sample: this.last.sample_start + 800,
      accepted_samples: this.samples,
      finalized_samples: this.samples - this.unfinalizedSamples,
      gap: null,
    };
    this.options.onEvent(value);
    return value;
  }
  result(change: Partial<LiveRecognitionEvent> = {}) {
    if (!this.last) throw new Error('No framed native media.');
    try {
      this.options.onEvent({
        schema_version: 1,
        event_type: 'transcript.partial',
        provider_epoch: this.ready.provider_epoch,
        source: this.options.source,
        segment_id: randomUUID(),
        version: 1,
        sample_start: this.last.sample_start,
        sample_end: this.last.sample_start + 800,
        text: 'Ephemeral synthetic speech.',
        discard_reason: null,
        provider_result_id: 'synthetic-result',
        ...change,
      });
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error('Synthetic consumer failure.'),
      );
    }
  }
  fail(
    error: Error = new ClientError(
      'live_connection_lost',
      'Connection lost.',
      0,
      true,
    ),
  ) {
    if (this.stopped) return;
    this.stopped = true;
    this.reject(error);
    this.close();
  }
  async finish(): ReturnType<LiveConnection['finish']> {
    const value = {
      schema_version: 1 as const,
      event_type: 'live.closed' as const,
      reason: 'finished' as const,
      usage_status: 'settled' as const,
      canonical: false as const,
      continuity: 'unverified' as const,
    };
    this.stopped = true;
    this.options.onEvent(value);
    this.resolve(value);
    this.close();
    return value;
  }
  async cancel() {
    this.fail(new ClientError('live_cancelled', 'Cancelled.'));
    await this.closed;
  }
}

describe('consented desktop live coordination with a real framed capture helper', () => {
  let local: LocalStore;
  let directory: string;
  let key: Buffer;
  const profile = 'synthetic-live-cloud';
  const hosts: AudioHostClient[] = [];
  const controllers: RecordingController[] = [];
  const deliveries: DesktopDelivery[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'notes-live-desktop-'));
    key = randomBytes(32);
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const controller of controllers.splice(0))
      await controller.stop(() => {});
    for (const host of hosts.splice(0)) await host.close();
    for (const delivery of deliveries.splice(0)) delivery.close();
    local.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  async function setup(
    mode = 'capture-live',
    count = 1,
    delivery?: DesktopDelivery,
  ) {
    const draft = local.create(profile);
    const sessions: Speech[] = [];
    const seen: string[] = [];
    const api = new ApiClient('https://notes.example.test', async () => ({}));
    vi.spyOn(api, 'document').mockResolvedValue(
      documentSchema.parse({
        id: draft.id,
        owner_id: randomUUID(),
        workspace_id: randomUUID(),
        title: draft.title,
        notes: '',
        content: draft.content,
        tags: [],
        revision: 1,
        transcript_revision: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );
    const open = vi
      .spyOn(api, 'openLiveSource')
      .mockImplementation(async (_id, options) => {
        const value = new Speech(options);
        sessions.push(value);
        return value;
      });
    const create = vi.fn(
      (observe: ConstructorParameters<typeof AudioHostClient>[2]) => {
        const host = new AudioHostClient(
          process.execPath,
          [
            fileURLToPath(
              new URL('../fixtures/audio-host.mjs', import.meta.url),
            ),
            mode,
          ],
          (event) => {
            seen.push(event.event_type);
            observe(event);
          },
        );
        hosts.push(host);
        return host;
      },
    );
    const changed = vi.fn();
    const controller = new RecordingController(
      local,
      create,
      changed,
      async () => {},
      delivery,
    );
    controllers.push(controller);
    const tracks: Track[] = Array.from({ length: count }, (_, index) => ({
      track_id: randomUUID(),
      kind: index === 0 ? 'microphone' : 'loopback',
      capture_scope: 'endpoint',
      device_selection_policy: 'explicit',
      device_id: `synthetic-${index}`,
    }));
    await controller.start(profile, draft.id, tracks, () => {});
    const id = controller.snapshot(profile, draft.id).active!.id;
    const context = { profile, scope: 1, api, authorize: () => {} };
    controller.resumeUploads(context);
    const options = {
      locale: 'en-US' as const,
      confirmed: true as const,
      context,
      authorize: () => {},
      prepare: async () => {},
    };
    const state = () => controller.snapshot(profile, draft.id);
    const start = () => controller.startLive(profile, draft.id, id, options);
    const spoken = async () => {
      await vi.waitFor(() => expect(sessions[0]?.samples).toBeGreaterThan(0), {
        timeout: 3000,
      });
      return sessions[0]!;
    };
    return {
      controller,
      draft,
      id,
      sessions,
      open,
      options,
      state,
      start,
      spoken,
      create,
      changed,
      seen,
    };
  }
  it.each(['capture-live', 'capture-live-legacy'])(
    'observes first caption bounds with %s without changing saved capture',
    async (mode) => {
      const records: Record<string, unknown>[] = [];
      const metrics = new DesktopDelivery(
        new Writable({
          write(chunk, _encoding, done) {
            records.push(JSON.parse(String(chunk)));
            done();
          },
        }),
      );
      deliveries.push(metrics);
      const f = await setup(mode, 1, metrics),
        request = vi.spyOn(hosts.at(-1)!, 'request');
      await f.start();
      const speech = await f.spoken();
      speech.result();
      const segment = f.state().live!.segments[0]!,
        marker = segment.presentation!;
      expect(marker).toMatchObject({
        kind: 'live_caption',
        operation_id: speech.ready.provider_epoch,
      });
      expect(metrics.present(1, f.draft.id, marker.token)).toBe(true);
      expect(
        records.find((value) => value.outcome === 'acknowledged'),
      ).toMatchObject({
        capture_clock:
          mode === 'capture-live'
            ? 'native_interval'
            : 'native_clock_unavailable',
        presentation_ack_after_receive_ms: expect.any(Number),
        ...(mode === 'capture-live'
          ? { capture_to_ack_lower_ms: expect.any(Number) }
          : { capture_to_ack_lower_ms: null }),
      });
      const calls = request.mock.calls.map(([value]) => value.command);
      expect(
        calls.filter((value) => value === 'read_live_audio_timed'),
      ).toHaveLength(
        mode === 'capture-live'
          ? calls.filter((value) => value.startsWith('read_live_audio')).length
          : 1,
      );
      if (mode === 'capture-live-legacy')
        expect(calls).toContain('read_live_audio');
      const text = JSON.stringify(records);
      expect(text).not.toContain('Ephemeral synthetic speech.');
      expect(text).not.toContain(f.draft.id);
      await f.controller.stopLive(profile, f.draft.id, f.id, () => {});
      expect(f.state().active?.state).toBe('recording');
      expect(f.state().error).toBeNull();
    },
  );
  it('never retries a different timed-read failure as an ordinary dequeue', async () => {
    const metrics = new DesktopDelivery(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    );
    deliveries.push(metrics);
    const f = await setup('capture-live-timed-error', 1, metrics),
      request = vi.spyOn(hosts.at(-1)!, 'request');
    await f.start();
    await vi.waitFor(() => expect(f.state().live?.phase).toBe('attention'));
    expect(request.mock.calls.map(([value]) => value.command)).not.toContain(
      'read_live_audio',
    );
    expect(f.state().active?.state).toBe('recording');
  });
  it('validates separate consent, current scope and matching recording without changing healthy capture', async () => {
    const f = await setup();
    const invalid = { ...f.options, confirmed: false };
    expect(() => {
      // @ts-expect-error Runtime consent cannot be false.
      f.controller.startLive(profile, f.draft.id, f.id, invalid);
    }).toThrow('separate cloud consent');
    expect(() =>
      f.controller.startLive(profile, f.draft.id, f.id, {
        ...f.options,
        context: null,
      }),
    ).toThrow('cloud workspace');
    expect(() =>
      f.controller.startLive(profile, f.draft.id, f.id, {
        ...f.options,
        authorize: () => {
          throw new ClientError('workspace_changed', 'Stale scope.');
        },
      }),
    ).toThrow('Stale scope');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.state().active?.state).toBe('recording');
    expect(f.state().error).toBeNull();
    expect(
      desktopCommandSchema.safeParse({
        operation: 'startLivePreview',
        scope: 1,
        id: f.draft.id,
        recording_id: f.id,
        locale: 'en-US',
        confirmed: true,
        headers: { Authorization: 'not-allowed' },
      }).success,
    ).toBe(false);
  });
  it('requests the 2500 ms native budget and keeps bounded revisions ephemeral and owner-scoped', async () => {
    const f = await setup('capture-live', 2);
    const before = local.get(profile, f.draft.id);
    const request = vi.spyOn(hosts[0]!, 'request');
    f.start();
    const speech = await f.spoken();
    expect(request).toHaveBeenCalledWith({
      command: 'start_live_preview',
      recording_id: f.id,
      max_buffered_ms: 2500,
    });
    const segment = randomUUID();
    speech.result({ segment_id: segment });
    speech.result({
      segment_id: segment,
      version: 2,
      event_type: 'transcript.final',
      text: 'Corrected synthetic speech.',
    });
    expect(f.state().live?.segments).toHaveLength(1);
    expect(f.state().live?.segments[0]?.event.text).toBe(
      'Corrected synthetic speech.',
    );
    speech.result({
      segment_id: segment,
      version: 3,
      event_type: 'transcript.discarded',
      text: '',
      discard_reason: 'no_match',
    });
    expect(f.state().live?.segments).toEqual([]);
    expect(local.get(profile, f.draft.id)).toEqual(before);
    expect(local.recordingUpload(profile, f.draft.id, f.id)).toBeNull();
    expect(f.controller.snapshot('unrelated', null).live).toBeNull();
    expect(
      f.controller.snapshot(profile, local.create(profile).id).live,
    ).toBeNull();
    expect(f.seen).not.toContain('recording.live_audio');
    expect(JSON.stringify(f.state())).not.toMatch(/data_base64|Authorization/);
    expect(livePreviewSchema.safeParse(f.state().live).success).toBe(true);
  });
  it('isolates cloud failure, preserves encrypted capture controls and never automatically replays a failed attempt', async () => {
    const f = await setup();
    f.start();
    const speech = await f.spoken();
    speech.result();
    speech.fail();
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(f.state().live?.phase).toBe('attention');
    expect(f.state().live?.usage_status).toBe('check_account');
    expect(f.state().active?.state).toBe('recording');
    expect(f.state().error).toBeNull();
    await delay(100);
    expect(f.open).toHaveBeenCalledTimes(1);
    f.start();
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(2));
    expect(f.state().live?.boundaries.at(-1)?.reason).toBe(
      'uncertain_previous_tail',
    );
    await f.controller.control(profile, f.draft.id, f.id, 'pause', () => {});
    await f.controller.control(profile, f.draft.id, f.id, 'resume', () => {});
    await f.controller.stop(() => {});
    expect(f.state().recordings[0]?.state).toBe('sealed');
    expect(f.state().recordings[0]?.tracks[0]?.saved_samples).toBe(64_000);
  });
  it('lets pause and cancellation overtake slow cloud preparation without reopening on resume', async () => {
    const f = await setup();
    let release!: () => void;
    f.options.prepare = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    f.start();
    await f.controller.control(profile, f.draft.id, f.id, 'pause', () => {});
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(f.open).not.toHaveBeenCalled();
    release();
    await f.controller.control(profile, f.draft.id, f.id, 'resume', () => {});
    expect(f.open).not.toHaveBeenCalled();
    expect(f.state().active?.state).toBe('recording');
  });
  it('clears ephemeral text immediately when cloud context is lost without stopping local capture', async () => {
    const f = await setup();
    f.start();
    const speech = await f.spoken();
    speech.result();
    expect(f.state().live?.segments.length).toBe(1);
    f.controller.resumeUploads(null);
    expect(f.state().live?.segments).toEqual([]);
    expect(f.state().live?.boundaries).toEqual([]);
    speech.result();
    expect(f.state().live?.segments).toEqual([]);
    expect(f.state().active?.state).toBe('recording');
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    const changed = f.changed.mock.calls.length;
    f.controller.resumeUploads(null);
    expect(f.changed).toHaveBeenCalledTimes(changed);
  });
  it('reports native preview overrun separately from durable recording failure', async () => {
    const f = await setup('capture-live-overrun');
    f.start();
    await vi.waitFor(() => expect(f.state().live?.phase).toBe('attention'));
    expect(f.state().live?.error?.code).toBe('live_overrun');
    expect(f.state().active?.state).toBe('recording');
    expect(f.state().error).toBeNull();
  });
  it('coalesces interleaved startup gaps and cancels late cloud openings without forwarding their discarded media', async () => {
    const f = await setup('capture-live', 2);
    const open = f.open.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.open.mockImplementation(async (...args) => {
      const connection = await open(...args);
      await gate;
      return connection;
    });
    f.start();
    await vi.waitFor(() => {
      expect(f.state().live?.sources).toHaveLength(2);
      expect(
        f
          .state()
          .live?.sources.every((source) => source.skipped_samples >= 2400),
      ).toBe(true);
    });
    expect(f.state().live?.gaps).toHaveLength(2);
    expect(f.state().live?.omitted).toBe(false);
    expect(f.sessions.every((session) => session.samples === 0)).toBe(true);
    f.controller.stopLive(profile, f.draft.id, f.id, () => {});
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    release();
    await Promise.all(f.sessions.map((session) => session.closed));
    expect(f.sessions.every((session) => session.samples === 0)).toBe(true);
    expect(f.state().active?.state).toBe('recording');
  });
  it('cleans up only the returned preview when native startup completes after pause', async () => {
    const f = await setup();
    const request = hosts[0]!.request.bind(hosts[0]!);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedNative = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls = vi
      .spyOn(hosts[0]!, 'request')
      .mockImplementation(async (command) => {
        const event = await request(command);
        if (command.command === 'start_live_preview') {
          started();
          await gate;
        }
        return event;
      });
    f.start();
    await startedNative;
    await f.controller.control(profile, f.draft.id, f.id, 'pause', () => {});
    expect(f.state().active?.state).toBe('paused');
    expect(f.open).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(
      calls.mock.calls.some(
        ([command]) =>
          command.command === 'stop_live_preview' &&
          command.recording_id === f.id,
      ),
    ).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.state().error).toBeNull();
  });
  it('clears revoked captions and publishes a privacy clear even after the failed attempt is already aborted', async () => {
    const f = await setup();
    f.start();
    const speech = await f.spoken();
    speech.result();
    speech.fail(new ClientError('live_lease_lost', 'Live access revoked.'));
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(f.state().live?.segments).toEqual([]);
    expect(f.state().live?.sources).toEqual([]);
    expect(f.state().live?.error?.code).toBe('live_lease_lost');
    const changed = f.changed.mock.calls.length;
    f.controller.resumeUploads(null);
    expect(f.state().live?.error).toBeNull();
    expect(f.changed).toHaveBeenCalledTimes(changed + 1);
    expect(f.state().active?.state).toBe('recording');
  });
  it('bounds retained text bytes, retains omission disclosure and rejects revision rollback', async () => {
    const f = await setup();
    f.start();
    const speech = await f.spoken();
    for (let i = 0; i < 20; i++) speech.result({ text: 'x'.repeat(4000) });
    expect(
      Buffer.byteLength(JSON.stringify(f.state().live?.segments)),
    ).toBeLessThanOrEqual(16_384);
    expect(f.state().live?.omitted).toBe(true);
    const segment = randomUUID();
    speech.result({ segment_id: segment, version: 2 });
    speech.result({ segment_id: segment, version: 1 });
    await vi.waitFor(() => expect(f.state().live?.phase).toBe('attention'));
    expect(f.state().active?.state).toBe('recording');
  });
  it('rotates only known finished attempts with fresh native identities and explicit unverified boundaries', async () => {
    const metrics = new DesktopDelivery(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    );
    deliveries.push(metrics);
    const f = await setup('capture-live', 1, metrics);
    f.start();
    const first = await f.spoken();
    first.result({ event_type: 'transcript.final' });
    const token = f.state().live!.segments[0]!.presentation!.token;
    const now = performance.now.bind(performance);
    let offset = 60_001;
    vi.spyOn(performance, 'now').mockImplementation(() => now() + offset);
    await vi.waitFor(() => expect(f.state().live?.phase).toBe('rotating'));
    offset = 0;
    await vi.waitFor(() => expect(f.sessions).toHaveLength(2), {
      timeout: 3000,
    });
    expect(f.sessions[1]?.ready.source.preview_id).not.toBe(
      first.ready.source.preview_id,
    );
    expect(f.state().live?.attempt).toBe(2);
    expect(f.state().live?.boundaries.at(-1)?.reason).toBe('normal_rotation');
    expect(f.state().live?.continuity).toBe('unverified');
    expect(f.state().live?.segments[0]?.attempt).toBe(1);
    expect(metrics.markers(1, f.draft.id)).toContainEqual(
      expect.objectContaining({ token }),
    );
    f.controller.stopLive(profile, f.draft.id, f.id, () => {});
    expect(metrics.present(1, f.draft.id, token)).toBe(false);
    expect(metrics.markers(1, f.draft.id)).toEqual([]);
  });
  it('stops the whole preview after partial multi-source startup failure without closing saved capture or retrying', async () => {
    const f = await setup('capture-live', 2);
    const open = f.open.getMockImplementation()!;
    f.open.mockImplementation(async (...args) => {
      if (
        args[1].source.track_id === f.state().active!.tracks[1]!.spec.track_id
      )
        throw new ClientError(
          'live_provider_unavailable',
          'Synthetic second source failure.',
        );
      return open(...args);
    });
    f.start();
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(f.state().live?.phase).toBe('attention');
    expect(f.state().live?.usage_status).toBe('check_account');
    await Promise.all(f.sessions.map((session) => session.closed));
    await delay(100);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.state().active?.state).toBe('recording');
    expect(f.state().error).toBeNull();
  });
  it('stops rather than rotating after a finish with unconfirmed usage', async () => {
    const f = await setup();
    f.start();
    const speech = await f.spoken();
    const finish = speech.finish.bind(speech);
    vi.spyOn(speech, 'finish').mockImplementation(async () => ({
      ...(await finish()),
      usage_status: 'check_account',
    }));
    const now = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 60_001);
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(f.state().live?.error?.code).toBe('live_usage_unconfirmed');
    expect(f.state().live?.usage_status).toBe('check_account');
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.state().active?.state).toBe('recording');
  });
  it('caps per-attempt revision identities independently of the recent-caption window', async () => {
    const f = await setup();
    f.start();
    const speech = await f.spoken();
    for (let index = 0; index < 257; index++) speech.result();
    await vi.waitFor(() => expect(f.state().live?.running).toBe(false));
    expect(f.state().live?.error?.code).toBe('live_revision_limit');
    expect(f.state().live?.segments.length).toBeLessThanOrEqual(12);
    expect(f.state().active?.state).toBe('recording');
  });
});
