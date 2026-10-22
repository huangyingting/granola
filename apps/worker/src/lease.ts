import { setTimeout as delay } from 'node:timers/promises';

export type LeaseObservation = 'renewal_refused' | 'renewal_unavailable';

export function monitorLease(
  renew: () => Promise<boolean>,
  identity: { job_id: string } | { turn_id: string },
  shutdown: AbortSignal,
  observe?: (observation: LeaseObservation) => undefined,
) {
  const providerAbort = new AbortController();
  const stop = new AbortController();
  const lost = (observation: LeaseObservation) => {
    providerAbort.abort();
    try {
      const value: unknown = observe?.(observation);
      if (value !== undefined) {
        if (value instanceof Promise) value.catch(() => undefined);
        throw new Error('Lease observers must be synchronous.');
      }
    } catch {
      console.error(
        JSON.stringify({ code: 'lease_telemetry_failed', ...identity }),
      );
    }
  };
  const running = (async () => {
    try {
      while (!stop.signal.aborted) {
        await delay(5000, undefined, { signal: stop.signal });
        if (!(await renew())) {
          lost('renewal_refused');
          break;
        }
      }
    } catch (error) {
      if (!(
        stop.signal.aborted &&
        error instanceof Error &&
        error.name === 'AbortError'
      )) {
        console.error(
          JSON.stringify({ code: 'lease_renewal_failed', ...identity }),
        );
        lost('renewal_unavailable');
      }
    }
  })();
  return {
    signal: AbortSignal.any([shutdown, providerAbort.signal]),
    stop: async () => {
      stop.abort();
      await running;
    },
  };
}
