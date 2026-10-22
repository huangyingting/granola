import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAzureRealtimeProvider } from '@windows-ai-notes/ai/realtime';
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
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import {
  DEFAULT_AI_LIMITS,
  ServiceError,
} from '@windows-ai-notes/contracts/server';
import {
  liveServerMessageSchema,
  type LiveSource,
  type LiveRecognitionEvent,
  type LiveServerMessage,
} from '@windows-ai-notes/contracts/realtime';
import type {
  RealtimeProvider,
  RealtimeSession,
  RealtimeCompletion,
  RealtimeProgress,
} from '@windows-ai-notes/ai/realtime';
import { createServer } from './server.js';
import { loadLiveProvider } from './live-config.js';

const url = process.env.TEST_DATABASE_URL;
const source = (): LiveSource => ({
  recording_id: randomUUID(),
  preview_id: randomUUID(),
  track_id: randomUUID(),
  capture_epoch: randomUUID(),
});
function frame(
  selected: LiveSource,
  sequence = 0,
  sampleStart = 4000 + sequence * 800,
): LivePcmFrame {
  return {
    ...selected,
    format_version: 1,
    sequence,
    sample_start: sampleStart,
    sample_count: 800,
    sample_rate: 16_000,
    channels: 1,
    bits_per_sample: 16,
    clock_start_ms: sequence * 50,
    clock_end_ms: (sequence + 1) * 50,
    data_base64: Buffer.alloc(1600, 0x2b).toString('base64'),
  };
}
const gates: (() => void)[] = [];
const start = (selected = source(), requestId = randomUUID()) => ({
  schema_version: 1,
  event_type: 'live.start',
  request_id: requestId,
  source: selected,
  locale: 'en-US',
  consent: true,
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.push(release);
  return { promise, release };
}

class SpeechFixture implements RealtimeSession {
  readonly providerEpoch = randomUUID();
  readonly frames: LivePcmFrame[] = [];
  readonly completion: Promise<RealtimeCompletion>;
  private resolve!: (value: RealtimeCompletion) => void;
  private reject!: (error: Error) => void;
  cancelled = false;
  late = false;
  constructor(
    readonly source: LiveSource,
    readonly signal: AbortSignal,
    readonly emit: (value: LiveRecognitionEvent) => undefined,
    readonly progress: ((value: RealtimeProgress) => undefined) | undefined,
  ) {
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.completion.catch(() => undefined);
    signal.addEventListener(
      'abort',
      () => {
        void this.cancel();
      },
      { once: true },
    );
  }
  get finalizedSamples() {
    return Math.floor(this.frames.length / 2) * 1600;
  }
  write(value: LivePcmFrame) {
    if (this.cancelled) throw new Error('Fixture was already cancelled.');
    this.frames.push(value);
  }
  finish() {
    this.complete();
    return this.completion;
  }
  complete(change: Partial<RealtimeCompletion> = {}) {
    this.resolve({
      provider_epoch: this.providerEpoch,
      samples: this.frames.length * 800,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        audio_ms: this.frames.length * 50,
      },
      ...change,
    });
  }
  fail() {
    this.reject(new Error('private-provider-diagnostics-must-not-escape'));
  }
  result(change: Partial<LiveRecognitionEvent> = {}) {
    const first = this.frames[0]!;
    this.emit({
      schema_version: 1,
      source: this.source,
      provider_epoch: this.providerEpoch,
      event_type: 'transcript.final',
      segment_id: randomUUID(),
      version: 1,
      sample_start: first.sample_start,
      sample_end: first.sample_start + 800,
      text: 'Synthetic Orion evidence.',
      discard_reason: null,
      provider_result_id: 'synthetic-result',
      ...change,
    });
  }
  async cancel() {
    this.cancelled = true;
    if (!this.late)
      this.reject(new ServiceError('live_cancelled', 'Cancelled.', 409));
  }
}

