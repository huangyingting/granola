import { getEventListeners } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { cancellableWait, PendingWork } from './lifecycle.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('cancellable waits without cancelling owned work', () => {
  it.each(['value', 'rejection', 'throw'] as const)(
    'preserves the original %s and removes its abort listener',
    async (mode) => {
      const controller = new AbortController();
      const failure = new Error('Synthetic operation failure.');
      const pending = cancellableWait(
        () => {
          if (mode === 'throw') throw failure;
          return mode === 'value'
            ? Promise.resolve(42)
            : Promise.reject(failure);
        },
        controller.signal,
        () => new Error('Synthetic cancellation.'),
      );
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      if (mode === 'value') await expect(pending).resolves.toBe(42);
      else await expect(pending).rejects.toBe(failure);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      controller.abort();
    },
  );
  it('does not start work or retain a listener when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => 42);
    const failure = new Error('Synthetic cancellation.');
    await expect(
      cancellableWait(operation, controller.signal, () => failure),
    ).rejects.toBe(failure);
    expect(operation).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('observes a synchronous provider failure even when the provider aborts first', async () => {
    const controller = new AbortController();
    const failure = new Error('Synthetic cancellation.');
    await expect(
      cancellableWait(
        () => {
          controller.abort();
          throw new Error('Synthetic later provider failure.');
        },
        controller.signal,
        () => failure,
      ),
    ).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await tick();
  });
  it('rechecks cancellation before delivering an already-resolved result', async () => {
    const controller = new AbortController();
    const failure = new Error('Synthetic cancellation.');
    const pending = cancellableWait(
      () => Promise.resolve(42),
      controller.signal,
      () => failure,
    );
    controller.abort();
    await expect(pending).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('stops waiting without prematurely draining or cancelling the operation owner', async () => {
    const owner = new PendingWork();
    const gate = deferred();
    const operation = owner.track(gate.promise.then(() => 42));
    const controller = new AbortController();
    const failure = new Error('Synthetic cancellation.');
    const rejected = vi.fn();
    const observing = cancellableWait(
      () => operation,
      controller.signal,
      () => failure,
    ).then(vi.fn(), rejected);
    let drained = false;
    const draining = owner.drain().then(() => {
      drained = true;
    });
    try {
      controller.abort();
      await tick();
      expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
      expect(drained).toBe(false);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      gate.resolve();
      await Promise.all([observing, draining]);
    }
    expect(await operation).toBe(42);
    expect(drained).toBe(true);
  });
});

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
