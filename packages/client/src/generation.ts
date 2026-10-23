import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { LocalStore } from '@windows-ai-notes/local';
import {
  jobSchema,
  type jobEventSchema,
} from '@windows-ai-notes/contracts/server';
import {
  jobEventStateSchema,
  summaryPreviewSchema,
  summaryWatchSchema,
  type SummaryWatch,
} from '@windows-ai-notes/contracts/generation';
import { ApiClient, ClientError } from './http.js';
import type { DesktopDelivery, DeliveryHandle } from './delivery.js';
import { PendingWork } from './lifecycle.js';
import { retryDelay } from './retry.js';

type Owner = { profile: string; api: ApiClient; authorize: () => void };
type Subscription = Owner & {
  scope: number;
  id: string;
  job: string;
  abort: AbortController;
  state: SummaryWatch;
  validated: boolean;
  delivery: DeliveryHandle | undefined;
};
type Hooks = {
  delivery?: DesktopDelivery;
  owner: (scope: number) => Owner;
  changed: () => void;
  reads: Set<AbortController>;
  cacheJob: (
    profile: string,
    id: string,
    job: z.infer<typeof jobSchema>,
  ) => void;
  revoked: (error: unknown, profile: string, api: ApiClient) => void;
  synchronize: () => Promise<void>;
};
const active = (job: z.infer<typeof jobSchema>) =>
  ['queued', 'running', 'retry_wait'].includes(job.state);
const invalid = () =>
  new ClientError(
    'invalid_event_stream',
    'The service returned inconsistent generation progress.',
  );

