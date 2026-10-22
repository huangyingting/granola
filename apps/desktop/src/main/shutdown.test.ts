import { describe, expect, it, vi } from 'vitest';
import { DesktopShutdown } from './shutdown.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const services = {
    cancel: vi.fn(),
    drain: vi.fn(async () => {}),
    release: vi.fn(),
  };
  return { services, shutdown: new DesktopShutdown(services) };
}

describe('Main database shutdown barrier', () => {
  it('blocks new commands immediately, then waits for admitted work and service drains before releasing storage', async () => {
    const { services, shutdown } = setup();
    const command = deferred(),
      background = deferred();
    services.drain.mockReturnValue(background.promise);
    const owned = shutdown.run(() => command.promise);
    const closing = shutdown.close();
    expect(() => shutdown.assertOpen()).toThrow(/closing safely/u);
    const rejected = vi.fn(async () => {});
    expect(() => shutdown.run(rejected)).toThrow(/closing safely/u);
    expect(rejected).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(services.cancel).toHaveBeenCalledOnce();
    expect(services.drain).not.toHaveBeenCalled();
    command.resolve();
    await owned;
    await vi.waitFor(() => expect(services.drain).toHaveBeenCalledOnce());
    expect(services.release).not.toHaveBeenCalled();
    expect(shutdown.complete).toBe(false);
    background.resolve();
    await closing;
    expect(services.release).toHaveBeenCalledOnce();
    expect(shutdown.complete).toBe(true);
  });

  it('shares concurrent close attempts and makes completed shutdown idempotent', async () => {
    const { services, shutdown } = setup();
    const pending = deferred();
    services.drain.mockReturnValue(pending.promise);
    const first = shutdown.close();
    expect(shutdown.close()).toBe(first);
    pending.resolve();
    await first;
    await shutdown.close();
    expect(services.cancel).toHaveBeenCalledOnce();
    expect(services.release).toHaveBeenCalledOnce();
  });

  it('surfaces command failures to their owner but still drains before storage release', async () => {
    const { services, shutdown } = setup();
    const failure = new Error('Synthetic cancelled request.');
    const owned = shutdown.run(() => Promise.reject(failure));
    const rejected = expect(owned).rejects.toBe(failure);
    await shutdown.close();
    await rejected;
    expect(services.release).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'drain', 'release'] as const)(
    'keeps admission closed and supports retry after a %s failure',
    async (stage) => {
      const { services, shutdown } = setup();
      const failure = new Error('Synthetic shutdown failure.');
      if (stage === 'drain') services.drain.mockRejectedValueOnce(failure);
      else
        services[stage].mockImplementationOnce(() => {
          throw failure;
        });
      await expect(shutdown.close()).rejects.toBe(failure);
      expect(shutdown.complete).toBe(false);
      expect(() => shutdown.assertOpen()).toThrow(/closing safely/u);
      if (stage !== 'release') expect(services.release).not.toHaveBeenCalled();
      await shutdown.close();
      expect(shutdown.complete).toBe(true);
    },
  );
});
