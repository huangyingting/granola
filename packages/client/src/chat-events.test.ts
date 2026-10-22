import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '@windows-ai-notes/local';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import {
  CHAT_VERSION,
  chatEventSchema,
  chatEventStateSchema,
  chatWatchSchema,
  type ChatTurn,
} from '@windows-ai-notes/contracts/questions';
import { ApiClient, ClientError } from './http.js';
import { ChatEvents } from './chat-events.js';
import { DesktopDelivery } from './delivery.js';

vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: vi.fn(async () => undefined),
}));

describe('bounded isolated Main chat subscriptions', () => {
  let directory: string, key: Buffer, local: LocalStore;
  let events: ChatEvents, api: ApiClient;
  let id: string, thread: string, turn: string;
  let remote: ReturnType<typeof chatEventStateSchema.parse>;
  let reads: Set<AbortController>;
  let delivery: DesktopDelivery, records: Record<string, unknown>[];
  const cache = vi.fn(
    (_profile: string, _id: string, value: ChatTurn) => value,
  );
  const failed = vi.fn(async (error: unknown) => error);
  const profile = 'chat-events-fixture';
  const artifact = () => `chat-thread:${thread}:events:${turn}`;
  const start = () => events.start(1, id, thread, turn);
  const snapshot = () => events.snapshot(profile, id);
  const message = (seq: number, text = '', attempt = 1) =>
    chatEventSchema.parse({
      turn_id: turn,
      seq,
      event_type: 'turn.progress',
      schema_version: 1,
      created_at: new Date().toISOString(),
      payload: { version: 1, attempt, text },
    });
  beforeEach(() => {
    vi.mocked(delay).mockClear();
    cache.mockClear();
    failed.mockClear();
    directory = mkdtempSync(join(tmpdir(), 'windows-notes-chat-events-'));
    key = randomBytes(32);
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    id = randomUUID();
    const created = new Date().toISOString();
    local.applyRemote(profile, {
      id,
      workspace_id: randomUUID(),
      owner_id: randomUUID(),
      title: 'Synthetic event source',
      notes: 'Mira owns the checklist.',
      content: richTextFromPlainText('Mira owns the checklist.'),
      tags: [],
      revision: 1,
      transcript_revision: 0,
      created_at: created,
      updated_at: created,
    });
    thread = randomUUID();
    turn = randomUUID();
    remote = chatEventStateSchema.parse({
      turn: {
        id: turn,
        thread_id: thread,
        document_id: id,
        position: 1,
        request: {
          note_revision: 1,
          transcript_revision: 0,
          question: 'Who owns the checklist?',
          language: 'en',
          confirmed: true,
        },
        mode: 'full',
        state: 'queued',
        attempt: 0,
        input_stale: false,
        result: null,
        error: null,
        resume_available: false,
        resume_token: null,
        provider_requests: 0,
        uncertain_requests: 0,
        last_event_id: 1,
        created_at: new Date().toISOString(),
      },
      preview_attempt: 0,
      preview: null,
    });
    api = new ApiClient('https://fixture.example', async () => ({}));
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      if (String(url).endsWith('/v1/chat-capabilities'))
        return Response.json({
          questions: CHAT_VERSION,
          max_attempts: 3,
          max_pending_work: 8,
          history_context: 'meeting-question-context-v1',
        });
      if (String(url).endsWith(`/v1/chat-turns/${turn}/event-state`))
        return Response.json(remote);
      throw new Error('Unexpected synthetic subscription request.');
    });
    vi.spyOn(api, 'chatEvents').mockImplementation(
      async (_id, _after, _received, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new ClientError('request_cancelled', 'Stopped.')),
            { once: true },
          );
        }),
    );
    reads = new Set();
    records = [];
    delivery = new DesktopDelivery(
      new Writable({
        write(chunk, _encoding, done) {
          records.push(JSON.parse(String(chunk)));
          done();
        },
      }),
    );
    events = new ChatEvents(local, {
      delivery,
      owner: () => ({
        profile,
        api,
        authorize: () => {
          local.get(profile, id);
        },
      }),
      reads,
      cache,
      failed,
      changed: () => {},
    });
  });
  afterEach(async () => {
    events.stop();
    delivery.close();
    await Promise.resolve();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    local.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  it('offers only validated nonblank preview text and invalidates an unpresented older attempt', async () => {
    await start();
    await vi.waitFor(() => expect(api.chatEvents).toHaveBeenCalled());
    const receive = vi.mocked(api.chatEvents).mock.calls[0]![2];
    await receive(message(1, ' '));
    expect(delivery.markers(1, id)).toEqual([]);
    await receive(message(2, ' Mira owns the checklist.'));
    const marker = delivery.markers(1, id)[0]!;
    expect(marker).toMatchObject({ kind: 'chat_preview', operation_id: turn });
    expect(
      local.getArtifact(profile, id, artifact(), chatWatchSchema),
    ).not.toHaveProperty('presentations');
    await receive(message(3, 'New worker attempt.', 2));
    expect(delivery.markers(1, id)).toEqual([]);
    expect(delivery.present(1, id, marker.token)).toBe(false);
    expect(
      records.filter((value) => value.code === 'desktop_delivery_received'),
    ).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      outcome: 'superseded',
      presentation_ack_after_receive_ms: null,
    });
    expect(JSON.stringify(records)).not.toMatch(/Mira|checklist|New worker/);
  });
  it('bounds repeated premature EOF, backs off, releases the shared read slot and leaves a visible paused state', async () => {
    vi.mocked(api.chatEvents).mockResolvedValue(0);
    await start();
    await vi.waitFor(() => expect(snapshot()?.status).toBe('paused'));
    expect(api.chatEvents).toHaveBeenCalledTimes(5);
    expect(vi.mocked(delay).mock.calls.map((call) => call[0])).toEqual([
      2000, 4000, 8000, 16000,
    ]);
    expect(reads.size).toBe(0);
    expect(snapshot()).toMatchObject({
      last_event_id: 0,
      preview: '',
      error: expect.stringContaining('repeatedly closed'),
    });
  });
  it('drains every terminal page instead of stopping at the first bounded connection', async () => {
    remote.turn = {
      ...remote.turn,
      state: 'succeeded',
      attempt: 1,
      provider_requests: 1,
      last_event_id: 600,
      result: {
        answer: {
          status: 'answered',
          answer: {
            text: 'Mira.',
            citations: [{ source: 'note', id, revision: 1 }],
          },
        },
        provider: 'fixture',
        configuration_version: 'synthetic-events-v1',
        prompt_version: 'meeting-question-answer-v1',
        usage: { input_tokens: 10, output_tokens: 2, audio_ms: 0 },
      },
    };
    remote.preview_attempt = 1;
    vi.mocked(api.chatEvents).mockImplementation(
      async (_id, after, received) => {
        const end = Math.min(600, after + 512);
        for (let seq = after + 1; seq <= end; seq++)
          await received(message(seq));
        return end;
      },
    );
    await start();
    await vi.waitFor(() => expect(reads.size).toBe(0));
    expect(vi.mocked(api.chatEvents).mock.calls.map((call) => call[1])).toEqual(
      [0, 512],
    );
    expect(snapshot()).toBeNull();
    expect(
      local.getArtifact(profile, id, artifact(), chatWatchSchema),
    ).toBeNull();
    expect(cache.mock.calls.at(-1)?.[2].result?.answer.answer.text).toBe(
      'Mira.',
    );
  });
  it('respects bounded service backoff when renewing a read subscription', async () => {
    vi.mocked(api.chatEvents).mockRejectedValueOnce(
      new ClientError(
        'quota_exceeded',
        'Wait before subscribing again.',
        429,
        true,
        9,
      ),
    );
    await start();
    await vi.waitFor(() => expect(api.chatEvents).toHaveBeenCalledTimes(2));
    expect(vi.mocked(delay).mock.calls[0]?.[0]).toBe(9000);
    expect(failed).not.toHaveBeenCalled();
  });
  it('shares the four-read Main limit and rejects another subscription before contacting the service', async () => {
    for (let index = 0; index < 4; index++) reads.add(new AbortController());
    const requests = vi.spyOn(api, 'request');
    await expect(start()).rejects.toMatchObject({ code: 'request_busy' });
    expect(requests).not.toHaveBeenCalled();
    expect(api.chatEvents).not.toHaveBeenCalled();
    expect(reads.size).toBe(4);
  });
  it('recovers an expired cursor and its exact preview together from the authorized snapshot', async () => {
    remote.turn = {
      ...remote.turn,
      state: 'running',
      attempt: 1,
      last_event_id: 8,
    };
    remote.preview_attempt = 1;
    remote.preview = {
      version: 1,
      attempt: 1,
      text: 'Authorized current preview.',
    };
    vi.mocked(api.chatEvents).mockRejectedValueOnce(
      new ClientError(
        'event_cursor_expired',
        'Fetch the authorized snapshot.',
        410,
      ),
    );
    await start();
    await vi.waitFor(() =>
      expect(snapshot()).toMatchObject({
        last_event_id: 8,
        attempt: 1,
        preview: 'Authorized current preview.',
      }),
    );
    expect(
      local.getArtifact(profile, id, artifact(), chatWatchSchema)
        ?.last_event_id,
    ).toBe(8);
    expect(vi.mocked(api.chatEvents).mock.calls[1]?.[1]).toBe(8);
    expect(failed).not.toHaveBeenCalled();
    expect(
      records.find((value) => value.code === 'desktop_delivery_received'),
    ).toMatchObject({ origin: 'snapshot' });
  });
  it('rejects a same-attempt prefix change even when an earlier pause cleared the displayed preview', async () => {
    remote.turn = {
      ...remote.turn,
      state: 'running',
      attempt: 1,
      last_event_id: 3,
    };
    remote.preview_attempt = 1;
    remote.preview = { version: 1, attempt: 1, text: 'Original prefix.' };
    local.putArtifact(profile, id, artifact(), {
      document_id: id,
      thread_id: thread,
      turn_id: turn,
      last_event_id: 2,
      attempt: 1,
      preview: '',
      status: 'paused',
      error: 'Interrupted.',
    });
    vi.mocked(api.chatEvents).mockImplementation(
      async (_id, _after, received) => {
        await received(message(4, 'Different prefix.'));
        return 4;
      },
    );
    await start();
    await vi.waitFor(() => expect(snapshot()?.status).toBe('paused'));
    expect(snapshot()).toMatchObject({ last_event_id: 3, preview: '' });
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_event_stream' }),
      expect.anything(),
      id,
      thread,
      expect.anything(),
    );
  });
  it('restores a paused preview from its authorized snapshot even when no newer event follows the old cursor', async () => {
    remote.turn = {
      ...remote.turn,
      state: 'running',
      attempt: 1,
      last_event_id: 3,
    };
    remote.preview_attempt = 1;
    remote.preview = {
      version: 1,
      attempt: 1,
      text: 'Current authorized preview.',
    };
    local.putArtifact(profile, id, artifact(), {
      document_id: id,
      thread_id: thread,
      turn_id: turn,
      last_event_id: 2,
      attempt: 1,
      preview: '',
      status: 'paused',
      error: 'Interrupted.',
    });
    await start();
    expect(snapshot()).toMatchObject({
      last_event_id: 3,
      preview: 'Current authorized preview.',
    });
    expect(vi.mocked(api.chatEvents).mock.calls[0]?.[1]).toBe(3);
  });
  it.each([
    'thread',
    'document',
    'turn',
    'cursor',
    'fence',
    'terminal-preview',
  ] as const)(
    'does not expose a saved preview before verifying the current %s snapshot',
    async (failure) => {
      remote.turn = {
        ...remote.turn,
        state: 'running',
        attempt: 1,
        last_event_id: 3,
      };
      remote.preview_attempt = 1;
      remote.preview = {
        version: 1,
        attempt: 1,
        text: 'Saved but unverified.',
      };
      local.putArtifact(profile, id, artifact(), {
        document_id: id,
        thread_id: thread,
        turn_id: turn,
        last_event_id: failure === 'cursor' ? 4 : 2,
        attempt: failure === 'fence' ? 3 : 1,
        preview: 'Saved but unverified.',
        status: 'streaming',
        error: null,
      });
      if (failure === 'thread') remote.turn.thread_id = randomUUID();
      if (failure === 'document') remote.turn.document_id = randomUUID();
      if (failure === 'turn') remote.turn.id = randomUUID();
      if (failure === 'terminal-preview') remote.turn.state = 'failed';
      await expect(start()).rejects.toMatchObject({
        code:
          failure === 'terminal-preview'
            ? 'invalid_server_response'
            : 'invalid_event_stream',
      });
      expect(snapshot()).toBeNull();
      expect(reads.size).toBe(0);
      expect(api.chatEvents).not.toHaveBeenCalled();
    },
  );
  it('uses the authoritative lease fence rather than the smaller paid-attempt count when skipping old failed previews', async () => {
    remote.turn = {
      ...remote.turn,
      state: 'running',
      attempt: 2,
      last_event_id: 4,
    };
    remote.preview_attempt = 3;
    remote.preview = { version: 1, attempt: 3, text: 'Current attempt.' };
    const seen: string[] = [];
    vi.mocked(api.chatEvents).mockImplementation(
      async (_id, _after, received, signal) => {
        for (const value of [
          message(1, 'Old failed answer.', 1),
          message(2, '', 3),
          message(3, 'Current', 3),
          message(4, 'Current attempt.', 3),
        ]) {
          await received(value);
          seen.push(snapshot()?.preview ?? '');
        }
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new ClientError('request_cancelled', 'Stopped.')),
            { once: true },
          );
        });
      },
    );
    await start();
    await vi.waitFor(() => expect(snapshot()?.last_event_id).toBe(4));
    expect(seen).toEqual(['', '', 'Current', 'Current attempt.']);
    expect(snapshot()?.attempt).toBe(3);
  });
});