class Peer {
  readonly socket: WebSocket;
  readonly messages: LiveServerMessage[] = [];
  readonly closed: Promise<number>;
  private invalid: unknown;
  constructor(base: string, path: string, headers: Record<string, string>) {
    this.socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, {
      headers,
    });
    this.closed = new Promise((resolve) =>
      this.socket.once('close', (code) => resolve(code)),
    );
    this.socket.on('error', () => undefined);
    this.socket.on('message', (data) => {
      const parsed = liveServerMessageSchema.safeParse(
        JSON.parse(data.toString()),
      );
      if (parsed.success) this.messages.push(parsed.data);
      else this.invalid = parsed.error;
    });
  }
  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }
  audio(frames: LivePcmFrame[]) {
    this.send({ schema_version: 1, event_type: 'live.audio', frames });
  }
  async next<T extends LiveServerMessage['event_type']>(
    type: T,
  ): Promise<LiveServerMessage & { event_type: T }> {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (this.invalid) throw this.invalid;
      const found = this.messages.findIndex(
        (value) => value.event_type === type,
      );
      if (found !== -1) {
        const value = this.messages.splice(found, 1)[0]!;
        if (value.event_type === type)
          return value as LiveServerMessage & { event_type: T };
      }
      const failure = this.messages.find(
        (value) => value.event_type === 'live.error',
      );
      if (failure?.event_type === 'live.error' && type !== 'live.error')
        throw new Error(
          `Expected ${type}, but live preview failed with ${failure.code}.`,
        );
      await delay(10);
    }
    throw new Error(
      `Missing ${type}; received ${this.messages.map((value) => value.event_type).join(',')}`,
    );
  }
}

describe('live gateway configuration', () => {
  it('is off by default without importing any Azure file or requiring OpenAI credentials', () => {
    expect(loadLiveProvider({ AZURE_ENV_FILE: '/does-not-exist' })).toBeNull();
    expect(
      loadLiveProvider({
        LIVE_SPEECH_ENABLED: 'false',
        AZURE_ENV_FILE: '/does-not-exist',
      }),
    ).toBeNull();
    expect(() => loadLiveProvider({ LIVE_SPEECH_ENABLED: 'yes' })).toThrow(
      'true or false',
    );
    expect(() => loadLiveProvider({ LIVE_SPEECH_ENABLED: 'true' })).toThrow(
      'Azure Speech',
    );
    expect(
      loadLiveProvider({
        LIVE_SPEECH_ENABLED: 'true',
        AZURE_SPEECH_KEY: 'synthetic-speech-only-key',
        AZURE_SPEECH_REGION: 'westus',
        AZURE_OPENAI_API_KEY: 'invalid-and-unneeded',
      }),
    ).toMatchObject({
      provider: 'azure',
      configurationVersion: expect.any(String),
    });
  });
});

