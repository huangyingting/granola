import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameDecoder, encodeJsonFrame } from '@windows-ai-notes/contracts';
import type { HeldUpdateRuntime } from './update-runtime.js';
import type {
  PreparedUpdateWorker,
  prepareUpdateWorker,
} from './update-worker.js';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: native.spawn,
}));
const directory =
  'C:\\Users\\Test\\AppData\\Local\\WindowsAINotes.UpdateWorkers\\worker-71c1213f-45b7-47d4-9a13-3c94b7a7f8ca';
const candidate = {
  application: 'C:\\Installed app\\Synthetic.exe',
  user_data: 'C:\\Private user data',
  current_version: '0.1.0',
  offered_version: '0.1.1',
  installer: 'C:\\Private cache\\windows-ai-notes-0.1.1-x64-signed.exe',
  bytes: 1234,
  sha512: Buffer.alloc(64, 1).toString('base64'),
};
const identity = { pid: process.pid, creation_file_time: '134000000000000001' };
const ready = {
  version: 1,
  event: 'update_parent_ready',
  parent: identity,
  challenge: 'b'.repeat(64),
};
const committed = {
  version: 1,
  event: 'update_parent_committed',
  parent: identity,
};
class Worker extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: unknown[] = [];
  readonly unref = vi.fn();
  closeOnEnd = true;
  closeOnKill = true;
  ended = false;
  readonly kill = vi.fn(() => {
    if (this.closeOnKill) queueMicrotask(() => this.finish());
    return this.closeOnKill;
  });
  constructor() {
    super();
    const decoder = new FrameDecoder();
    this.stdin.on('data', (chunk: Buffer) =>
      this.sent.push(...decoder.push(chunk)),
    );
    this.stdin.once('finish', () => {
      if (this.closeOnEnd) queueMicrotask(() => this.finish());
    });
  }
  frame(value: unknown) {
    this.stdout.write(encodeJsonFrame(value));
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    this.emit('close', 2, null);
  }
}
let child: Worker;
let guard: HeldUpdateRuntime & {
  release: ReturnType<typeof vi.fn>;
  assertHeld: ReturnType<typeof vi.fn>;
};
let prepare: typeof prepareUpdateWorker;
beforeEach(async () => {
  vi.resetModules();
  ({ prepareUpdateWorker: prepare } = await import('./update-worker.js'));
  child = new Worker();
  native.spawn.mockReset().mockReturnValue(child);
  guard = {
    runtime: {
      directory,
      executable: `${directory}\\AudioHost.exe`,
      files: 12,
      bytes: 1024,
      sha256: 'a'.repeat(64),
    },
    identity: { ...identity },
    release: vi.fn().mockResolvedValue(undefined),
    assertHeld: vi.fn(),
  };
});
afterEach(async () => {
  child.finish();
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function prepared(signal?: AbortSignal): Promise<PreparedUpdateWorker> {
  const pending = prepare(guard, candidate, signal);
  child.frame(ready);
  return pending;
}

describe('authenticated Main installer worker client', () => {
  it('constructs private OS-only detached worker input without accepting caller pins or process identity', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'synthetic-not-a-key');
    vi.stubEnv(
      'WINDOWS_SIGNING_CERTIFICATE_PASSWORD',
      'synthetic-not-a-password',
    );
    const session = await prepared();
    expect(native.spawn).toHaveBeenCalledWith(
      guard.runtime.executable,
      ['--apply-update'],
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        stdio: 'pipe',
        cwd: directory,
      }),
    );
    const environment = native.spawn.mock.calls[0]![2].env;
    expect(environment.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(environment.WINDOWS_SIGNING_CERTIFICATE_PASSWORD).toBeUndefined();
    expect(child.sent).toEqual([
      {
        ...candidate,
        parent_pid: process.pid,
        runtime_sha256: guard.runtime.sha256,
      },
    ]);
    expect(guard.release).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
    await session.cancel();
    expect(child.sent[1]).toEqual({
      version: 1,
      operation: 'cancel',
      challenge: ready.challenge,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retains the guardian until exact native readiness and confirmed release', async () => {
    let release!: () => void;
    guard.release.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = prepare(guard, candidate);
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    expect(guard.release).not.toHaveBeenCalled();
    child.frame(ready);
    await Promise.resolve();
    expect(guard.release).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    release();
    const session = await pending;
    await session.cancel();
  });

  it('does not release another caller’s guard when the single-flight gate is busy', async () => {
    const pending = prepare(guard, candidate);
    const other = { ...guard, release: vi.fn() };
    await expect(prepare(other, candidate)).rejects.toMatchObject({
      code: 'update_worker_busy',
    });
    expect(other.release).not.toHaveBeenCalled();
    child.frame(ready);
    await (await pending).cancel();
  });

  it.each([
    { ...candidate, offered_version: '0.1.0' },
    { ...candidate, installer: 'C:\\Private cache\\..\\installer.exe' },
    { ...candidate, certificate_sha256: 'a'.repeat(64) },
    { ...candidate, parent_pid: process.pid },
    { ...candidate, runtime_sha256: 'a'.repeat(64) },
  ])(
    'rejects invalid or caller-selected authority before process loading',
    async (value) => {
      await expect(prepare(guard, value)).rejects.toMatchObject({
        code: 'update_worker_arguments',
      });
      expect(native.spawn).not.toHaveBeenCalled();
      expect(guard.release).toHaveBeenCalledOnce();
    },
  );

  it('does not load a runtime after its guard is lost', async () => {
    guard.assertHeld.mockImplementation(() => {
      throw new Error('Synthetic lost guard.');
    });
    await expect(prepare(guard, candidate)).rejects.toThrow('lost guard');
    expect(native.spawn).not.toHaveBeenCalled();
    expect(guard.release).toHaveBeenCalledOnce();
  });

  it.each([
    { ...ready, parent: { ...identity, pid: process.pid + 1 } },
    {
      ...ready,
      parent: { ...identity, creation_file_time: '134000000000000002' },
    },
    { ...ready, challenge: '0'.repeat(63) },
    { ...ready, expected: candidate },
    committed,
  ])(
    'rejects invalid frames and exact creation-time mismatches without numeric coercion',
    async (value) => {
      const pending = prepare(guard, candidate);
      child.frame(value);
      await expect(pending).rejects.toMatchObject({
        code: 'update_worker_protocol',
      });
      expect(guard.release).toHaveBeenCalledOnce();
      expect(child.ended).toBe(true);
    },
  );

  it('rejects repeated ready frames before returning a prepared session', async () => {
    const pending = prepare(guard, candidate);
    child.stdout.write(
      Buffer.concat([encodeJsonFrame(ready), encodeJsonFrame(ready)]),
    );
    await expect(pending).rejects.toMatchObject({
      code: 'update_worker_protocol',
    });
  });

  it('returns a native trust rejection only after stopping the worker and releasing Main handles', async () => {
    const pending = prepare(guard, candidate);
    child.frame({
      version: 1,
      event: 'update_worker_failed',
      code: 'update_signature_invalid',
    });
    await expect(pending).rejects.toMatchObject({
      code: 'update_signature_invalid',
    });
    expect(child.ended).toBe(true);
    expect(guard.release).toHaveBeenCalledOnce();
  });

  it('releases single flight after confirmed cancellation, without reusing a challenge', async () => {
    await (await prepared()).cancel();
    child = new Worker();
    native.spawn.mockReturnValue(child);
    guard = { ...guard, release: vi.fn().mockResolvedValue(undefined) };
    const pending = prepare(guard, candidate);
    child.frame({ ...ready, challenge: 'c'.repeat(64) });
    const session = await pending;
    await session.cancel();
    expect(child.sent[1]).toMatchObject({
      operation: 'cancel',
      challenge: 'c'.repeat(64),
    });
  });

  it('cancels preparation before loading native code when the signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(prepare(guard, candidate, abort.signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(native.spawn).not.toHaveBeenCalled();
    expect(guard.release).toHaveBeenCalledOnce();
  });

  it('times out an unresponsive preparation and confirms worker exit', async () => {
    vi.useFakeTimers();
    const pending = prepare(guard, candidate);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'update_worker_timeout',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(child.ended).toBe(true);
    expect(guard.release).toHaveBeenCalledOnce();
  });

  it.each(['stdin', 'stdout', 'stderr'] as const)(
    'surfaces a %s transport error before authorizing Main exit',
    async (stream) => {
      const pending = prepare(guard, candidate);
      child[stream].emit('error', new Error('Synthetic stream failure.'));
      await expect(pending).rejects.toMatchObject({
        code: 'update_worker_transport',
      });
      expect(child.ended).toBe(true);
    },
  );

  it.each(['stdout', 'stderr'] as const)(
    'bounds cumulative %s bytes before buffering untrusted output',
    async (stream) => {
      const pending = prepare(guard, candidate);
      child[stream].write(Buffer.alloc(16_385));
      await expect(pending).rejects.toMatchObject({
        code: 'update_worker_protocol',
      });
    },
  );

  it('rejects truncated control frames on native exit', async () => {
    const pending = prepare(guard, candidate);
    child.stdout.write(encodeJsonFrame(ready).subarray(0, 9));
    child.finish();
    await expect(pending).rejects.toMatchObject({
      code: 'update_worker_protocol',
    });
  });

  it('does not treat a native process exit as commit acknowledgment', async () => {
    const session = await prepared();
    const commit = session.commit();
    child.finish();
    await expect(commit).rejects.toMatchObject({
      code: 'update_worker_closed',
    });
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('commits only the fresh challenge and waits for durable acknowledgment before detaching', async () => {
    const session = await prepared();
    expect(() => session.releaseForExit()).toThrow();
    const commit = session.commit();
    expect(child.sent[1]).toEqual({
      version: 1,
      operation: 'commit',
      challenge: ready.challenge,
    });
    expect(child.unref).not.toHaveBeenCalled();
    child.frame(committed);
    await commit;
    await expect(session.commit()).rejects.toMatchObject({
      code: 'update_worker_state',
    });
    session.releaseForExit();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    await session.cancel();
    expect(child.kill).toHaveBeenCalledOnce();
    await session.stopped;
  });

  it('rejects a mismatched commit acknowledgment and kills only the owned worker while Main lives', async () => {
    const session = await prepared();
    const commit = session.commit();
    child.frame({
      ...committed,
      parent: { ...identity, creation_file_time: '134000000000000002' },
    });
    await expect(commit).rejects.toMatchObject({
      code: 'update_worker_protocol',
    });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.ended).toBe(true);
  });

  it('retains cancellation after preparation and after durable commit', async () => {
    const abort = new AbortController();
    const session = await prepared(abort.signal);
    const commit = session.commit();
    child.frame(committed);
    await commit;
    abort.abort();
    await session.stopped;
    await expect(session.failed).resolves.toMatchObject({
      code: 'update_worker_cancelled',
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('expires an unused fresh decision instead of authorizing a later Main exit', async () => {
    vi.useFakeTimers();
    const session = await prepared();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(session.failed).resolves.toMatchObject({
      code: 'update_handoff_timeout',
    });
    await session.stopped;
    expect(child.sent[1]).toMatchObject({ operation: 'cancel' });
  });

  it('aborts a committed worker if Main unexpectedly remains alive', async () => {
    vi.useFakeTimers();
    const session = await prepared();
    const commit = session.commit();
    child.frame(committed);
    await commit;
    session.releaseForExit();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(session.failed).resolves.toMatchObject({
      code: 'update_parent_exit_timeout',
    });
    await session.stopped;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('waits for confirmed cancellation after a commit deadline', async () => {
    vi.useFakeTimers();
    const session = await prepared();
    const commit = session.commit();
    const rejected = expect(commit).rejects.toMatchObject({
      code: 'update_handoff_timeout',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(child.ended).toBe(true);
  });

  it('surfaces uncertain cancellation without claiming the worker stopped or permitting another attempt', async () => {
    vi.useFakeTimers();
    const session = await prepared();
    child.closeOnEnd = false;
    child.closeOnKill = false;
    const cancelled = session.cancel();
    const rejected = expect(cancelled).rejects.toMatchObject({
      code: 'update_worker_cleanup_uncertain',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    await expect(prepare(guard, candidate)).rejects.toMatchObject({
      code: 'update_worker_busy',
    });
    child.finish();
    await session.stopped;
    await session.cancel();
  });

  it('keeps further attempts blocked when guardian cleanup cannot be confirmed', async () => {
    guard.release.mockRejectedValue(
      new Error('Synthetic uncertain guardian cleanup.'),
    );
    const pending = prepare(guard, candidate);
    child.frame(ready);
    await expect(pending).rejects.toThrow('uncertain guardian');
    expect(child.ended).toBe(true);
    await expect(prepare(guard, candidate)).rejects.toMatchObject({
      code: 'update_worker_busy',
    });
  });
});