export class SummaryEvents {
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
      current.id === id
      ? current.state
      : null;
  }
  stop(job?: string) {
    if (job && this.current?.job !== job) return;
    this.hooks.delivery?.cancel(this.current?.delivery);
    this.current?.abort.abort();
    this.current = null;
  }
  async close() {
    this.closed = true;
    this.stop();
    await this.work.drain();
  }
  private authorize(current: Subscription) {
    current.abort.signal.throwIfAborted();
    if (this.current !== current)
      throw new ClientError(
        'request_cancelled',
        'Generation updates were replaced.',
      );
    current.authorize();
    this.local.get(current.profile, current.id);
  }
  private save(current: Subscription) {
    this.authorize(current);
    this.local.putArtifact(
      current.profile,
      current.id,
      'summary-events',
      summaryWatchSchema.parse(current.state),
    );
    this.hooks.changed();
  }
  start(scope: number, id: string, job: string) {
    if (this.closed)
      return Promise.reject(
        new ClientError('workspace_closed', 'Generation updates have closed.'),
      );
    return this.work.track(this.open(scope, id, job));
  }
  private async open(scope: number, id: string, job: string) {
    const owner = this.hooks.owner(scope);
    owner.authorize();
    this.local.get(owner.profile, id);
    if (
      this.current?.job === job &&
      this.current.profile === owner.profile &&
      this.current.scope === scope &&
      this.current.state.status !== 'paused'
    )
      return;
    this.stop();
    if (this.hooks.reads.size >= 4)
      throw new ClientError(
        'request_busy',
        'Wait for the current meeting requests to finish.',
      );
    const saved = this.local.getArtifact(
      owner.profile,
      id,
      'summary-events',
      summaryWatchSchema,
    );
    const state: SummaryWatch =
      saved?.job_id === job && saved.document_id === id
        ? { ...saved, status: 'connecting', error: null }
        : {
            document_id: id,
            job_id: job,
            last_event_id: 0,
            attempt: 0,
            preview: '',
            completed_stages: 0,
            phase: null,
            status: 'connecting',
            error: null,
          };
    const current: Subscription = {
      ...owner,
      scope,
      id,
      job,
      abort: new AbortController(),
      state,
      validated: false,
      delivery: this.hooks.delivery?.begin({
        scope,
        document: id,
        kind: 'summary_preview',
        operation_id: job,
      }),
    };
    this.current = current;
    this.hooks.reads.add(current.abort);
    try {
      const remote = await owner.api.request(`/v1/jobs/${job}`, jobSchema, {
        signal: current.abort.signal,
      });
      this.authorize(current);
      this.acceptJob(current, remote);
      if (!active(remote)) {
        this.local.deleteArtifact(owner.profile, id, 'summary-events');
        this.hooks.reads.delete(current.abort);
        this.stop(job);
        return;
      }
      current.validated = true;
      this.save(current);
    } catch (error) {
      this.hooks.reads.delete(current.abort);
      if (this.current === current) this.stop(job);
      throw error;
    }
    void this.work.track(this.run(current)).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          code: 'generation_updates_unavailable',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
    });
  }
  private acceptJob(current: Subscription, job: z.infer<typeof jobSchema>) {
    if (
      job.id !== current.job ||
      job.document_id !== current.id ||
      job.kind !== 'summary'
    )
      throw invalid();
    this.hooks.cacheJob(current.profile, current.id, job);
  }
  private received(
    current: Subscription,
    event: z.infer<typeof jobEventSchema>,
  ) {
    this.authorize(current);
    const state = current.state;
    let previewReceived = false;
    if (event.event_type === 'job.progress') {
      const stage = z.object({ stage: z.string() }).safeParse(event.payload);
      if (stage.success && stage.data.stage === 'summary_preview') {
        const preview = summaryPreviewSchema.safeParse(event.payload);
        if (!preview.success || preview.data.attempt < state.attempt)
          throw invalid();
        if (preview.data.attempt > state.attempt) {
          if (this.hooks.delivery?.marker(current.delivery)) {
            this.hooks.delivery.cancel(current.delivery, 'superseded');
            current.delivery = undefined;
          }
          state.attempt = preview.data.attempt;
          state.preview = '';
        }
        if (!preview.data.text.startsWith(state.preview)) throw invalid();
        state.preview = preview.data.text;
        previewReceived = Boolean(state.preview.trim());
        state.phase = 'generate';
      } else if (stage.success) {
        const phase = /^summary_(extract|merge|generate)$/u.exec(
          stage.data.stage,
        )?.[1];
        if (phase === 'extract' || phase === 'merge' || phase === 'generate') {
          state.phase = phase;
          state.completed_stages++;
        }
      }
    }
    if (
      ['output.completed', 'job.failed', 'job.cancelled'].includes(
        event.event_type,
      )
    ) {
      state.preview = '';
      state.phase = null;
    }
    state.last_event_id = event.seq;
    state.status = 'streaming';
    state.error = null;
    if (previewReceived) this.hooks.delivery?.offer(current.delivery, 'event');
    else if (
      ['output.completed', 'job.failed', 'job.cancelled'].includes(
        event.event_type,
      )
    )
      this.hooks.delivery?.cancel(current.delivery, 'superseded');
    this.save(current);
  }
  private async reconcile(current: Subscription, reset = false) {
    const snapshot = await current.api.request(
      `/v1/jobs/${current.job}/event-state`,
      jobEventStateSchema,
      { signal: current.abort.signal },
    );
    this.authorize(current);
    this.acceptJob(current, snapshot.job);
    if (reset) {
      if (this.hooks.delivery?.marker(current.delivery)) {
        this.hooks.delivery.cancel(current.delivery, 'superseded');
        current.delivery = undefined;
      }
      current.state.last_event_id = snapshot.last_event_id;
      current.state.completed_stages = snapshot.completed_stages;
      current.state.preview = '';
      current.state.phase = null;
      this.save(current);
    }
    if (!active(snapshot.job)) {
      current.state.preview = '';
      this.local.deleteArtifact(current.profile, current.id, 'summary-events');
      this.stop(current.job);
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
          const before = current.state.last_event_id;
          const opened = Date.now();
          await current.api.events(
            current.job,
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
              'generation_updates_paused',
              'The service repeatedly closed generation updates. Refresh or reconnect to continue.',
            );
        } catch (error) {
          if (current.abort.signal.aborted) return;
          if (
            error instanceof ClientError &&
            error.code === 'event_cursor_expired'
          ) {
            if (!(await this.reconcile(current, true))) return;
            failures = 0;
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
        this.authorize(current);
        current.state.status = 'reconnecting';
        this.hooks.changed();
        await delay(
          retryDelay(Math.min(30_000, 1000 * 2 ** failures), retryAfter),
          undefined,
          { signal: current.abort.signal },
        );
      }
    } catch (error) {
      if (!current.abort.signal.aborted && this.current === current) {
        try {
          if (
            error instanceof ClientError &&
            ['job_not_found', 'document_not_found'].includes(error.code)
          )
            await this.hooks.synchronize();
          this.hooks.revoked(error, current.profile, current.api);
          this.authorize(current);
          this.hooks.delivery?.cancel(current.delivery);
          current.delivery = undefined;
          current.state.preview = '';
          current.state.status = 'paused';
          current.state.error =
            error instanceof ClientError
              ? error.message
              : 'Generation updates failed. Refresh the summary to recover saved progress.';
          this.save(current);
        } catch (failure) {
          this.stop(current.job);
          console.error(
            JSON.stringify({ code: 'generation_updates_unavailable' }),
          );
          this.hooks.changed();
        }
      }
    } finally {
      this.hooks.reads.delete(current.abort);
    }
  }
}
