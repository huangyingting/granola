import { PendingWork } from '@windows-ai-notes/client/lifecycle';
import { LocalError } from '@windows-ai-notes/local';
import type { ReadyUpdate } from './update-downloads.js';
import type { HeldUpdateRuntime } from './update-runtime.js';
import type { PreparedUpdateWorker } from './update-worker.js';

type Phase =
  | 'idle'
  | 'preparing'
  | 'flushing'
  | 'draining'
  | 'worker'
  | 'committing'
  | 'handoff'
  | 'failed';

export class DesktopUpdateActivation {
  private phase: Phase = 'idle';
  private candidate: ReadyUpdate | null = null;
  private guard: HeldUpdateRuntime | null = null;
  private worker: PreparedUpdateWorker | null = null;
  private releasing: Promise<void> | null = null;
  private completion: Promise<never> | null = null;
  private readonly cancellation = new AbortController();
  private readonly work = new PendingWork();

  constructor(
    private readonly services: {
      hold: (
        candidate: ReadyUpdate,
        signal: AbortSignal,
      ) => Promise<HeldUpdateRuntime>;
      prepare: (
        guard: HeldUpdateRuntime,
        candidate: ReadyUpdate,
        signal: AbortSignal,
      ) => Promise<PreparedUpdateWorker>;
      requestFlush: () => void;
      drain: () => Promise<void>;
      exit: () => void;
      stopWorker: () => Promise<void>;
      allowsExit: () => boolean;
    },
  ) {}

  get blocksExit(): boolean {
    return (
      this.guard !== null ||
      ['preparing', 'flushing', 'draining', 'worker', 'committing'].includes(
        this.phase,
      ) ||
      (this.phase === 'handoff' && !this.services.allowsExit())
    );
  }

  start(candidate: ReadyUpdate): Promise<void> {
    if (this.phase !== 'idle')
      return Promise.reject(
        new LocalError(
          'update_activation_started',
          'This Main process has already attempted an update handoff.',
        ),
      );
    this.phase = 'preparing';
    this.candidate = candidate;
    return this.work.track(
      Promise.resolve().then(async () => {
        try {
          const signal = this.cancellation.signal;
          signal.throwIfAborted();
          this.guard = await this.services.hold(candidate, signal);
          signal.throwIfAborted();
          this.guard.assertHeld();
          this.phase = 'flushing';
          this.services.requestFlush();
        } catch (error) {
          try {
            await this.cleanup();
          } finally {
            this.phase = 'failed';
          }
          throw error;
        }
      }),
    );
  }

  cancelPreparation(): void {
    if (this.phase === 'preparing') this.abort();
  }

  completeFlush(): Promise<never> {
    if (this.completion) return this.completion;
    const candidate = this.candidate;
    const guard = this.guard;
    if (this.phase !== 'flushing' || !candidate || !guard)
      return Promise.reject(
        new LocalError(
          'update_activation_state',
          'No protected update is awaiting editor flush.',
        ),
      );
    this.phase = 'draining';
    this.completion = this.work.track(
      Promise.resolve().then(async () => {
        try {
          const signal = this.cancellation.signal;
          signal.throwIfAborted();
          guard.assertHeld();
          await this.services.drain();
          signal.throwIfAborted();
          guard.assertHeld();
          this.phase = 'worker';
          this.worker = await this.services.prepare(guard, candidate, signal);
          this.guard = null;
          signal.throwIfAborted();
          this.phase = 'committing';
          await this.worker.commit();
          signal.throwIfAborted();
          this.worker.releaseForExit();
          this.phase = 'handoff';
          this.services.exit();
          // Exit is not confirmed by a void Electron API return.
          throw await this.worker.failed;
        } catch (error) {
          try {
            await this.cleanup();
          } finally {
            this.phase = 'failed';
          }
          throw error;
        }
      }),
    );
    return this.completion;
  }

  async stopForExit(): Promise<void> {
    if (this.phase === 'handoff' && this.services.allowsExit()) return;
    this.abort();
    await Promise.all([this.services.stopWorker(), this.work.drain()]);
    await this.releaseGuard();
  }

  private abort(): void {
    this.cancellation.abort(
      new LocalError(
        'update_activation_cancelled',
        'The update handoff was cancelled. No later Main exit may start this installer.',
      ),
    );
  }

  private async cleanup(): Promise<void> {
    await Promise.all([
      this.worker?.cancel(),
      this.services.stopWorker(),
      this.releaseGuard(),
    ]);
  }

  private releaseGuard(): Promise<void> {
    if (this.releasing) return this.releasing;
    const guard = this.guard;
    if (!guard) return Promise.resolve();
    this.releasing = Promise.resolve()
      .then(() => guard.release())
      .finally(() => {
        this.guard = null;
        this.releasing = null;
      });
    return this.releasing;
  }
}
