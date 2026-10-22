import { afterEach, expect, it, vi } from 'vitest';
import { monitorLease, type LeaseObservation } from './lease.js';

const ticks = vi.hoisted(() => ({ pending: [] as (() => void)[] }));
vi.mock('node:timers/promises', () => ({
  setTimeout: (
    _delay: number,
    _value: undefined,
    options: { signal: AbortSignal },
  ) =>
    new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
      options.signal.addEventListener('abort', abort, { once: true });
      ticks.pending.push(() => {
        options.signal.removeEventListener('abort', abort);
        resolve();
      });
    }),
}));
afterEach(() => {
  ticks.pending.length = 0;
  vi.restoreAllMocks();
});

it('observes authoritative renewal refusal once and aborts the provider before notifying the observer', async () => {
  let aborted = false;
  const observer = vi.fn((_value: LeaseObservation): undefined => {
    expect(aborted).toBe(true);
    return undefined;
  });
  const renew = vi.fn(async () => false);
  const lease = monitorLease(
    renew,
    { job_id: 'synthetic-job' },
    new AbortController().signal,
    observer,
  );
  lease.signal.addEventListener('abort', () => {
    aborted = true;
  });
  ticks.pending.shift()!();
  await vi.waitFor(() =>
    expect(observer).toHaveBeenCalledExactlyOnceWith('renewal_refused'),
  );
  expect(renew).toHaveBeenCalledOnce();
  await lease.stop();
});

it.each(['Error', 'AbortError'])(
  'treats an unexpected renewal %s as unavailable, not a normal monitor stop',
  async (name) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const observer = vi.fn((_value: LeaseObservation): undefined => undefined);
    const lease = monitorLease(
      async () => {
        throw Object.assign(new Error('private-database-message'), { name });
      },
      { turn_id: 'synthetic-turn' },
      new AbortController().signal,
      observer,
    );
    ticks.pending.shift()!();
    await vi.waitFor(() =>
      expect(observer).toHaveBeenCalledExactlyOnceWith('renewal_unavailable'),
    );
    expect(lease.signal.aborted).toBe(true);
    await lease.stop();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        code: 'lease_renewal_failed',
        turn_id: 'synthetic-turn',
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
  },
);

it('stops cleanly without inventing a lease loss or aborting the completed provider', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const renew = vi.fn(async () => true),
    observer = vi.fn((_value: LeaseObservation): undefined => undefined);
  const lease = monitorLease(
    renew,
    { job_id: 'synthetic-job' },
    new AbortController().signal,
    observer,
  );
  await lease.stop();
  expect(renew).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(lease.signal.aborted).toBe(false);
});

it('reports a failed in-flight renewal even if monitor stop was already requested', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let fail!: (error: Error) => void;
  const pending = new Promise<boolean>((_resolve, reject) => {
    fail = reject;
  });
  const renew = vi.fn(() => pending);
  const observer = vi.fn((_value: LeaseObservation): undefined => undefined);
  const lease = monitorLease(
    renew,
    { job_id: 'synthetic-job' },
    new AbortController().signal,
    observer,
  );
  ticks.pending.shift()!();
  await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  const stopped = lease.stop();
  fail(new Error('private-in-flight-database-error'));
  await stopped;
  expect(observer).toHaveBeenCalledExactlyOnceWith('renewal_unavailable');
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ code: 'lease_renewal_failed', job_id: 'synthetic-job' }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
});

it('continues after successful renewal and preserves explicit shutdown cancellation', async () => {
  const renew = vi.fn(async () => true),
    observer = vi.fn((_value: LeaseObservation): undefined => undefined);
  const shutdown = new AbortController();
  const lease = monitorLease(
    renew,
    { job_id: 'synthetic-job' },
    shutdown.signal,
    observer,
  );
  ticks.pending.shift()!();
  await vi.waitFor(() => expect(ticks.pending).toHaveLength(1));
  expect(lease.signal.aborted).toBe(false);
  shutdown.abort();
  expect(lease.signal.aborted).toBe(true);
  await lease.stop();
  expect(observer).not.toHaveBeenCalled();
});

it('never lets a throwing observer prevent provider abort or leak private error details', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const lease = monitorLease(
    async () => false,
    { job_id: 'synthetic-job' },
    new AbortController().signal,
    () => {
      throw new Error('private-observer');
    },
  );
  ticks.pending.shift()!();
  await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
  await lease.stop();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ code: 'lease_telemetry_failed', job_id: 'synthetic-job' }),
  );
});

it('rejects asynchronous observers without an unhandled rejection or missed provider abort', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const lease = monitorLease(
    async () => false,
    { job_id: 'synthetic-job' },
    new AbortController().signal,
    // @ts-expect-error Deliberately exercise a JavaScript caller bypassing the synchronous observer contract.
    async () => {
      throw new Error('private-observer');
    },
  );
  ticks.pending.shift()!();
  await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
  await lease.stop();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ code: 'lease_telemetry_failed', job_id: 'synthetic-job' }),
  );
});
