import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalError } from '@windows-ai-notes/local';
import { DesktopUpdateActivation } from './update-activation.js';
import type { ReadyUpdate } from './update-downloads.js';
import type { HeldUpdateRuntime } from './update-runtime.js';
import type { PreparedUpdateWorker } from './update-worker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const candidate: ReadyUpdate = {
  directory: 'C:\\Private cache',
  installer: 'C:\\Private cache\\windows-ai-notes-0.1.1-x64-signed.exe',
  feed: {
    version: 1,
    kind: 'windows_update',
    application_version: '0.1.1',
    architecture: 'x64',
    installer: 'windows-ai-notes-0.1.1-x64-signed.exe',
    bytes: 1234,
    sha512: Buffer.alloc(64).toString('base64'),
  },
  expected: {
    current_version: '0.1.0',
    version: '0.1.1',
    bytes: 1234,
    sha512: Buffer.alloc(64).toString('base64'),
    certificate_sha256: 'a'.repeat(64),
    publisher: 'Synthetic publisher',
    product_name: 'Windows AI Notes',
  },
};

function fixture() {
  const steps: string[] = [];
  const failed = deferred<LocalError>();
  const stopped = deferred<void>();
  let held = true;
  let permitted = false;
  const guard = {
    runtime: {
      directory: 'C:\\Private runtime',
      executable: 'C:\\Private runtime\\AudioHost.exe',
      files: 12,
      bytes: 1024,
      sha256: 'a'.repeat(64),
    },
    identity: { pid: process.pid, creation_file_time: '134000000000000001' },
    assertHeld: vi.fn(() => {
      if (!held) throw new LocalError('update_runtime_closed', 'Guard lost.');
    }),
    release: vi.fn(async () => {
      steps.push('guard.release');
      held = false;
    }),
  } satisfies HeldUpdateRuntime;
  const worker = {
    failed: failed.promise,
    stopped: stopped.promise,
    commit: vi.fn(async () => {
      steps.push('commit');
    }),
    releaseForExit: vi.fn(() => {
      steps.push('release');
      permitted = true;
    }),
    cancel: vi.fn(async () => {
      permitted = false;
      stopped.resolve();
    }),
  } satisfies PreparedUpdateWorker;
  const services = {
    hold: vi.fn(async (_candidate: ReadyUpdate, _signal: AbortSignal) => {
      steps.push('hold');
      return guard;
    }),
    prepare: vi.fn(
      async (
        lease: HeldUpdateRuntime,
        _candidate: ReadyUpdate,
        _signal: AbortSignal,
      ) => {
        steps.push('prepare');
        await lease.release();
        return worker;
      },
    ),
    requestFlush: vi.fn(() => {
      steps.push('flush');
    }),
    drain: vi.fn(async () => {
      steps.push('drain');
    }),
    exit: vi.fn(() => {
      steps.push('exit');
    }),
    stopWorker: vi.fn(async () => {}),
    allowsExit: vi.fn(() => permitted),
  };
  const activation = new DesktopUpdateActivation(services);
  return { activation, services, guard, worker, failed, steps };
}
afterEach(() => vi.useRealTimers());

