import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';
import { FrameDecoder, encodeJsonFrame } from '@windows-ai-notes/contracts';
import {
  compareUpdateVersions,
  updateHandoffDecisionSchema,
  updateParentCommittedSchema,
  updateParentReadySchema,
  updateWorkerFailureSchema,
  updateWorkerRequestSchema,
} from '@windows-ai-notes/contracts/updates';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';
import type { HeldUpdateRuntime } from './update-runtime.js';

const candidateSchema = updateWorkerRequestSchema.omit({
  parent_pid: true,
  runtime_sha256: true,
});
type Request = ReturnType<typeof updateWorkerRequestSchema.parse>;
type Phase =
  | 'preparing'
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'released'
  | 'cancelling'
  | 'closed';
let active = false;

export interface PreparedUpdateWorker {
  readonly failed: Promise<LocalError>;
  readonly stopped: Promise<void>;
  commit(): Promise<void>;
  cancel(): Promise<void>;
  releaseForExit(): void;
}

// After the single-flight gate, this call owns the guard on both success and failure.
export async function prepareUpdateWorker(
  guard: HeldUpdateRuntime,
  candidate: unknown,
  signal?: AbortSignal,
): Promise<PreparedUpdateWorker> {
  if (active)
    throw new LocalError(
      'update_worker_busy',
      'An installation handoff is already active.',
    );
  active = true;
  let session: WorkerSession | null = null;
  let guardReleased = false;
  let settled = false;
  let exited = false;
  const release = () => {
    if (guardReleased && settled && exited) active = false;
  };
  try {
    const parsed = candidateSchema.safeParse(candidate);
    if (
      !parsed.success ||
      compareUpdateVersions(
        parsed.data.offered_version,
        parsed.data.current_version,
      ) <= 0
    )
      throw new LocalError(
        'update_worker_arguments',
        'A newer stable installer and its exact file metadata are required.',
      );
    const request = updateWorkerRequestSchema.parse({
      ...parsed.data,
      parent_pid: process.pid,
      runtime_sha256: guard.runtime.sha256,
    });
    if (
      win32.normalize(request.user_data) !== request.user_data ||
      /[:"<>|?*]/u.test(request.user_data.slice(2))
    )
      throw new LocalError(
        'update_worker_arguments',
        'The original Main user-data directory must be a canonical local path.',
      );
    for (const path of [
      request.application,
      request.installer,
      guard.runtime.executable,
    ])
      if (
        win32.normalize(path) !== path ||
        /[:"<>|?*]/u.test(path.slice(2)) ||
        !/\.exe$/iu.test(path)
      )
        throw new LocalError(
          'update_worker_arguments',
          'Canonical local executable paths are required.',
        );
    if (
      guard.identity.pid !== process.pid ||
      guard.runtime.executable !==
        win32.join(guard.runtime.directory, 'AudioHost.exe')
    )
      throw new LocalError(
        'update_parent_mismatch',
        'The runtime lease does not belong to this Main process.',
      );
    signal?.throwIfAborted();
    guard.assertHeld();
    session = new WorkerSession(guard, request, signal, () => {
      exited = true;
      release();
    });
    await session.ready;
    guard.assertHeld();
    await guard.release();
    guardReleased = true;
    session.assertPrepared();
    settled = true;
    return session;
  } catch (error) {
    try {
      if (session) await session.cancel();
      else exited = true;
    } finally {
      if (!guardReleased) {
        await guard.release();
        guardReleased = true;
      }
      settled = true;
      release();
    }
    throw error;
  }
}

class WorkerSession implements PreparedUpdateWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new FrameDecoder();
  private phase: Phase = 'preparing';
  private error: LocalError | null = null;
  private challenge: string | null = null;
  private outputBytes = 0;
  private diagnosticBytes = 0;
  private exited = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly parent: HeldUpdateRuntime['identity'];
  private resolveReady!: () => void;
  private rejectReady!: (error: LocalError) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  private resolveCommit: (() => void) | null = null;
  private rejectCommit: ((error: LocalError) => void) | null = null;
  private resolveFailure!: (error: LocalError) => void;
  readonly failed = new Promise<LocalError>((resolve) => {
    this.resolveFailure = resolve;
  });
  private resolveClosed!: () => void;
  readonly stopped = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });
  private cancelling: Promise<void> | null = null;
  private readonly abort = () =>
    this.fail(
      'update_worker_cancelled',
      'The installation handoff was cancelled.',
    );

  constructor(
    guard: HeldUpdateRuntime,
    request: Request,
    private readonly signal: AbortSignal | undefined,
    private readonly onClosed: () => void,
  ) {
    this.parent = { ...guard.identity };
    this.child = spawn(guard.runtime.executable, ['--apply-update'], {
      cwd: win32.dirname(guard.runtime.executable),
      env: audioHostEnvironment(process.env),
      detached: true,
      windowsHide: true,
      stdio: 'pipe',
    });
    const prepareTimer = this.after(60_000, () =>
      this.fail(
        'update_worker_timeout',
        'Native installer preparation timed out.',
      ),
    );
    this.child.once('error', () =>
      this.fail(
        'update_worker_unavailable',
        'The independent installer worker could not start.',
      ),
    );
    for (const stream of [
      this.child.stdin,
      this.child.stdout,
      this.child.stderr,
    ])
      stream.on('error', () => {
        if (!['released', 'cancelling', 'closed'].includes(this.phase))
          this.fail(
            'update_worker_transport',
            'The private installer handoff channel failed.',
          );
      });
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.phase === 'released') return;
      this.outputBytes += chunk.length;
      try {
        if (this.outputBytes > 16_384)
          throw new Error('Worker output exceeded its bound.');
        for (const frame of this.decoder.push(chunk)) {
          const rejected = updateWorkerFailureSchema.safeParse(frame);
          if (rejected.success) {
            this.fail(
              rejected.data.code,
              'The native installer worker rejected the handoff. Main must remain open.',
            );
            continue;
          }
          const ready = updateParentReadySchema.safeParse(frame);
          if (
            ready.success &&
            this.phase === 'preparing' &&
            this.matches(ready.data.parent)
          ) {
            this.clear(prepareTimer);
            this.phase = 'prepared';
            this.challenge = ready.data.challenge;
            this.after(25_000, () =>
              this.fail(
                'update_handoff_timeout',
                'The fresh installation decision expired.',
              ),
            );
            this.resolveReady();
            continue;
          }
          const committed = updateParentCommittedSchema.safeParse(frame);
          if (
            committed.success &&
            this.phase === 'committing' &&
            this.matches(committed.data.parent)
          ) {
            this.clearTimers();
            this.phase = 'committed';
            this.resolveCommit?.();
            this.after(10_000, () =>
              this.fail(
                'update_parent_exit_timeout',
                'Main did not exit after committing the installation.',
              ),
            );
            continue;
          }
          throw new Error('Unexpected worker message or parent identity.');
        }
      } catch {
        this.fail(
          'update_worker_protocol',
          'The worker returned an invalid, repeated or mismatched handoff frame.',
        );
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.phase === 'released') return;
      this.diagnosticBytes += chunk.length;
      if (this.diagnosticBytes > 16_384)
        this.fail(
          'update_worker_protocol',
          'The installer worker exceeded its diagnostic bound.',
        );
    });
    this.child.once('close', () => {
      this.exited = true;
      this.clearTimers();
      signal?.removeEventListener('abort', this.abort);
      if (this.phase !== 'released') {
        try {
          this.decoder.finish();
        } catch {
          this.record(
            'update_worker_protocol',
            'The worker response was incomplete.',
          );
        }
      }
      if (this.phase !== 'cancelling')
        this.record(
          'update_worker_closed',
          'The installer worker exited while Main was still running.',
        );
      this.phase = 'closed';
      this.resolveClosed();
      this.onClosed();
    });
    signal?.addEventListener('abort', this.abort, { once: true });
    this.write(request);
  }

  private matches(parent: HeldUpdateRuntime['identity']) {
    return (
      parent.pid === process.pid &&
      parent.creation_file_time === this.parent.creation_file_time
    );
  }

  assertPrepared() {
    if (this.error) throw this.error;
    if (this.phase !== 'prepared')
      throw new LocalError(
        'update_worker_state',
        'The worker is not awaiting a fresh installation decision.',
      );
  }

  async commit() {
    this.assertPrepared();
    this.phase = 'committing';
    const committed = new Promise<void>((resolve, reject) => {
      this.resolveCommit = resolve;
      this.rejectCommit = reject;
    });
    this.after(5_000, () =>
      this.fail(
        'update_handoff_timeout',
        'The worker did not acknowledge a durable commit.',
      ),
    );
    this.write(
      updateHandoffDecisionSchema.parse({
        version: 1,
        operation: 'commit',
        challenge: this.challenge,
      }),
    );
    try {
      await committed;
      this.assertCommitted();
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }

  cancel(): Promise<void> {
    if (this.exited) return this.stopped;
    if (this.cancelling) return this.cancelling;
    this.record(
      'update_worker_cancelled',
      'The installation handoff was cancelled.',
    );
    this.stop();
    this.cancelling = new Promise<void>((resolve, reject) => {
      const deadline = this.after(10_000, () =>
        reject(
          new LocalError(
            'update_worker_cleanup_uncertain',
            'Worker cancellation could not be confirmed. Keep Main open; installation must not proceed.',
          ),
        ),
      );
      void this.stopped.then(() => {
        this.clear(deadline);
        resolve();
      });
    });
    return this.cancelling;
  }

  releaseForExit() {
    this.assertCommitted();
    this.phase = 'released';
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
    // These timers can run only while this exact Main is still alive.
    for (const timer of this.timers) timer.unref();
  }

  private assertCommitted() {
    if (this.error) throw this.error;
    if (this.phase !== 'committed')
      throw new LocalError(
        'update_worker_state',
        'Only a durably acknowledged commit can hand off Main exit.',
      );
  }

  private write(value: unknown) {
    try {
      this.child.stdin.write(encodeJsonFrame(value), (error) => {
        if (error && !['released', 'cancelling', 'closed'].includes(this.phase))
          this.fail(
            'update_worker_transport',
            'The worker did not receive its private control frame.',
          );
      });
    } catch {
      this.fail(
        'update_worker_transport',
        'The private control frame could not be written.',
      );
    }
  }

  private record(code: string, message: string) {
    if (this.error) return;
    this.error = new LocalError(code, message);
    this.rejectReady(this.error);
    this.rejectCommit?.(this.error);
    this.resolveFailure(this.error);
  }

  private fail(code: string, message: string) {
    this.record(code, message);
    this.stop();
  }

  private stop() {
    if (this.exited || this.phase === 'cancelling') return;
    const previous = this.phase;
    this.phase = 'cancelling';
    this.clearTimers();
    if (previous === 'prepared')
      this.write(
        updateHandoffDecisionSchema.parse({
          version: 1,
          operation: 'cancel',
          challenge: this.challenge,
        }),
      );
    if (['committing', 'committed', 'released'].includes(previous))
      this.child.kill();
    this.child.stdin.end();
    if (!this.exited)
      this.after(5_000, () => {
        if (!this.exited) this.child.kill();
      });
  }

  private after(milliseconds: number, callback: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }
  private clear(timer: ReturnType<typeof setTimeout>) {
    clearTimeout(timer);
    this.timers.delete(timer);
  }
  private clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
