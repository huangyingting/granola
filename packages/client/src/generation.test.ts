import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalStore } from '@windows-ai-notes/local';
import { jobSchema, jobEventSchema } from '@windows-ai-notes/contracts/server';
import { summaryWatchSchema } from '@windows-ai-notes/contracts/generation';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import { ApiClient, ClientError } from './http.js';
import { SummaryEvents } from './generation.js';
import { DesktopDelivery } from './delivery.js';

vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: vi.fn(async () => undefined),
}));

let local: LocalStore,
  directory: string,
  key: Buffer,
  api: ApiClient,
  events: SummaryEvents,
  delivery: DesktopDelivery;
let id: string, job: string, records: Record<string, unknown>[];
const profile = 'summary-delivery-fixture';
beforeEach(() => {
  vi.mocked(delay).mockClear();
  directory = mkdtempSync(join(tmpdir(), 'notes-summary-delivery-'));
  key = randomBytes(32);
  local = new LocalStore(join(directory, 'notes.sqlite'), key);
  id = randomUUID();
  local.applyRemote(profile, {
    id,
    owner_id: randomUUID(),
    workspace_id: randomUUID(),
    title: 'Synthetic summary source',
    notes: 'Private synthetic notes.',
    content: richTextFromPlainText('Private synthetic notes.'),
    tags: [],
    revision: 1,
    transcript_revision: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  job = randomUUID();
  records = [];
  delivery = new DesktopDelivery(
    new Writable({
      write(chunk, _encoding, done) {
        records.push(JSON.parse(String(chunk)));
        done();
      },
    }),
  );
  const remote = jobSchema.parse({
    id: job,
    document_id: id,
    kind: 'summary',
    state: 'running',
    attempt: 1,
    input_stale: false,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
  });
  api = new ApiClient('https://fixture.example', async () => ({}));
  vi.stubGlobal('fetch', async (url: string | URL | Request) =>
    Response.json(
      String(url).endsWith('/event-state')
        ? { job: remote, last_event_id: 0, completed_stages: 0 }
        : remote,
    ),
  );
  vi.spyOn(api, 'events').mockImplementation(
    async (_id, _after, _received, signal) =>
      new Promise<number>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new ClientError('request_cancelled', 'Stopped.')),
          { once: true },
        ),
      ),
  );
  events = new SummaryEvents(local, {
    delivery,
    owner: () => ({
      profile,
      api,
      authorize: () => {
        local.get(profile, id);
      },
    }),
    changed: () => {},
    reads: new Set(),
    cacheJob: () => {},
    revoked: () => {},
    synchronize: async () => {},
  });
});
afterEach(async () => {
  await events.close();
  delivery.close();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  local.close();
  key.fill(0);
  rmSync(directory, { recursive: true, force: true });
});
it('drains a cancelled summary stream before closing and does not allow it to restart', async () => {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(api.events).mockImplementation(
    async (_id, _after, _received, abort) => {
      signal = abort;
      await pending;
      abort.throwIfAborted();
      return 0;
    },
  );
  await events.start(1, id, job);
  let closed = false;
  const closing = events.close().then(() => {
    closed = true;
  });
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await closing;
  await expect(events.start(1, id, job)).rejects.toMatchObject({
    code: 'workspace_closed',
  });
});
it('honors the service retry floor and adds jitter when reconnecting a summary read', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.mocked(api.events).mockRejectedValueOnce(
    new ClientError(
      'rate_limited',
      'Wait before subscribing again.',
      429,
      true,
      9,
    ),
  );
  await events.start(1, id, job);
  await vi.waitFor(() => expect(api.events).toHaveBeenCalledTimes(2));
  expect(vi.mocked(delay).mock.calls[0]?.[0]).toBe(9500);
});
const message = (seq: number, text: string, attempt = 1) =>
  jobEventSchema.parse({
    job_id: job,
    seq,
    event_type: 'job.progress',
    schema_version: 1,
    created_at: new Date().toISOString(),
    payload: { stage: 'summary_preview', version: 1, attempt, text },
  });
it('does not label restored preview or unrelated progress as a new preview receipt', async () => {
  local.putArtifact(profile, id, 'summary-events', {
    document_id: id,
    job_id: job,
    last_event_id: 0,
    attempt: 1,
    preview: 'Cached preview.',
    completed_stages: 0,
    phase: 'generate',
    status: 'paused',
    error: null,
  });
  await events.start(1, id, job);
  await vi.waitFor(() => expect(api.events).toHaveBeenCalled());
  const receive = vi.mocked(api.events).mock.calls[0]![2];
  await receive(
    jobEventSchema.parse({
      ...message(1, ''),
      payload: { stage: 'summary_extract' },
    }),
  );
  expect(delivery.markers(1, id)).toEqual([]);
  await receive(message(2, 'Cached preview. Fresh suffix.'));
  const marker = delivery.markers(1, id)[0]!;
  expect(marker).toMatchObject({ kind: 'summary_preview', operation_id: job });
  expect(
    local.getArtifact(profile, id, 'summary-events', summaryWatchSchema),
  ).not.toHaveProperty('presentation');
  expect(delivery.present(1, id, marker.token)).toBe(true);
  expect(records.at(-1)).toMatchObject({
    outcome: 'acknowledged',
    origin: 'event',
  });
  expect(JSON.stringify(records)).not.toContain('Cached preview');
});
it('supersedes the token on attempt rollover and never attributes the replacement text to the older receipt', async () => {
  await events.start(1, id, job);
  await vi.waitFor(() => expect(api.events).toHaveBeenCalled());
  const receive = vi.mocked(api.events).mock.calls[0]![2];
  await receive(message(1, ' '));
  expect(delivery.markers(1, id)).toEqual([]);
  await receive(message(2, ' First attempt.'));
  const marker = delivery.markers(1, id)[0]!;
  await receive(message(3, 'Replacement attempt.', 2));
  expect(delivery.present(1, id, marker.token)).toBe(false);
  expect(delivery.markers(1, id)).toEqual([]);
  expect(
    records.filter((value) => value.code === 'desktop_delivery_received'),
  ).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({
    outcome: 'superseded',
    presentation_ack_after_receive_ms: null,
  });
});