describe('Main-only verified update activation', () => {
  it('protects runtime before editor flush and prepares a fresh decision only after long terminal drainage', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const draining = deferred<void>();
    f.services.drain.mockImplementation(async () => {
      f.steps.push('drain');
      await draining.promise;
    });
    await f.activation.start(candidate);
    expect(f.steps).toEqual(['hold', 'flush']);
    expect(f.activation.blocksExit).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.guard.release).not.toHaveBeenCalled();
    const completing = f.activation.completeFlush();
    expect(f.activation.completeFlush()).toBe(completing);
    let settled = false;
    void completing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.steps).toEqual(['hold', 'flush', 'drain']);
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.guard.release).not.toHaveBeenCalled();
    draining.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.steps).toEqual([
      'hold',
      'flush',
      'drain',
      'prepare',
      'guard.release',
      'commit',
      'release',
      'exit',
    ]);
    expect(settled).toBe(false);
    expect(f.activation.blocksExit).toBe(false);
    expect(f.services.hold.mock.calls[0]![1].aborted).toBe(false);
    await f.activation.stopForExit();
    expect(f.worker.cancel).not.toHaveBeenCalled();
    expect(f.services.stopWorker).not.toHaveBeenCalled();
    expect(f.services.hold.mock.calls[0]![1].aborted).toBe(false);
    const failure = new LocalError(
      'update_parent_exit_timeout',
      'Main stayed alive.',
    );
    f.failed.resolve(failure);
    await expect(completing).rejects.toBe(failure);
    expect(f.worker.cancel).toHaveBeenCalledOnce();
    expect(f.services.exit).toHaveBeenCalledOnce();
  });

  it('surfaces guardian preparation failure without flushing or disposing the workspace', async () => {
    const f = fixture();
    const failure = new LocalError(
      'update_runtime_invalid',
      'Runtime rejected.',
    );
    f.services.hold.mockRejectedValue(failure);
    await expect(f.activation.start(candidate)).rejects.toBe(failure);
    expect(f.services.requestFlush).not.toHaveBeenCalled();
    expect(f.services.drain).not.toHaveBeenCalled();
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.services.exit).not.toHaveBeenCalled();
    expect(f.activation.blocksExit).toBe(false);
    await expect(f.activation.start(candidate)).rejects.toMatchObject({
      code: 'update_activation_started',
    });
  });

  it.each(['cancelPreparation', 'stopForExit'] as const)(
    'does not flush a late guardian after %s and awaits its actual release',
    async (method) => {
      const f = fixture();
      const holding = deferred<typeof f.guard>();
      const releasing = deferred<void>();
      f.services.hold.mockReturnValue(holding.promise);
      f.guard.release.mockReturnValue(releasing.promise);
      const starting = f.activation.start(candidate);
      const rejected = expect(starting).rejects.toMatchObject({
        code: 'update_activation_cancelled',
      });
      await Promise.resolve();
      const stopping = f.activation[method]();
      holding.resolve(f.guard);
      await vi.waitFor(() => expect(f.guard.release).toHaveBeenCalledOnce());
      expect(f.activation.blocksExit).toBe(true);
      expect(f.services.requestFlush).not.toHaveBeenCalled();
      expect(f.services.drain).not.toHaveBeenCalled();
      releasing.resolve();
      await rejected;
      await stopping;
      expect(f.activation.blocksExit).toBe(false);
    },
  );

  it('cancels during workspace drain without preparing a worker or reopening disposed storage', async () => {
    const f = fixture();
    const draining = deferred<void>();
    f.services.drain.mockReturnValue(draining.promise);
    await f.activation.start(candidate);
    const completing = f.activation.completeFlush();
    const rejected = expect(completing).rejects.toMatchObject({
      code: 'update_activation_cancelled',
    });
    await vi.waitFor(() => expect(f.services.drain).toHaveBeenCalledOnce());
    const stopping = f.activation.stopForExit();
    expect(f.activation.blocksExit).toBe(true);
    expect(f.services.prepare).not.toHaveBeenCalled();
    draining.resolve();
    await stopping;
    await rejected;
    expect(f.guard.release).toHaveBeenCalledOnce();
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.services.exit).not.toHaveBeenCalled();
  });

  it('rejects a lost guardian before terminal workspace disposal', async () => {
    const f = fixture();
    await f.activation.start(candidate);
    f.guard.assertHeld.mockImplementation(() => {
      throw new LocalError('update_runtime_closed', 'Guard lost.');
    });
    await expect(f.activation.completeFlush()).rejects.toMatchObject({
      code: 'update_runtime_closed',
    });
    expect(f.services.drain).not.toHaveBeenCalled();
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.guard.release).toHaveBeenCalledOnce();
  });

  it.each(['drain', 'prepare', 'commit', 'release', 'exit'] as const)(
    'does not retry, resume a workspace or exit after a %s failure',
    async (stage) => {
      const f = fixture();
      const failure = new LocalError(
        'update_test_failure',
        'Synthetic failure.',
      );
      if (stage === 'drain' || stage === 'prepare')
        f.services[stage].mockRejectedValue(failure);
      else if (stage === 'commit') f.worker.commit.mockRejectedValue(failure);
      else if (stage === 'release')
        f.worker.releaseForExit.mockImplementation(() => {
          throw failure;
        });
      else
        f.services.exit.mockImplementation(() => {
          throw failure;
        });
      await f.activation.start(candidate);
      await expect(f.activation.completeFlush()).rejects.toBe(failure);
      expect(f.services.exit).toHaveBeenCalledTimes(stage === 'exit' ? 1 : 0);
      expect(f.services.prepare).toHaveBeenCalledTimes(
        stage === 'drain' ? 0 : 1,
      );
      expect(f.guard.release).toHaveBeenCalledOnce();
      if (['commit', 'release', 'exit'].includes(stage))
        expect(f.worker.cancel).toHaveBeenCalledOnce();
      expect(f.activation.blocksExit).toBe(false);
      await f.activation.stopForExit();
      await expect(f.activation.start(candidate)).rejects.toMatchObject({
        code: 'update_activation_started',
      });
    },
  );

  it('keeps a failed released handoff pending until the original worker physically stops', async () => {
    const f = fixture();
    const stopping = deferred<void>();
    f.worker.cancel.mockImplementation(async () => {
      f.services.allowsExit.mockReturnValue(false);
      await stopping.promise;
    });
    await f.activation.start(candidate);
    const completing = f.activation.completeFlush();
    const failure = new LocalError(
      'update_parent_exit_timeout',
      'Exit failed.',
    );
    const rejected = expect(completing).rejects.toBe(failure);
    await vi.waitFor(() => expect(f.services.exit).toHaveBeenCalledOnce());
    f.failed.resolve(failure);
    await vi.waitFor(() => expect(f.worker.cancel).toHaveBeenCalledOnce());
    expect(f.activation.blocksExit).toBe(true);
    let finished = false;
    const closing = f.activation.stopForExit().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    stopping.resolve();
    await closing;
    await rejected;
    expect(f.activation.blocksExit).toBe(false);
    expect(f.services.exit).toHaveBeenCalledOnce();
  });

  it('surfaces uncertain physical cancellation instead of authorizing a later exit', async () => {
    const f = fixture();
    const failure = new LocalError(
      'update_worker_cleanup_uncertain',
      'Keep Main open.',
    );
    f.worker.commit.mockRejectedValue(
      new LocalError('update_worker_protocol', 'Rejected.'),
    );
    f.worker.cancel.mockRejectedValue(failure);
    f.services.stopWorker.mockRejectedValue(failure);
    await f.activation.start(candidate);
    await expect(f.activation.completeFlush()).rejects.toBe(failure);
    await expect(f.activation.stopForExit()).rejects.toBe(failure);
    expect(f.services.exit).not.toHaveBeenCalled();
    f.services.stopWorker.mockResolvedValue(undefined);
    await f.activation.stopForExit();
  });

  it('requires a protected flush and single Main attempt', async () => {
    const f = fixture();
    await expect(f.activation.completeFlush()).rejects.toMatchObject({
      code: 'update_activation_state',
    });
    await f.activation.start(candidate);
    await expect(f.activation.start(candidate)).rejects.toMatchObject({
      code: 'update_activation_started',
    });
    await f.activation.stopForExit();
    expect(f.services.prepare).not.toHaveBeenCalled();
  });
});
