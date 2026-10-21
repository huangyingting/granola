import { useEffect, useRef, useState } from 'react';
import type { AccountUsage } from '@windows-ai-notes/contracts/server';

function format(value: string, audio: boolean) {
  const count = BigInt(value);
  const numbers = new Intl.NumberFormat();
  if (!audio) return numbers.format(count);
  if (count === 0n) return '0 min';
  if (count < 6000n) return '<0.1 min';
  return `${numbers.format(count / 60_000n)}.${(count % 60_000n) / 6000n} min`;
}
export function UsageCards({ usage }: { usage: AccountUsage }) {
  return (
    <>
      <p className="quiet-note">
        UTC period {usage.period_start} to {usage.period_end} (exclusive).
        Allowances cover this account across all workspaces.
      </p>
      <dl className="usage-grid">
        {(
          [
            ['audio_ms', 'Audio sent'],
            ['input_tokens', 'Input tokens'],
            ['output_tokens', 'Output tokens'],
          ] as const
        ).map(([unit, label]) => (
          <div key={unit}>
            <dt>{label}</dt>
            <dd>{format(usage.settled[unit], unit === 'audio_ms')}</dd>
            <dd className="quiet-note">
              of {format(usage.limits[unit], unit === 'audio_ms')}
            </dd>
            <dd>{format(usage.uncertain[unit], unit === 'audio_ms')} held</dd>
          </div>
        ))}
      </dl>
      {usage.over_limit && (
        <p role="alert">
          This account is over its configured allowance. Additional AI requests
          are blocked; contact your deployment administrator.
        </p>
      )}
      <p className="quiet-note">
        {new Intl.NumberFormat().format(BigInt(usage.uncertain_requests))}{' '}
        uncertain request(s). Held allowance is not a charge or refund.
        Cancellation does not prove that Azure did not process a request. Audio
        is measured media duration, not billed minutes; these counters are not
        an Azure invoice.
      </p>
    </>
  );
}
export function AccountUsagePanel({ scope }: { scope: number }) {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const version = useRef(0);
  async function refresh() {
    const attempt = ++version.current;
    setBusy(true);
    setError('');
    try {
      const response = await window.notes.invoke({
        operation: 'getAccountUsage',
        scope,
      });
      if (!alive.current || attempt !== version.current) return;
      if (!response.ok) {
        setUsage(null);
        setError(response.error.message);
      } else if (
        !('account_usage' in response) ||
        response.account_usage.scope !== scope
      ) {
        setUsage(null);
        setError('AI usage did not match this workspace.');
      } else setUsage(response.account_usage.account);
    } catch {
      if (alive.current && attempt === version.current) {
        setUsage(null);
        setError(
          'Current AI usage could not be loaded. No allowance was assumed.',
        );
      }
    } finally {
      if (alive.current && attempt === version.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      version.current++;
    };
  }, [scope]);
  return (
    <article className="account-card" aria-label="AI allowance">
      <div className="audio-heading">
        <h2>AI allowance</h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? 'Checking usage...' : 'Refresh AI usage'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {usage && <UsageCards usage={usage} />}
    </article>
  );
}
