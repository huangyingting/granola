import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { LocalStore } from '@windows-ai-notes/local';
import {
  CHAT_VERSION,
  chatCapabilitiesSchema,
  chatEventStateSchema,
  chatPreviewSchema,
  chatWatchSchema,
  type ChatEvent,
  type ChatTurn,
  type ChatWatch,
} from '@windows-ai-notes/contracts/questions';
import { ApiClient, ClientError } from './http.js';
import type { DesktopDelivery, DeliveryHandle } from './delivery.js';
import { PendingWork } from './lifecycle.js';

type Owner = { profile: string; api: ApiClient; authorize: () => void };
type Subscription = Owner & {
  scope: number;
  abort: AbortController;
  state: ChatWatch;
  floor: number;
  terminal: boolean;
  target: number;
  anchor: { seq: number; attempt: number; text: string } | null;
  validated: boolean;
  delivery: DeliveryHandle | undefined;
};
type Hooks = {
  delivery?: DesktopDelivery;
  owner: (scope: number, id: string, thread: string) => Owner;
  reads: Set<AbortController>;
  changed: () => void;
  cache: (profile: string, id: string, turn: ChatTurn) => ChatTurn;
  failed: (
    error: unknown,
    owner: Owner,
    id: string,
    thread: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
};
const name = (thread: string, turn: string) =>
  `chat-thread:${thread}:events:${turn}`;
const active = (turn: ChatTurn) => ['queued', 'running'].includes(turn.state);
const invalid = () =>
  new ClientError(
    'invalid_event_stream',
    'The service returned inconsistent question progress.',
  );
const progressSchema = z.union([
  chatPreviewSchema,
  z.strictObject({
    stage: z.literal('preparing'),
    attempt: z.number().int().positive().max(2_147_483_647),
  }),
]);

export class ChatEvents {
  private current: Subscription | null = null;
  private readonly work = new PendingWork();
  private closed = false;
  constructor(
    private readonly local: LocalStore,
    private readonly hooks: Hooks,
  ) {}
  snapshot(profile: string, id: string | null) {
    const current = this.current;
    return current?.validated &&
      !current.abort.signal.aborted &&
      current.profile === profile &&
      current.state.document_id === id
      ? current.state
      : null;
  }
  stop(turn?: string) {
    if (turn && this.current?.state.turn_id !== turn) return;
    if (this.current) {
      this.hooks.delivery?.cancel(this.current.delivery);
      this.current.abort.abort();
      this.hooks.reads.delete(this.current.abort);
    }
    this.current = null;
  }
  async close() {
    this.closed = true;
    this.stop();
    await this.work.drain();
  }
  clear(profile: string, id: string, thread: string, turn: string) {
    this.stop(turn);
    this.local.deleteArtifact(profile, id, name(thread, turn));
  }
  stopThread(profile: string, id: string, thread: string) {
    const current = this.current;
    if (
      current?.profile === profile &&
      current.state.document_id === id &&
      current.state.thread_id === thread
    )
      this.stop(current.state.turn_id);
  }
  settled(profile: string, id: string, turn: ChatTurn) {
    if (active(turn)) return;
    this.local.deleteArtifact(profile, id, name(turn.thread_id, turn.id));
    const current = this.current;
    if (
      current?.profile === profile &&
      current.state.document_id === id &&
      current.state.thread_id === turn.thread_id &&
      current.state.turn_id === turn.id
    ) {
      current.terminal = true;
      current.target = Math.max(current.target, turn.last_event_id);
      current.state.preview = '';
      this.hooks.delivery?.cancel(current.delivery, 'superseded');
    }
  }
  private authorize(current: Subscription) {
    current.abort.signal.throwIfAborted();
    if (this.current !== current)
      throw new ClientError(
        'request_cancelled',
        'Question updates were replaced.',
      );
    current.authorize();
  }
  private save(current: Subscription) {
    this.authorize(current);
    const state = chatWatchSchema.parse(current.state);
    if (current.terminal)
      this.local.deleteArtifact(
        current.profile,
        state.document_id,
        name(state.thread_id, state.turn_id),
      );
    else
      this.local.putArtifact(
        current.profile,
        state.document_id,
        name(state.thread_id, state.turn_id),
        state,
      );
    this.hooks.changed();
  }
  start(scope: number, id: string, thread: string, turn: string) {
    if (this.closed)
      return Promise.reject(
        new ClientError('workspace_closed', 'Question updates have closed.'),
      );
    return this.work.track(this.open(scope, id, thread, turn));
  }
  private async open(scope: number, id: string, thread: string, turn: string) {
    const owner = this.hooks.owner(scope, id, thread);
    owner.authorize();
    const previous = this.current;
    if (
      previous?.scope === scope &&
      previous.profile === owner.profile &&
      previous.state.document_id === id &&
      previous.state.thread_id === thread &&
      previous.state.turn_id === turn &&
      previous.state.status !== 'paused'
    )
      return;
    this.stop();
    if (this.hooks.reads.size >= 4)
      throw new ClientError(
        'request_busy',
        'Wait for the current account or meeting requests to finish.',
      );
    const saved = this.local.getArtifact(
      owner.profile,
      id,
      name(thread, turn),
      chatWatchSchema,
    );
    if (
      saved &&
      (saved.document_id !== id ||
        saved.thread_id !== thread ||
        saved.turn_id !== turn)
    )
      throw invalid();
    const current: Subscription = {
      ...owner,
      scope,
      abort: new AbortController(),
      state: saved
        ? { ...saved, status: 'connecting', error: null }
        : {
            document_id: id,
            thread_id: thread,
            turn_id: turn,
            last_event_id: 0,
            attempt: 0,
            preview: '',
            status: 'connecting',
            error: null,
          },
      floor: 0,
      terminal: false,
      target: 0,
      anchor: null,
      validated: false,
      delivery: this.hooks.delivery?.begin({
        scope,
        document: id,
        kind: 'chat_preview',
        operation_id: turn,
      }),
    };
    this.current = current;
    this.hooks.reads.add(current.abort);
    try {
      const capability = await current.api.request(
        '/v1/chat-capabilities',
        chatCapabilitiesSchema,
        { signal: current.abort.signal },
      );
      this.authorize(current);
      if (capability.questions !== CHAT_VERSION)
        throw new ClientError(
          'unsupported_chat_version',
          'The connected service does not support this question stream version.',
        );
      if (!(await this.reconcile(current, saved?.status === 'paused'))) return;
      current.validated = true;
      this.save(current);
    } catch (error) {
      try {
        if (current.abort.signal.aborted)
          throw new ClientError(
            'request_cancelled',
            'Question updates were stopped.',
          );
        if (this.current === current && !current.abort.signal.aborted)
          throw await this.hooks.failed(
            error,
            current,
            id,
            thread,
            current.abort.signal,
          );
        throw error;
      } finally {
        this.hooks.reads.delete(current.abort);
        if (this.current === current) this.stop(turn);
      }
    }
    void this.work.track(this.run(current)).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          code: 'chat_updates_unavailable',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
    });
  }
  private received(current: Subscription, event: ChatEvent) {
    this.authorize(current);
    const state = current.state;
    let previewReceived = false;
    if (event.event_type === 'turn.progress') {
      const progress = progressSchema.safeParse(event.payload);
      if (!progress.success) throw invalid();
      const attempt = progress.data.attempt;
      if (!current.terminal && attempt >= current.floor) {
        if (attempt < state.attempt) throw invalid();
        if (attempt > state.attempt) {
          if (this.hooks.delivery?.marker(current.delivery)) {
            this.hooks.delivery.cancel(current.delivery, 'superseded');
            current.delivery = undefined;
          }
          state.attempt = attempt;
          state.preview = '';
        }
        if ('text' in progress.data) {
          const anchor = current.anchor;
          if (
            anchor?.attempt === attempt &&
            (event.seq <= anchor.seq
              ? !anchor.text.startsWith(progress.data.text)
              : !progress.data.text.startsWith(anchor.text))
          )
            throw invalid();
          if (!progress.data.text.startsWith(state.preview)) throw invalid();
          state.preview = progress.data.text;
          previewReceived = Boolean(state.preview.trim());
        }
      }
    }
    if (
      ['answer.completed', 'turn.failed', 'turn.cancelled'].includes(
        event.event_type,
      )
    )
      state.preview = '';
    state.last_event_id = event.seq;
    state.status = 'streaming';
    state.error = null;
    if (previewReceived) this.hooks.delivery?.offer(current.delivery, 'event');
    else if (
      ['answer.completed', 'turn.failed', 'turn.cancelled'].includes(
        event.event_type,
      )
    )
      this.hooks.delivery?.cancel(current.delivery, 'superseded');
    this.save(current);
  }
  private async reconcile(current: Subscription, reset = false) {
    const state = current.state;
    const snapshot = await current.api.request(
      `/v1/chat-turns/${state.turn_id}/event-state`,
      chatEventStateSchema,
      { signal: current.abort.signal },
    );
    this.authorize(current);
    if (
      snapshot.turn.id !== state.turn_id ||
      snapshot.turn.thread_id !== state.thread_id ||
      snapshot.turn.document_id !== state.document_id ||
      snapshot.turn.last_event_id < state.last_event_id ||
      snapshot.preview_attempt < state.attempt
    )
      throw invalid();
    const turn = this.hooks.cache(
      current.profile,
      state.document_id,
      snapshot.turn,
    );
    current.floor = snapshot.preview_attempt;
    current.terminal = !active(turn);
    current.target = turn.last_event_id;
    current.anchor = snapshot.preview
      ? { seq: snapshot.turn.last_event_id, ...snapshot.preview }
      : null;
    if (
      !current.terminal &&
      state.attempt === snapshot.preview_attempt &&
      state.preview &&
      !snapshot.preview?.text.startsWith(state.preview)
    )
      throw invalid();
    if (
      current.terminal ||
      state.attempt !== snapshot.preview_attempt ||
      !snapshot.preview?.text.startsWith(state.preview)
    ) {
      if (this.hooks.delivery?.marker(current.delivery)) {
        this.hooks.delivery.cancel(current.delivery, 'superseded');
        current.delivery = undefined;
      }
      state.preview = '';
    }
    state.attempt = snapshot.preview_attempt;
    if (reset) {
      state.last_event_id = snapshot.turn.last_event_id;
      state.preview = current.terminal ? '' : (snapshot.preview?.text ?? '');
      if (state.preview.trim())
        this.hooks.delivery?.offer(current.delivery, 'snapshot');
      this.save(current);
    }
    if (current.terminal && state.last_event_id >= current.target) {
      this.local.deleteArtifact(
        current.profile,
        state.document_id,
        name(state.thread_id, state.turn_id),
      );
      this.stop(state.turn_id);
      this.hooks.changed();
      return false;
    }
    return true;
  }
  private async run(current: Subscription) {
    let failures = 0;
    try {
      while (!current.abort.signal.aborted) {
        let retryAfter = 0;
        try {
          this.authorize(current);
          current.state.status = 'streaming';
          this.hooks.changed();
          const before = current.state.last_event_id,
            opened = Date.now();
          await current.api.chatEvents(
            current.state.turn_id,
            before,
            async (event) => {
              this.received(current, event);
              failures = 0;
            },
            current.abort.signal,
          );
          if (!(await this.reconcile(current))) return;
          if (
            before === current.state.last_event_id &&
            Date.now() - opened < 5000
          )
            failures++;
          else failures = 0;
          if (failures >= 5)
            throw new ClientError(
              'chat_updates_paused',
              'The service repeatedly closed question updates. Reconnect updates to continue.',
            );
        } catch (error) {
          if (current.abort.signal.aborted) return;
          if (
            error instanceof ClientError &&
            error.code === 'event_cursor_expired'
          ) {
            const before = current.state.last_event_id;
            if (!(await this.reconcile(current, true))) return;
            failures =
              before === current.state.last_event_id ? failures + 1 : 0;
            if (failures >= 5) throw error;
          } else if (
            error instanceof ClientError &&
            error.code === 'event_connection_expired'
          )
            failures = 0;
          else {
            if (
              !(error instanceof ClientError) ||
              !error.retryable ||
              ++failures >= 5
            )
              throw error;
            current.state.error = error.message;
            retryAfter = error.retryAfterSeconds * 1000;
          }
        }
        current.state.status = 'reconnecting';
        this.save(current);
        await delay(
          Math.max(retryAfter, Math.min(30_000, 1000 * 2 ** failures)),
          undefined,
          {
            signal: current.abort.signal,
          },
        );
      }
    } catch (error) {
      if (!current.abort.signal.aborted && this.current === current) {
        try {
          const failure = await this.hooks.failed(
            error,
            current,
            current.state.document_id,
            current.state.thread_id,
            current.abort.signal,
          );
          if (current.abort.signal.aborted || this.current !== current) return;
          this.authorize(current);
          if (!(failure instanceof ClientError))
            console.error(JSON.stringify({ code: 'chat_updates_paused' }));
          this.hooks.delivery?.cancel(current.delivery);
          current.delivery = undefined;
          current.state.preview = '';
          current.state.status = 'paused';
          current.state.error =
            failure instanceof ClientError
              ? failure.message
              : 'Question updates failed. Refresh or reconnect to recover saved progress.';
          this.save(current);
        } catch {
          this.stop(current.state.turn_id);
          console.error(JSON.stringify({ code: 'chat_updates_unavailable' }));
          this.hooks.changed();
        }
      }
    } finally {
      this.hooks.reads.delete(current.abort);
    }
  }
}
