import { describe, expect, it } from 'vitest';
import { PendingWork } from './lifecycle.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('awaited desktop work', () => {
  it('preserves values and the original operation failure for its owner', async () => {
    const work = new PendingWork();
    expect(await work.track(Promise.resolve(42))).toBe(42);
    const failure = new Error('Synthetic operation failure.');
    await expect(work.track(Promise.reject(failure))).rejects.toBe(failure);
    await work.drain();
  });

  it('waits for all work, including work started by a completing operation', async () => {
    const work = new PendingWork();
    const first = deferred(),
      second = deferred();
    const nested = first.promise.then(() => {
      void work.track(second.promise);
    });
    const owned = work.track(nested);
    let drained = false;
    const draining = work.drain().then(() => {
      drained = true;
    });
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    second.resolve();
    await Promise.all([owned, draining]);
    expect(drained).toBe(true);
  });

  it('does not stop waiting when one owner receives a rejected result', async () => {
    const work = new PendingWork();
    const pending = deferred();
    const owned = work.track(pending.promise);
    await expect(
      work.track(Promise.reject(new Error('Synthetic failure.'))),
    ).rejects.toThrow();
    let drained = false;
    const draining = work.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve();
    await Promise.all([owned, draining]);
  });
});
