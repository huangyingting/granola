import { setTimeout as delay } from 'node:timers/promises';

export function monitorLease(
  renew: () => Promise<boolean>,
  identity: { job_id: string } | { turn_id: string },
  shutdown: AbortSignal,
) {
  const providerAbort = new AbortController();
  const stop = new AbortController();
  const running = (async () => {
    try {
      while (!stop.signal.aborted) {
        await delay(5000, undefined, { signal: stop.signal });
        if (!(await renew())) {
          providerAbort.abort();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error(
          JSON.stringify({ code: 'lease_renewal_failed', ...identity }),
        );
        providerAbort.abort();
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
