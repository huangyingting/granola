import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import {
  liveClientMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
  type LiveSource,
} from '@windows-ai-notes/contracts/realtime';
import { ApiClient, ClientError } from './http.js';
import {
  LIVE_CLIENT_WINDOW_SAMPLES,
  type LiveConnection,
  type LiveConnectionOptions,
} from './live.js';

const source = (): LiveSource => ({
  recording_id: randomUUID(),
  preview_id: randomUUID(),
  track_id: randomUUID(),
  capture_epoch: randomUUID(),
});
const frames = (
  selected: LiveSource,
  sequence = 0,
  count = 10,
): LivePcmFrame[] =>
  Array.from({ length: count }, (_, index) => ({
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
type Audio = Extract<LiveClientMessage, { event_type: 'live.audio' }>;

describe('Main-owned bounded live client transport', () => {
  const servers: Server[] = [];
  const sockets: WebSocketServer[] = [];
  const connections: LiveConnection[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const server of sockets)
      for (const peer of server.clients) peer.terminate();
    await Promise.all(connections.splice(0).map((value) => value.cancel()));
    await Promise.all(
      sockets
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
  });
  async function serve(server: Server) {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port.');
    return `http://127.0.0.1:${address.port}`;
  }
  async function fixture(
    configuration: {
      ready?: boolean;
      ack?: boolean;
      finish?: boolean;
      usage?: 'settled' | 'check_account';
    } = {},
  ) {
    const server = createServer();
    const wss = new WebSocketServer({ server, perMessageDeflate: false });
    sockets.push(wss);
    const selected = source();
    const document = randomUUID();
    const epoch = randomUUID();
    const events: LiveServerMessage[] = [];
    const received: LiveClientMessage[] = [];
    let accepted = 0;
    let peer!: WebSocket;
    let upgrade!: { url: string | undefined; headers: typeof requestHeaders };
    const requestHeaders: Record<string, string | string[] | undefined> = {};
    const ready = () => ({
      schema_version: 1 as const,
      event_type: 'live.ready' as const,
      source: selected,
      provider_epoch: epoch,
      canonical: false as const,
      continuity: 'unverified' as const,
      max_media_ms: 60_000 as const,
      max_unfinalized_ms: 5000 as const,
    });
    const send = (value: unknown) => peer.send(JSON.stringify(value));
    const ack = (audio: Audio, change: Record<string, unknown> = {}) => {
      const last = audio.frames.at(-1)!;
      send({
        schema_version: 1,
        event_type: 'live.accepted',
        source: selected,
        provider_epoch: epoch,
        acknowledgment: 'authorization_only',
        next_sequence: last.sequence + 1,
        next_sample: last.sample_start + 800,
        accepted_samples: accepted,
        finalized_samples: 0,
        gap: null,
        ...change,
      });
    };
    const progress = (samples: number) =>
      send({
        schema_version: 1,
        event_type: 'live.progress',
        source: selected,
        provider_epoch: epoch,
        finalized_samples: samples,
        acknowledgment: 'provider_finalization_only',
      });
    const recognition = (change: Record<string, unknown> = {}) =>
      send({
        schema_version: 1,
        event_type: 'transcript.partial',
        source: selected,
        provider_epoch: epoch,
        segment_id: randomUUID(),
        version: 1,
        sample_start: 4000,
        sample_end: 4800,
        text: 'Synthetic live evidence.',
        discard_reason: null,
        provider_result_id: 'synthetic-result',
        ...change,
      });
    wss.on('connection', (socket, request) => {
      peer = socket;
      upgrade = { url: request.url, headers: request.headers };
      peer.on('error', () => undefined);
      peer.on('message', (data) => {
        const message = liveClientMessageSchema.parse(
          JSON.parse(data.toString()),
        );
        received.push(message);
        if (
          message.event_type === 'live.start' &&
          configuration.ready !== false
        )
          send(ready());
        if (message.event_type === 'live.audio') {
          accepted += message.frames.length * 800;
          if (configuration.ack !== false) ack(message);
        }
        if (
          message.event_type === 'live.finish' &&
          configuration.finish !== false
        )
          send({
            schema_version: 1,
            event_type: 'live.closed',
            reason: 'finished',
            usage_status: configuration.usage ?? 'settled',
            canonical: false,
            continuity: 'unverified',
          });
      });
    });
    const base = await serve(server);
    const options: LiveConnectionOptions = {
      source: selected,
      locale: 'en-US',
      consent: true,
      signal: new AbortController().signal,
      authorize: () => {},
      onEvent: (event) => {
        events.push(event);
        return undefined;
      },
    };
    const client = new ApiClient(
      base,
      async () => ({
        Authorization: 'Bearer synthetic-test-only',
      }),
      { allowLoopback: true },
    );
    return {
      client,
      document,
      selected,
      epoch,
      events,
      received,
      options,
      ready,
      send,
      ack,
      progress,
      recognition,
      get peer() {
        return peer;
      },
      get upgrade() {
        return upgrade;
      },
      get audio() {
        return received.filter(
          (message) => message.event_type === 'live.audio',
        );
      },
      async open(change: Partial<LiveConnectionOptions> = {}) {
        const value = await client.openLiveSource(document, {
          ...options,
          ...change,
        });
        connections.push(value);
        return value;
      },
    };
  }
  it('uses private headers and a fixed owned-document path, with no URL token, Origin, protocol or compression', async () => {
    const f = await fixture();
    const live = await f.open();
    expect(f.upgrade.url).toBe(`/v1/documents/${f.document}/live`);
    expect(f.upgrade.headers.authorization).toBe('Bearer synthetic-test-only');
    for (const key of [
      'origin',
      'sec-websocket-protocol',
      'sec-websocket-extensions',
    ])
      expect(f.upgrade.headers[key]).toBeUndefined();
    expect(f.received[0]).toMatchObject({
      event_type: 'live.start',
      source: f.selected,
      consent: true,
      locale: 'en-US',
    });
    expect(live.ready).toMatchObject({
      canonical: false,
      continuity: 'unverified',
    });
    live.ready.source.track_id = randomUUID();
    expect(live.ready.source).toEqual(f.selected);
    await live.write(frames(f.selected));
    expect(f.audio[0]?.frames).toEqual(frames(f.selected));
    const done = live.finish();
    expect(live.finish()).toBe(done);
    await expect(done).resolves.toMatchObject({
      reason: 'finished',
      usage_status: 'settled',
      canonical: false,
    });
    await live.closed;
  });
  it('requires consent before credentials or network dispatch', async () => {
    const f = await fixture();
    const invalid = { ...f.options, consent: false };
    // @ts-expect-error Runtime callers cannot substitute false for consent.
    const result = f.client.openLiveSource(f.document, invalid);
    await expect(result).rejects.toMatchObject({
      code: 'invalid_live_request',
    });
    expect(f.received).toEqual([]);
  });
  it('preserves a credential-provider failure without dispatching', async () => {
    const f = await fixture();
    const error = new Error('Synthetic locked vault.');
    const api = new ApiClient(
      f.client.base,
      async () => {
        throw error;
      },
      { allowLoopback: true },
    );
    await expect(api.openLiveSource(f.document, f.options)).rejects.toBe(error);
    expect(f.received).toEqual([]);
  });
  it('aborts credential retrieval immediately and never dispatches when it later resolves', async () => {
    const f = await fixture();
    let release!: (value: Record<string, string>) => void;
    const credential = new Promise<Record<string, string>>((resolve) => {
      release = resolve;
    });
    const headers = vi.fn(() => credential);
    const api = new ApiClient(f.client.base, headers, { allowLoopback: true });
    const controller = new AbortController();
    const result = api.openLiveSource(f.document, {
      ...f.options,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'live_cancelled' });
    release({ Authorization: 'Bearer late-synthetic-test-only' });
    expect(headers).toHaveBeenCalledTimes(1);
    expect(f.received).toEqual([]);
  });
  it('rechecks owner scope after asynchronous credentials and before dispatch', async () => {
    const f = await fixture();
    let active = true;
    const api = new ApiClient(
      f.client.base,
      async () => {
        active = false;
        return {};
      },
      { allowLoopback: true },
    );
    await expect(
      api.openLiveSource(f.document, {
        ...f.options,
        authorize: () => {
          if (!active)
            throw new ClientError('workspace_changed', 'Workspace changed.');
        },
      }),
    ).rejects.toMatchObject({ code: 'workspace_changed' });
    expect(f.received).toEqual([]);
  });
  it('does not follow HTTP redirects or forward credentials to their destination', async () => {
    let contacted = false;
    const destination = await serve(
      createServer((_request, response) => {
        contacted = true;
        response.end();
      }),
    );
    const base = await serve(
      createServer((_request, response) => {
        response.writeHead(307, { Location: destination });
        response.end('private diagnostics');
      }),
    );
    const f = await fixture();
    const client = new ApiClient(
      base,
      async () => ({ Authorization: 'Bearer synthetic-test-only' }),
      { allowLoopback: true },
    );
    await expect(
      client.openLiveSource(f.document, f.options),
    ).rejects.toMatchObject({
      code: 'service_redirect_rejected',
      status: 307,
    });
    expect(contacted).toBe(false);
  });
  it.each([
    [401, 'live_authentication_required'],
    [403, 'live_access_denied'],
    [404, 'live_not_available'],
    [429, 'live_rate_limited'],
    [503, 'live_handshake_failed'],
  ])(
    'reports bounded handshake rejection %s without reflecting the response body',
    async (status, code) => {
      const base = await serve(
        createServer((_request, response) => {
          response.writeHead(status);
          response.end('private diagnostics');
        }),
      );
      const f = await fixture();
      const api = new ApiClient(base, async () => ({}), {
        allowLoopback: true,
      });
      await expect(
        api.openLiveSource(f.document, f.options),
      ).rejects.toMatchObject({ code, status });
    },
  );
  it('bounds provider plus in-flight media to two seconds, holds only one extra read, and never credits partials', async () => {
    const f = await fixture();
    const live = await f.open();
    for (let i = 0; i < 4; i++) await live.write(frames(f.selected, i * 10));
    expect(live.unfinalizedSamples).toBe(LIVE_CLIENT_WINDOW_SAMPLES);
    const waiting = live.write(frames(f.selected, 40));
    await expect(live.write(frames(f.selected, 40))).rejects.toMatchObject({
      code: 'live_input_busy',
    });
    f.recognition();
    await vi.waitFor(() =>
      expect(
        f.events.some((value) => value.event_type === 'transcript.partial'),
      ).toBe(true),
    );
    expect(f.audio).toHaveLength(4);
    expect(live.unfinalizedSamples).toBe(32_000);
    f.progress(8000);
    await expect(waiting).resolves.toMatchObject({
      accepted_samples: 40_000,
      finalized_samples: 0,
    });
    expect(f.audio).toHaveLength(5);
    expect(live.unfinalizedSamples).toBe(32_000);
  });
  it('merges final credit monotonically when a newer progress event precedes an older accepted snapshot', async () => {
    const f = await fixture({ ack: false });
    const live = await f.open();
    const pending = live.write(frames(f.selected));
    await vi.waitFor(() => expect(f.audio).toHaveLength(1));
    f.progress(1600);
    f.ack(f.audio[0]!);
    await pending;
    expect(live.unfinalizedSamples).toBe(6400);
    f.progress(1600);
    await vi.waitFor(() =>
      expect(
        f.events.filter((event) => event.event_type === 'live.progress'),
      ).toHaveLength(2),
    );
    expect(live.unfinalizedSamples).toBe(6400);
  });
  it.each(['credit', 'authorization'] as const)(
    'fails closed after bounded %s stall and rejects the pending write',
    async (kind) => {
      const f = await fixture({ ack: kind !== 'authorization' });
      const live = await f.open();
      if (kind === 'credit')
        for (let i = 0; i < 4; i++)
          await live.write(frames(f.selected, i * 10));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = live.write(
        frames(f.selected, kind === 'credit' ? 40 : 0),
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'live_audio_stalled',
      });
      await vi.advanceTimersByTimeAsync(5001);
      await rejected;
      await expect(live.completion).rejects.toMatchObject({
        code: 'live_audio_stalled',
      });
    },
  );
  it('rejects oversized, cross-source and rewound input without dispatching another batch', async () => {
    const f = await fixture();
    const live = await f.open();
    await expect(live.write(frames(f.selected, 0, 11))).rejects.toMatchObject({
      code: 'invalid_live_audio',
    });
    await expect(live.write(frames(source()))).rejects.toMatchObject({
      code: 'live_discontinuity',
    });
    await live.write(frames(f.selected));
    await expect(live.write(frames(f.selected))).rejects.toMatchObject({
      code: 'live_discontinuity',
    });
    const wrongClock = frames(f.selected, 10);
    wrongClock[0]!.clock_start_ms = 0;
    wrongClock[0]!.clock_end_ms = 499;
    await expect(live.write(wrongClock)).rejects.toMatchObject({
      code: 'live_discontinuity',
    });
    await live.write(frames(f.selected, 10));
    expect(f.audio).toHaveLength(2);
  });
  it('allows overlapping native callback clocks without losing sample or end-clock continuity', async () => {
    const f = await fixture();
    const live = await f.open();
    await live.write(frames(f.selected));
    const next = frames(f.selected, 10);
    next[0]!.clock_start_ms = 499;
    await expect(live.write(next)).resolves.toMatchObject({
      accepted_samples: 16_000,
    });
    expect(f.audio[1]!.frames[0]!.clock_start_ms).toBe(499);
  });
  it('closes immediately when an outgoing operation detects owner revocation', async () => {
    const f = await fixture();
    let active = true;
    const live = await f.open({
      authorize: () => {
        if (!active)
          throw new ClientError('workspace_changed', 'Workspace changed.');
      },
    });
    active = false;
    await expect(live.write(frames(f.selected))).rejects.toMatchObject({
      code: 'workspace_changed',
    });
    await expect(live.completion).rejects.toMatchObject({
      code: 'workspace_changed',
    });
    await live.closed;
    expect(f.audio).toEqual([]);
  });
  it.each([
    'source',
    'epoch',
    'ready',
    'binary',
    'json',
    'oversized',
    'range',
    'credit',
    'ack',
  ] as const)(
    'rejects inconsistent %s results without replay or reconnect',
    async (kind) => {
      const f = await fixture();
      const live = await f.open();
      await live.write(frames(f.selected));
      if (kind === 'source') f.recognition({ source: source() });
      if (kind === 'epoch') f.recognition({ provider_epoch: randomUUID() });
      if (kind === 'ready') f.send(f.ready());
      if (kind === 'binary') f.peer.send(Buffer.from('{}'));
      if (kind === 'json') f.peer.send('{');
      if (kind === 'oversized') f.peer.send('x'.repeat(32_769));
      if (kind === 'range') f.recognition({ sample_end: 13_000 });
      if (kind === 'credit') f.progress(9600);
      if (kind === 'ack') f.ack(f.audio[0]!);
      await expect(live.completion).rejects.toBeInstanceOf(ClientError);
      await live.closed;
      expect(
        f.received.filter((message) => message.event_type === 'live.start'),
      ).toHaveLength(1);
    },
  );
  it('does not publish results or forward queued media after owner scope is revoked', async () => {
    const f = await fixture();
    let active = true;
    const live = await f.open({
      authorize: () => {
        if (!active)
          throw new ClientError('workspace_changed', 'Workspace changed.');
      },
    });
    for (let i = 0; i < 4; i++) await live.write(frames(f.selected, i * 10));
    const pending = live.write(frames(f.selected, 40));
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'workspace_changed',
    });
    active = false;
    const count = f.events.length;
    f.progress(8000);
    await rejected;
    await expect(live.completion).rejects.toMatchObject({
      code: 'workspace_changed',
    });
    expect(f.events).toHaveLength(count);
    expect(f.audio).toHaveLength(4);
  });
  it('cancels a pending audio operation immediately without needing current account authorization', async () => {
    const f = await fixture({ ack: false });
    const controller = new AbortController();
    const live = await f.open({ signal: controller.signal });
    const pending = live.write(frames(f.selected));
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'live_cancelled',
    });
    controller.abort();
    await rejected;
    await live.closed;
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_cancelled',
    });
  });
  it('sends explicit cancellation and never interprets it as a refund or a successful finish', async () => {
    const f = await fixture();
    const live = await f.open();
    await live.cancel();
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_cancelled',
    });
    expect(f.received.some((value) => value.event_type === 'live.cancel')).toBe(
      true,
    );
  });
  it('preserves an unconfirmed usage outcome on otherwise normal finish', async () => {
    const f = await fixture({ usage: 'check_account' });
    const live = await f.open();
    await live.write(frames(f.selected));
    await expect(live.finish()).resolves.toMatchObject({
      usage_status: 'check_account',
      continuity: 'unverified',
    });
  });
  it('rejects finishing while audio is pending rather than overtaking its authorization', async () => {
    const f = await fixture({ ack: false });
    const live = await f.open();
    const pending = live.write(frames(f.selected));
    await expect(live.finish()).rejects.toMatchObject({
      code: 'invalid_live_state',
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'live_cancelled',
    });
    await live.cancel();
    await rejected;
    expect(f.received.some((value) => value.event_type === 'live.finish')).toBe(
      false,
    );
  });
  it('fails explicitly when its synchronous result consumer throws', async () => {
    const f = await fixture();
    const live = await f.open({
      onEvent: (event) => {
        if (event.event_type === 'transcript.partial')
          throw new Error('private callback diagnostics');
        return undefined;
      },
    });
    await live.write(frames(f.selected));
    f.recognition();
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_consumer_failed',
    });
  });
  it('rejects asynchronous consumers and observes their rejected promise', async () => {
    const f = await fixture();
    const onEvent = (event: LiveServerMessage) => {
      if (event.event_type !== 'transcript.partial') return undefined;
      return Promise.reject(new Error('private callback diagnostics'));
    };
    // @ts-expect-error Deliberately invalid asynchronous consumer.
    const live = await f.open({ onEvent });
    await live.write(frames(f.selected));
    f.recognition();
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_consumer_failed',
    });
  });
  it('rejects asynchronous authorization before credentials or dispatch', async () => {
    const f = await fixture();
    await expect(
      f.open({
        authorize: async () => {
          throw new Error('private authorization diagnostics');
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_live_authorizer' });
    expect(f.received).toEqual([]);
  });
  it('fails when the bounded WebSocket output cannot drain', async () => {
    const f = await fixture();
    const live = await f.open();
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(
      32_768,
    );
    await expect(live.write(frames(f.selected))).rejects.toMatchObject({
      code: 'live_output_backpressure',
    });
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_output_backpressure',
    });
    expect(f.audio).toEqual([]);
  });
  it.each(['throw', 'callback', 'stall'] as const)(
    'handles a %s send failure without leaking pending work',
    async (kind) => {
      const f = await fixture();
      const live = await f.open();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let invoked = false;
      vi.spyOn(WebSocket.prototype, 'send').mockImplementationOnce(
        (
          _data,
          callback:
            Parameters<WebSocket['send']>[1] | ((error?: Error) => void),
        ) => {
          if (kind === 'throw') throw new Error('private send diagnostics');
          if (kind === 'callback' && typeof callback === 'function') {
            invoked = true;
            callback(new Error('private send diagnostics'));
          }
        },
      );
      const pending =
        kind === 'stall' ? live.finish() : live.write(frames(f.selected));
      const rejected = expect(pending).rejects.toMatchObject({
        code: kind === 'stall' ? 'live_send_timeout' : 'live_send_failed',
      });
      if (kind === 'stall') await vi.advanceTimersByTimeAsync(5001);
      await rejected;
      if (kind === 'callback') expect(invoked).toBe(true);
      expect(f.audio).toEqual([]);
      await live.closed;
    },
  );
  it('forces transport cleanup when the peer does not complete the close handshake', async () => {
    const f = await fixture();
    const live = await f.open();
    f.peer.pause();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = live.cancel();
    await vi.advanceTimersByTimeAsync(1001);
    await closing;
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_cancelled',
    });
  });
  it('surfaces service errors without treating partial results as successful completion', async () => {
    const f = await fixture();
    const live = await f.open();
    f.send({
      schema_version: 1,
      event_type: 'live.error',
      code: 'usage_limit_reached',
      message: 'The account allowance is exhausted.',
      retryable: false,
      request_id: randomUUID(),
      usage_status: 'check_account',
      canonical: false,
      continuity: 'unverified',
    });
    await expect(live.completion).rejects.toMatchObject({
      code: 'usage_limit_reached',
      retryable: false,
    });
  });
  it('never reflects private close reasons or reconnects after losing the transport', async () => {
    const f = await fixture();
    const live = await f.open();
    f.peer.close(1011, 'private provider diagnostics');
    await expect(live.completion).rejects.toMatchObject({
      code: 'live_connection_lost',
      message: expect.not.stringContaining('private provider diagnostics'),
    });
    expect(
      f.received.filter((message) => message.event_type === 'live.start'),
    ).toHaveLength(1);
  });
  it.each(['starting', 'finishing', 'lifetime'] as const)(
    'bounds the %s deadline',
    async (phase) => {
      const f = await fixture({ ready: phase !== 'starting', finish: false });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      if (phase === 'starting') {
        const opening = f.open();
        const rejected = expect(opening).rejects.toMatchObject({
          code: 'live_start_timeout',
        });
        await vi.waitFor(() => expect(f.received).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(15_001);
        await rejected;
      } else {
        const live = await f.open();
        const finishing =
          phase === 'finishing' ? live.finish() : live.completion;
        const rejected = expect(finishing).rejects.toMatchObject({
          code:
            phase === 'finishing' ? 'live_finish_timeout' : 'live_time_limit',
        });
        await vi.advanceTimersByTimeAsync(
          phase === 'finishing' ? 10_001 : 80_001,
        );
        await rejected;
      }
    },
  );
});