describe.skipIf(!url)(
  'authenticated bounded live WebSocket and durable accounting',
  () => {
    const schema = `notes_gateway_${randomUUID().replaceAll('-', '')}`;
    let admin: Database;
    let db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    let base: string;
    const peers: Peer[] = [];
    const models: SpeechFixture[] = [];
    const extras: Awaited<ReturnType<typeof createServer>>[] = [];
    let onOpen: ((model: SpeechFixture) => Promise<void>) | undefined;
    const provider: RealtimeProvider = {
      provider: 'fixture',
      configurationVersion: 'gateway-fixture-v1',
      async open(selected, _locale, signal, emit, progress) {
        const model = new SpeechFixture(selected, signal, emit, progress);
        models.push(model);
        if (onOpen) await onOpen(model);
        if (signal.aborted)
          throw new ServiceError('live_cancelled', 'Cancelled.', 409);
        return model;
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
      vi.useRealTimers();
      for (const release of gates.splice(0)) release();
      onOpen = undefined;
      for (const peer of peers) peer.socket.terminate();
      await Promise.all(peers.splice(0).map((peer) => peer.closed));
      for (const model of models) if (model.late) model.complete();
      await vi.waitFor(async () => {
        expect(
          (
            await db.pool.query(
              'SELECT id FROM live_leases WHERE closed_at IS NULL',
            )
          ).rows,
        ).toEqual([]);
      });
      for (const server of extras.splice(0)) await server.close();
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function actor(workspace?: string) {
      const subject = randomUUID();
      const user = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
        workspace,
      );
      const doc = await db.createDocument(
        user.user_id,
        {
          workspace_id: user.workspace_id,
          title: 'Synthetic live meeting',
          notes: 'Keep manual notes.',
        },
        randomUUID(),
      );
      return { ...user, doc: doc.id, headers: { 'x-dev-subject': subject } };
    }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function peer(user: Actor, target = base) {
      const value = new Peer(
        target,
        `/v1/documents/${user.doc}/live`,
        user.headers,
      );
      peers.push(value);
      await once(value.socket, 'open');
      return value;
    }
    async function live(user: Actor, selected = source(), target = base) {
      const socket = await peer(user, target);
      socket.send(start(selected));
      const ready = await socket.next('live.ready');
      const model = models.find(
        (value) => value.providerEpoch === ready.provider_epoch,
      )!;
      return { socket, model, selected, ready };
    }
    async function rejected(
      path: string,
      headers: Record<string, string> = {},
    ) {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, {
        headers,
      });
      socket.on('error', () => undefined);
      return new Promise<number>((resolve, reject) => {
        socket.once('open', () => {
          socket.terminate();
          reject(new Error('Upgrade was incorrectly accepted.'));
        });
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          response.once('end', () => {
            socket.terminate();
            resolve(response.statusCode!);
          });
        });
      });
    }
    async function finished(socket: Peer) {
      socket.send({ schema_version: 1, event_type: 'live.finish' });
      expect(await socket.next('live.closed')).toMatchObject({
        reason: 'finished',
        usage_status: 'settled',
        canonical: false,
        continuity: 'unverified',
      });
      await socket.closed;
    }

    it('keeps the public gateway absent when disabled and advertises its bounded availability', async () => {
      const user = await actor();
      const disabled = await createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
      });
      extras.push(disabled);
      expect(
        (
          await disabled.inject({
            url: `/v1/documents/${user.doc}/live`,
            headers: user.headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await disabled.inject({ url: '/v1/models', headers: user.headers })
        ).json().live_transcription.configured,
      ).toBe(false);
      expect(
        (await app.inject({ url: '/v1/models', headers: user.headers })).json()
          .live_transcription,
      ).toMatchObject({
        configured: true,
        max_media_seconds: 60,
        max_unfinalized_seconds: 5,
        canonical: false,
        automatic_reconnect: false,
      });
    });
    it('authenticates before upgrading and rejects cross-owner, query-token, browser and subprotocol handshakes', async () => {
      const user = await actor();
      const other = await actor(user.workspace_id);
      const path = `/v1/documents/${user.doc}/live`;
      expect(await rejected(path)).toBe(401);
      expect(await rejected(path, { 'x-dev-subject': randomUUID() })).toBe(403);
      expect(await rejected(path, other.headers)).toBe(404);
      expect(
        await rejected(
          `${path}?access_token=must-not-be-accepted`,
          user.headers,
        ),
      ).toBe(400);
      expect(
        await rejected(path, {
          ...user.headers,
          origin: 'https://browser.example.test',
        }),
      ).toBe(400);
      expect(
        await rejected(path, {
          ...user.headers,
          'sec-websocket-protocol': 'not-a-token-channel',
        }),
      ).toBe(400);
      expect(
        (await app.inject({ url: path, headers: user.headers })).statusCode,
      ).toBe(400);
      for (const path of ['/health', '/v1/client-config', '/v1/me', '/missing'])
        expect(await rejected(path, user.headers)).toBe(400);
    });
    it.each([
      { consent: false },
      { provider: 'azure' },
      { access_expires_at: 9999999999999 },
      { budget: { audio_ms: 1 } },
      { source: { ...source(), unknown: true } },
    ])(
      'requires explicit consent and never accepts client provider, budget or expiry fields: %j',
      async (change) => {
        const user = await actor();
        const socket = await peer(user);
        socket.send({ ...start(), ...change });
        expect(await socket.next('live.error')).toMatchObject({
          code: 'invalid_live_message',
        });
        expect((await db.usage.snapshot(user.user_id)).uncertain_requests).toBe(
          '0',
        );
        expect(
          (
            await db.pool.query(
              'SELECT id FROM live_sources WHERE owner_id=$1',
              [user.user_id],
            )
          ).rows,
        ).toEqual([]);
      },
    );
    it('commits the fixed reservation before provider startup, returns authorization-only cursors and never persists preview text or uploads', async () => {
      const user = await actor();
      onOpen = async () => {
        expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
          '60000',
        );
        expect(
          (
            await db.pool.query(
              'SELECT reserved FROM ai_usage_calls WHERE owner_id=$1',
              [user.user_id],
            )
          ).rows,
        ).toEqual([
          {
            reserved: {
              input_tokens: '0',
              output_tokens: '0',
              audio_ms: '60000',
            },
          },
        ]);
      };
      const { socket, model, selected, ready } = await live(user);
      expect(ready).toMatchObject({
        source: selected,
        canonical: false,
        continuity: 'unverified',
      });
      socket.audio([frame(selected), frame(selected, 1)]);
      expect(await socket.next('live.accepted')).toMatchObject({
        acknowledgment: 'authorization_only',
        next_sample: 5600,
        next_sequence: 2,
        accepted_samples: 1600,
        finalized_samples: 1600,
        gap: null,
      });
      expect(model.frames).toEqual([frame(selected), frame(selected, 1)]);
      model.progress?.({
        provider_epoch: model.providerEpoch,
        finalized_samples: 1600,
      });
      expect(await socket.next('live.progress')).toMatchObject({
        finalized_samples: 1600,
        acknowledgment: 'provider_finalization_only',
      });
      model.result();
      expect(await socket.next('transcript.final')).toMatchObject({
        text: 'Synthetic Orion evidence.',
        source: selected,
      });
      await finished(socket);
      expect(await db.usage.snapshot(user.user_id)).toMatchObject({
        settled: { audio_ms: '100' },
        uncertain: { audio_ms: '0' },
        settled_requests: '1',
        uncertain_requests: '0',
      });
      expect(
        (
          await db.pool.query('SELECT id FROM recordings WHERE owner_id=$1', [
            user.user_id,
          ])
        ).rows,
      ).toEqual([]);
      const doc = await db.document(user.user_id, user.doc);
      expect(doc).toMatchObject({
        notes: 'Keep manual notes.',
        transcript_revision: 0,
      });
      const audit = (await db.audit.page({ limit: 100 })).events.filter(
        (event) =>
          event.subject_owner_id === user.user_id &&
          [
            'live_lease_opened',
            'live_lease_closed',
            'usage_reserved',
            'usage_settled',
          ].includes(event.action),
      );
      expect(audit).toHaveLength(4);
      for (const event of audit)
        expect(event).toMatchObject({ source: 'api', actor_id: user.user_id });
      expect(new Set(audit.map((event) => event.request_id)).size).toBe(1);
      expect(audit[0]!.request_id).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain('Synthetic Orion evidence.');
    });
    it('rolls back source metadata and the lease when shared account allowance is insufficient', async () => {
      const user = await actor();
      await db.usage.setLimits(user.user_id, {
        ...DEFAULT_AI_LIMITS,
        audio_ms: 59_999,
      });
      const before = models.length;
      const socket = await peer(user);
      socket.send(start());
      expect(await socket.next('live.error')).toMatchObject({
        code: 'quota_exceeded',
        usage_status: 'check_account',
      });
      expect(models).toHaveLength(before);
      expect(
        (
          await db.pool.query('SELECT id FROM live_leases WHERE owner_id=$1', [
            user.user_id,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.pool.query('SELECT id FROM live_sources WHERE owner_id=$1', [
            user.user_id,
          ])
        ).rows,
      ).toEqual([]);
    });
    it('does not dispatch or close the winning lease when the same start key is replayed on another socket', async () => {
      const user = await actor();
      const first = await peer(user);
      const second = await peer(user);
      const input = start();
      first.send(input);
      const ready = await first.next('live.ready');
      second.send(input);
      expect(await second.next('live.error')).toMatchObject({
        code: 'provider_request_already_started',
      });
      first.audio([frame(input.source)]);
      expect(await first.next('live.accepted')).toMatchObject({
        accepted_samples: 800,
      });
      expect(
        models.filter((model) => model.providerEpoch === ready.provider_epoch),
      ).toHaveLength(1);
      await finished(first);
      expect((await db.usage.snapshot(user.user_id)).settled_requests).toBe(
        '1',
      );
    });
    it('bounds each account to two socket handlers before any provider dispatch', async () => {
      const user = await actor();
      await peer(user);
      await peer(user);
      const third = await peer(user);
      expect(await third.next('live.error')).toMatchObject({
        code: 'live_capacity',
        retryable: true,
      });
      expect((await db.usage.snapshot(user.user_id)).uncertain_requests).toBe(
        '0',
      );
    });
    it('rejects malformed, binary, oversized and source-switched audio without forwarding any frame', async () => {
      for (const mode of ['binary', 'oversized', 'epoch', 'gap']) {
        const user = await actor();
        const { socket, model, selected } = await live(user);
        if (mode === 'binary') socket.socket.send(Buffer.alloc(1600));
        else if (mode === 'oversized') socket.socket.send('x'.repeat(32_769));
        else if (mode === 'epoch')
          socket.audio([frame({ ...selected, capture_epoch: randomUUID() })]);
        else socket.audio([frame(selected), frame(selected, 3)]);
        await socket.closed;
        expect(model.frames).toEqual([]);
        expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
          '60000',
        );
      }
    });
    it('rejects replay before a second provider write and retains unknown usage', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      socket.audio([frame(selected)]);
      expect(await socket.next('live.error')).toMatchObject({
        code: 'live_frame_discontinuity',
      });
      expect(model.frames).toHaveLength(1);
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
    });
    it('fails instead of queuing another audio batch while the previous metadata transaction is blocked', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      const blocked = gate();
      const entered = gate();
      const original = db.live.accept.bind(db.live);
      vi.spyOn(db.live, 'accept').mockImplementationOnce(async (...args) => {
        entered.release();
        await blocked.promise;
        return original(...args);
      });
      socket.audio([frame(selected)]);
      await entered.promise;
      socket.audio([frame(selected, 1)]);
      expect(await socket.next('live.error')).toMatchObject({
        code: 'live_input_backpressure',
      });
      blocked.release();
      await socket.closed;
      expect(model.frames).toEqual([]);
    });
    it('cancels a provider that is still opening without refunding its committed reservation', async () => {
      const user = await actor();
      const blocked = gate();
      const entered = gate();
      onOpen = async () => {
        entered.release();
        await blocked.promise;
      };
      const socket = await peer(user);
      socket.send(start());
      await entered.promise;
      socket.send({ schema_version: 1, event_type: 'live.cancel' });
      expect(await socket.next('live.closed')).toMatchObject({
        reason: 'cancelled',
        usage_status: 'check_account',
      });
      blocked.release();
      await vi.waitFor(() => expect(models.at(-1)!.cancelled).toBe(true));
      await vi.waitFor(async () =>
        expect(
          (
            await db.pool.query(
              'SELECT close_code FROM live_leases WHERE owner_id=$1',
              [user.user_id],
            )
          ).rows,
        ).toEqual([{ close_code: 'cancelled' }]),
      );
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
    });
    it('checks membership epochs again before publishing a result, including revoke and regrant', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1',
        [user.user_id],
      );
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE user_id=$1',
        [user.user_id],
      );
      model.result({ text: 'Must never be published after revocation.' });
      await socket.next('live.error');
      expect(
        socket.messages.filter(
          (value) => value.event_type === 'transcript.final',
        ),
      ).toEqual([]);
      await vi.waitFor(() => expect(model.cancelled).toBe(true));
    });
    it('periodically detects user revocation while no new audio arrives', async () => {
      const user = await actor();
      const { socket, model } = await live(user);
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        user.user_id,
      ]);
      await db.pool.query('UPDATE users SET active=true WHERE id=$1', [
        user.user_id,
      ]);
      await socket.next('live.error');
      expect(model.signal.aborted).toBe(true);
    });
    it('enforces the expiry of a real signed OIDC access token after a successful upgrade', async () => {
      const issuer = 'https://live-identity.example.test/';
      const subject = `synthetic-${randomUUID()}`;
      const keys = await generateKeyPair('RS256');
      const jwk = {
        ...(await exportJWK(keys.publicKey)),
        kid: 'live-test-key',
        alg: 'RS256',
        use: 'sig',
      };
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(JSON.stringify({ keys: [jwk] }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const secured = await createServer(
        db,
        {
          mode: 'oidc',
          host: '127.0.0.1',
          issuer,
          audience: 'live-notes-api',
          jwksUrl: `${issuer}keys`,
          requiredScope: 'notes.access',
        },
        null,
        provider,
      );
      extras.push(secured);
      const address = await secured.listen({ host: '127.0.0.1', port: 0 });
      const user = await db.provision(issuer, subject);
      const document = await db.createDocument(
        user.user_id,
        {
          workspace_id: user.workspace_id,
          title: 'Synthetic token expiry',
          notes: '',
        },
        randomUUID(),
      );
      const token = await new SignJWT({ scp: 'notes.access' })
        .setProtectedHeader({ alg: 'RS256', kid: 'live-test-key' })
        .setIssuer(issuer)
        .setAudience('live-notes-api')
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3)
        .sign(keys.privateKey);
      try {
        const socket = new Peer(address, `/v1/documents/${document.id}/live`, {
          authorization: `Bearer ${token}`,
        });
        peers.push(socket);
        await once(socket.socket, 'open');
        socket.send(start());
        await socket.next('live.ready');
        const failed = await socket.next('live.error');
        expect(['live_session_expired', 'live_lease_lost']).toContain(
          failed.code,
        );
        expect(failed.usage_status).toBe('check_account');
        expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
          '60000',
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }, 10_000);
    it.each(['source', 'epoch', 'range', 'progress'])(
      'rejects invalid provider result %s without publishing private content',
      async (mode) => {
        const user = await actor();
        const { socket, model, selected } = await live(user);
        socket.audio([frame(selected), frame(selected, 1)]);
        await socket.next('live.accepted');
        if (mode === 'source') model.result({ source: source() });
        else if (mode === 'epoch')
          model.result({ provider_epoch: randomUUID() });
        else if (mode === 'range') model.result({ sample_end: 10_000 });
        else
          model.progress?.({
            provider_epoch: model.providerEpoch,
            finalized_samples: 3200,
          });
        expect(await socket.next('live.error')).toMatchObject({
          code: 'live_invalid_result',
        });
        expect(
          socket.messages.filter(
            (value) => value.event_type === 'transcript.final',
          ),
        ).toEqual([]);
      },
    );
    it('bounds pending results even when provider callbacks arrive faster than authorization', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      for (let index = 0; index < 9; index++) model.result();
      expect(await socket.next('live.error')).toMatchObject({
        code: 'live_result_backpressure',
      });
    });
    it('terminates a socket whose network write callback never drains, without retaining an unbounded send', async () => {
      let transport!: WebSocket;
      app.websocketServer.once('connection', (value) => {
        transport = value;
      });
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const send = vi
        .spyOn(transport, 'send')
        .mockImplementation(() => undefined);
      model.result();
      for (let attempt = 0; attempt < 100 && !send.mock.calls.length; attempt++)
        await delay(10);
      expect(send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(6001);
      vi.useRealTimers();
      expect(await socket.closed).toBe(1006);
      expect(model.signal.aborted).toBe(true);
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
    });
    it('stops before appending to an already saturated output buffer', async () => {
      let transport!: WebSocket;
      app.websocketServer.once('connection', (value) => {
        transport = value;
      });
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      Object.defineProperty(transport, 'bufferedAmount', {
        configurable: true,
        get: () => 65_536,
      });
      const send = vi.spyOn(transport, 'send');
      model.result();
      await socket.closed;
      expect(send).not.toHaveBeenCalled();
      expect(model.signal.aborted).toBe(true);
    });
    it('safely closes even when the underlying socket send throws synchronously', async () => {
      let transport!: WebSocket;
      app.websocketServer.once('connection', (value) => {
        transport = value;
      });
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      vi.spyOn(transport, 'send').mockImplementation(() => {
        throw new Error('private-socket-diagnostics');
      });
      model.result();
      expect(await socket.closed).toBe(1006);
      expect(model.signal.aborted).toBe(true);
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
    });
    it('drains final events before closing the settled lease', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      model.finish = () => {
        model.result();
        model.complete();
        return model.completion;
      };
      socket.send({ schema_version: 1, event_type: 'live.finish' });
      expect(await socket.next('transcript.final')).toMatchObject({
        text: 'Synthetic Orion evidence.',
      });
      expect(await socket.next('live.closed')).toMatchObject({
        reason: 'finished',
        usage_status: 'settled',
      });
      expect(
        socket.messages.filter((value) => value.event_type === 'live.error'),
      ).toEqual([]);
    });
    it('settles a known late receipt after socket loss and document deletion without requiring current authorization', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      model.late = true;
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      socket.socket.terminate();
      await socket.closed;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/documents/${user.doc}`,
            headers: user.headers,
          })
        ).statusCode,
      ).toBe(204);
      model.complete();
      await vi.waitFor(async () =>
        expect(await db.usage.snapshot(user.user_id)).toMatchObject({
          settled: { audio_ms: '50' },
          uncertain_requests: '0',
          settled_requests: '1',
        }),
      );
      expect(
        (
          await db.pool.query('SELECT id FROM live_sources WHERE owner_id=$1', [
            user.user_id,
          ])
        ).rows,
      ).toEqual([]);
    });
    it('retries an ambiguous settlement response idempotently without dispatching the provider again', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      const original = db.usage.settle.bind(db.usage);
      const settle = vi
        .spyOn(db.usage, 'settle')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error('private-commit-response-lost');
        });
      await finished(socket);
      expect(settle).toHaveBeenCalledTimes(2);
      expect(model.frames).toHaveLength(1);
      expect(await db.usage.snapshot(user.user_id)).toMatchObject({
        settled_requests: '1',
        uncertain_requests: '0',
      });
    });
    it('retains a hold for an invalid completion receipt and never leaks provider exception details', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      socket.audio([frame(selected)]);
      await socket.next('live.accepted');
      model.finish = () => {
        model.complete({ samples: 1600 });
        return model.completion;
      };
      socket.send({ schema_version: 1, event_type: 'live.finish' });
      expect(await socket.next('live.error')).toMatchObject({
        code: 'live_invalid_receipt',
        usage_status: 'check_account',
      });
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
      const next = await live(await actor());
      next.model.fail();
      const failed = await next.socket.next('live.error');
      expect(failed.code).toBe('live_unavailable');
      expect(JSON.stringify(failed)).not.toContain('private-provider');
    });
    it('reports unverified continuity even for a contiguous reconnect and explicit authorized forward gaps', async () => {
      const user = await actor();
      const first = await live(user);
      first.socket.audio([frame(first.selected)]);
      await first.socket.next('live.accepted');
      first.socket.socket.terminate();
      await first.socket.closed;
      await vi.waitFor(async () =>
        expect(
          (
            await db.pool.query(
              'SELECT id FROM live_leases WHERE owner_id=$1 AND closed_at IS NULL',
              [user.user_id],
            )
          ).rows,
        ).toEqual([]),
      );
      const next = await live(user, first.selected);
      expect(next.ready.continuity).toBe('unverified');
      next.socket.audio([frame(first.selected, 1)]);
      expect(await next.socket.next('live.accepted')).toMatchObject({
        gap: null,
      });
      await finished(next.socket);
      const third = await live(user, first.selected);
      third.socket.audio([frame(first.selected, 4)]);
      expect(await third.socket.next('live.accepted')).toMatchObject({
        gap: { sample_start: 5600, sample_end: 7200 },
      });
      await finished(third.socket);
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
    });
    it('caps a dispatched lease at sixty seconds even when a client bursts media faster than realtime', async () => {
      const user = await actor();
      const { socket, model, selected } = await live(user);
      for (let sequence = 0; sequence < 1200; sequence += 10) {
        socket.audio(
          Array.from({ length: 10 }, (_, index) =>
            frame(selected, sequence + index),
          ),
        );
        expect((await socket.next('live.accepted')).accepted_samples).toBe(
          (sequence + 10) * 800,
        );
      }
      socket.audio([frame(selected, 1200)]);
      expect(await socket.next('live.error')).toMatchObject({
        code: 'live_media_limit',
      });
      expect(model.frames).toHaveLength(1200);
    }, 15_000);
    it('expires an empty handshake rather than retaining a socket indefinitely', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const user = await actor();
      const socket = await peer(user);
      await vi.advanceTimersByTimeAsync(5001);
      vi.useRealTimers();
      expect(await socket.next('live.error')).toMatchObject({
        code: 'live_start_timeout',
      });
      expect((await db.usage.snapshot(user.user_id)).uncertain_requests).toBe(
        '0',
      );
    });
    it('closes all workers and preserves holds during graceful server shutdown', async () => {
      const server = await createServer(
        db,
        { mode: 'development', host: '127.0.0.1' },
        null,
        provider,
      );
      extras.push(server);
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const user = await actor();
      const { socket, model } = await live(user, source(), address);
      const closing = server.close();
      expect(await socket.next('live.closed')).toMatchObject({
        reason: 'cancelled',
      });
      await closing;
      expect(model.cancelled).toBe(true);
      expect((await db.usage.snapshot(user.user_id)).uncertain.audio_ms).toBe(
        '60000',
      );
    });
    it('runs the actual isolated Speech SDK through authenticated WebSocket, source cursors and known usage settlement', async () => {
      const speech = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        maxPayload: 32_768,
      });
      await once(speech, 'listening');
      const endpoint = speech.address();
      if (!endpoint || typeof endpoint === 'string')
        throw new Error('No loopback Speech endpoint.');
      let mediaBytes = 0;
      let pcmValid = true;
      speech.on('connection', (socket) => {
        let began = false;
        const send = (path: string, request: string, body: unknown) =>
          socket.send(
            `Path:${path}\r\nX-RequestId:${request}\r\nContent-Type:application/json\r\n\r\n${JSON.stringify(body)}`,
          );
        socket.on('message', (data, binary) => {
          if (!binary) return;
          const bytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          const length = bytes.readUInt16BE(0);
          const headers = bytes.subarray(2, length + 2).toString();
          if (!/(?:^|\r\n)path:\s*audio(?:\r\n|$)/i.test(headers)) return;
          const request = /x-requestid:\s*([A-Za-z0-9-]+)/i.exec(headers)?.[1];
          if (!request)
            throw new Error('Missing synthetic Speech request identity.');
          if (!began) {
            began = true;
            send('turn.start', request, {});
          }
          const body = bytes.subarray(length + 2);
          if (body.subarray(0, 4).toString() === 'RIFF') return;
          if (!body.length) {
            send('turn.end', request, {});
            return;
          }
          pcmValid &&= body.every((value) => value === 0x2b);
          const offset = (mediaBytes / 2) * 625;
          mediaBytes += body.length;
          send('speech.phrase', request, {
            Id: randomUUID(),
            RecognitionStatus: 'Success',
            DisplayText: 'Synthetic Orion evidence.',
            Offset: offset,
            Duration: (body.length / 2) * 625,
          });
        });
      });
      let worker!: Worker;
      const azure = createAzureRealtimeProvider(
        {
          AZURE_SPEECH_KEY: 'synthetic-loopback-speech-key',
          AZURE_SPEECH_REGION: 'westus',
        },
        (locale) => {
          worker = new Worker(
            new URL(
              '../../../packages/ai/dist/realtime-worker.js',
              import.meta.url,
            ),
            {
              workerData: {
                key: 'synthetic-loopback-speech-key',
                region: 'westus',
                locale,
              },
              env: {
                SYNTHETIC_SPEECH_ENDPOINT: `ws://127.0.0.1:${endpoint.port}/speech/recognition/conversation/cognitiveservices/v1`,
              },
              execArgv: [
                '--import',
                new URL(
                  '../../../packages/ai/fixtures/live-sdk-preload.mjs',
                  import.meta.url,
                ).href,
              ],
              stdout: true,
              stderr: true,
              resourceLimits: {
                maxOldGenerationSizeMb: 64,
                maxYoungGenerationSizeMb: 16,
              },
            },
          );
          return worker;
        },
      );
      const server = await createServer(
        db,
        { mode: 'development', host: '127.0.0.1' },
        null,
        azure,
      );
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const user = await actor();
      let socket: Peer | undefined;
      try {
        socket = await peer(user, address);
        const selected = source();
        socket.send(start(selected));
        await socket.next('live.ready');
        socket.audio([frame(selected), frame(selected, 1)]);
        await socket.next('live.accepted');
        expect(await socket.next('live.progress')).toMatchObject({
          finalized_samples: 1600,
        });
        expect(await socket.next('transcript.final')).toMatchObject({
          source: selected,
          sample_start: 4000,
          sample_end: 5600,
          text: 'Synthetic Orion evidence.',
        });
        await finished(socket);
        expect(mediaBytes).toBe(3200);
        expect(pcmValid).toBe(true);
        expect(worker.threadId).toBe(-1);
        expect(await db.usage.snapshot(user.user_id)).toMatchObject({
          settled: { audio_ms: '100' },
          uncertain_requests: '0',
          settled_requests: '1',
        });
      } finally {
        socket?.socket.terminate();
        await server.close();
        for (const connection of speech.clients) connection.terminate();
        await new Promise<void>((resolve, reject) =>
          speech.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }, 15_000);
    it('bounds the whole process before provider dispatch even across different authorized accounts', async () => {
      const users = await Promise.all(
        Array.from({ length: 17 }, () => actor()),
      );
      for (const user of users.slice(0, 16)) await peer(user);
      const excess = await peer(users[16]!);
      expect(await excess.next('live.error')).toMatchObject({
        code: 'live_capacity',
      });
      expect(
        (await db.usage.snapshot(users[16]!.user_id)).uncertain_requests,
      ).toBe('0');
    });
  },
);
