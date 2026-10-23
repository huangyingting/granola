import {
  compareUpdateVersions,
  desktopUpdateStateSchema,
  updateSessionInspectionSchema,
  type DesktopUpdateCommand,
  type DesktopUpdateState,
  type UpdateFeed,
} from '@windows-ai-notes/contracts/updates';
import { LocalError } from '@windows-ai-notes/local';
import type {
  ReadyUpdate,
  RecoveredUpdates,
  UpdateDownloads,
} from './update-downloads.js';

type Downloads = Pick<UpdateDownloads, 'check' | 'download' | 'recover'>;
interface Operation {
  abort: AbortController;
  done: Promise<void>;
}

export class DesktopUpdateController {
  private downloads: Downloads | null = null;
  private feed: UpdateFeed | null = null;
  private ready: ReadyUpdate | null = null;
  private cache: DesktopUpdateState['cache'] = null;
  private inspection: DesktopUpdateState['inspection'] = null;
  private phase: DesktopUpdateState['phase'] = 'initializing';
  private error: DesktopUpdateState['error'] = null;
  private revision = 0;
  private active: Operation | null = null;
  private started = false;
  private closed = false;
  private claimed = false;

  constructor(
    private readonly installedVersion: string,
    private readonly load: () => Promise<Downloads | null>,
    private readonly observe: (state: DesktopUpdateState) => void,
    private readonly inspect?: (
      signal: AbortSignal,
    ) => Promise<NonNullable<DesktopUpdateState['inspection']>>,
  ) {}

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.begin('initializing', (signal) => this.initialize(signal));
  }

  snapshot(): DesktopUpdateState {
    const feed = this.feed ?? this.ready?.feed;
    return desktopUpdateStateSchema.parse({
      version: 1,
      revision: this.revision,
      installed_version: this.installedVersion,
      phase: this.phase,
      available_version: feed?.application_version ?? null,
      download_bytes: feed?.bytes ?? null,
      can_check:
        !this.closed &&
        !this.claimed &&
        !this.active &&
        this.phase !== 'disabled',
      can_download:
        !this.closed &&
        !this.claimed &&
        !this.active &&
        !!this.feed &&
        !this.hasReadyFeed(),
      can_cancel:
        !this.closed && !!this.active && !this.active.abort.signal.aborted,
      can_inspect:
        !this.closed && !this.claimed && !this.active && !!this.inspect,
      inspection: this.inspection,
      installation_enabled: false,
      cache: this.cache,
      error: this.error,
    });
  }

  execute(command: DesktopUpdateCommand): DesktopUpdateState {
    if (this.closed)
      throw new LocalError('update_closed', 'The update service is closing.');
    if (command.operation === 'getState') return this.snapshot();
    if (this.claimed)
      throw new LocalError(
        'update_activation_started',
        'Main owns this update handoff. Close and reopen the app before another attempt.',
      );
    if (command.operation === 'cancel') {
      if (!this.active || this.active.abort.signal.aborted)
        throw new LocalError(
          'update_not_running',
          'There is no cancellable update operation.',
        );
      this.phase = 'cancelling';
      this.active.abort.abort();
      this.publish();
      return this.snapshot();
    }
    if (this.active)
      throw new LocalError(
        'update_busy',
        'Wait for the current update operation to finish.',
      );
    if (command.operation === 'inspect') {
      const inspect = this.inspect;
      if (!inspect)
        throw new LocalError(
          'update_inspection_disabled',
          'Recovery inspection requires a complete Windows application package.',
        );
      const previous = { phase: this.phase, error: this.error };
      this.begin(
        'inspecting',
        async (signal) => {
          const report = updateSessionInspectionSchema.parse(
            await inspect(signal),
          );
          signal.throwIfAborted();
          this.inspection = report;
          this.phase = previous.phase;
          this.error = previous.error;
        },
        previous,
      );
      return this.snapshot();
    }
    if (this.phase === 'disabled')
      throw new LocalError(
        'update_disabled',
        'This application package does not have an enabled update policy.',
      );
    if (command.operation === 'check')
      this.begin('checking', async (signal) => {
        if (!this.downloads) await this.initialize(signal);
        signal.throwIfAborted();
        if (!this.downloads) return;
        if (this.phase !== 'checking') {
          this.phase = 'checking';
          this.publish();
        }
        const feed = await this.downloads.check(signal);
        signal.throwIfAborted();
        this.feed =
          this.ready &&
          (!feed ||
            compareUpdateVersions(
              this.ready.feed.application_version,
              feed.application_version,
            ) > 0)
            ? this.ready.feed
            : feed;
        this.phase = this.hasReadyFeed()
          ? 'ready'
          : this.feed
            ? 'available'
            : 'current';
      });
    else {
      const feed = this.feed;
      const downloads = this.downloads;
      if (!feed || !downloads || this.hasReadyFeed())
        throw new LocalError(
          'update_not_available',
          'Check for an available update before downloading.',
        );
      this.begin('downloading', async (signal) => {
        const ready = await downloads.download(feed, signal);
        signal.throwIfAborted();
        this.ready = ready;
        this.phase = 'ready';
      });
    }
    return this.snapshot();
  }

  async close() {
    this.closed = true;
    const active = this.active;
    active?.abort.abort();
    await active?.done;
  }

  claimReady(): ReadyUpdate {
    if (
      this.closed ||
      this.claimed ||
      this.active ||
      this.phase !== 'ready' ||
      !this.ready ||
      !this.hasReadyFeed()
    )
      throw new LocalError(
        'update_not_ready',
        'Main requires an idle, verified current update candidate.',
      );
    const candidate = structuredClone(this.ready);
    this.claimed = true;
    this.phase = 'preparing';
    this.error = null;
    this.publish();
    return candidate;
  }

  activationFailed(error: NonNullable<DesktopUpdateState['error']>): void {
    if (!this.claimed)
      throw new LocalError(
        'update_activation_state',
        'No Main-owned update candidate can report an activation failure.',
      );
    this.phase = 'failed';
    this.error = error;
    this.publish();
  }

  private async initialize(signal: AbortSignal) {
    const downloads = await this.load();
    signal.throwIfAborted();
    this.downloads = downloads;
    if (!downloads) {
      this.phase = 'disabled';
      return;
    }
    this.phase = 'recovering';
    this.publish();
    const recovered: RecoveredUpdates = await downloads.recover(signal);
    signal.throwIfAborted();
    this.ready = recovered.ready;
    this.feed = recovered.ready?.feed ?? null;
    this.cache = {
      removed: recovered.removed,
      rejected: recovered.rejected,
      incomplete: recovered.incomplete,
    };
    this.phase = this.ready ? 'ready' : 'idle';
  }

  private hasReadyFeed() {
    return (
      !!this.feed &&
      !!this.ready &&
      this.feed.application_version === this.ready.feed.application_version &&
      this.feed.sha512 === this.ready.feed.sha512 &&
      this.feed.bytes === this.ready.feed.bytes
    );
  }

  private begin(
    phase: DesktopUpdateState['phase'],
    task: (signal: AbortSignal) => Promise<void>,
    resume?: Pick<DesktopUpdateState, 'phase' | 'error'>,
  ) {
    const active: Operation = {
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = active;
    this.phase = phase;
    this.error = null;
    active.done = Promise.resolve().then(async () => {
      try {
        active.abort.signal.throwIfAborted();
        await task(active.abort.signal);
      } catch (error) {
        if (active.abort.signal.aborted) {
          this.phase = resume?.phase ?? 'cancelled';
          this.error = resume?.error ?? null;
        } else {
          const failure =
            error instanceof LocalError
              ? { code: error.code, message: error.message }
              : {
                  code: 'update_operation_failed',
                  message:
                    'The update operation could not be completed. Your notes were not changed.',
                };
          console.error(
            JSON.stringify({
              code: failure.code,
              kind: error instanceof Error ? error.name : 'unknown',
            }),
          );
          this.phase = resume?.phase ?? 'failed';
          this.error = failure;
        }
      } finally {
        this.active = null;
        if (!this.closed) this.publish();
      }
    });
    this.publish();
  }

  private publish() {
    if (this.closed) return;
    this.revision++;
    try {
      this.observe(this.snapshot());
    } catch (error) {
      console.error(
        JSON.stringify({
          code: 'update_notification_failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
}
