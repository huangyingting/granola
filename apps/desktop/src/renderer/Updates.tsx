import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '@windows-ai-notes/contracts/desktop';
import type {
  DesktopUpdateCommand,
  DesktopUpdateState,
} from '@windows-ai-notes/contracts/updates';

function status(state: DesktopUpdateState) {
  switch (state.phase) {
    case 'initializing':
      return "Loading this package's update policy...";
    case 'disabled':
      return 'Updates are not enabled for this application package.';
    case 'recovering':
      return 'Checking previously downloaded updates...';
    case 'idle':
      return 'Check when you are ready. Updates are not checked automatically.';
    case 'checking':
      return 'Checking for updates...';
    case 'current':
      return 'No newer update is available.';
    case 'available':
      return `Version ${state.available_version} is available.`;
    case 'downloading':
      return 'Downloading and verifying the update...';
    case 'ready':
      return `Version ${state.available_version} is verified and saved on this device.`;
    case 'cancelling':
      return 'Cancelling and cleaning up this operation...';
    case 'cancelled':
      return 'Update operation cancelled. Existing verified downloads were preserved.';
    case 'failed':
      return 'Updates need attention.';
  }
}

export function UpdateCard({
  state,
  pending,
  onAction,
}: {
  state: DesktopUpdateState;
  pending: boolean;
  onAction: (command: DesktopUpdateCommand) => void;
}) {
  return (
    <article className="account-card" aria-label="Application updates">
      <h2>Windows AI Notes</h2>
      <p className="quiet-note">Installed version {state.installed_version}</p>
      <p role="status">{status(state)}</p>
      {state.error && (
        <p className="account-alert" role="alert">
          {state.error.message}
        </p>
      )}
      {state.available_version && state.download_bytes !== null && (
        <p className="quiet-note">
          Version {state.available_version}.{' '}
          {(state.download_bytes / 1024 ** 2).toFixed(1)} MiB download.
          Publisher, installer identity and file contents must pass
          verification.
        </p>
      )}
      {!!state.cache?.rejected && (
        <p className="account-alert" role="status">
          {state.cache.rejected} cached update(s) could not be accepted and were
          preserved. Rejected files will not be used.
        </p>
      )}
      {!!state.cache?.incomplete && (
        <p className="quiet-note">
          {state.cache.incomplete} incomplete download(s) were preserved. Your
          notes and recordings were not touched.
        </p>
      )}
      <div className="inline-actions">
        {state.phase !== 'disabled' && (
          <button
            className="secondary"
            disabled={pending || !state.can_check}
            onClick={() => onAction({ operation: 'check' })}
          >
            Check for updates
          </button>
        )}
        {state.can_download && (
          <button
            className="primary"
            disabled={pending}
            onClick={() => onAction({ operation: 'download' })}
          >
            Download update
          </button>
        )}
        {(state.can_cancel || state.phase === 'cancelling') && (
          <button
            className="quiet-button"
            disabled={pending || !state.can_cancel}
            onClick={() => onAction({ operation: 'cancel' })}
          >
            Cancel update operation
          </button>
        )}
      </div>
      <p className="quiet-note">
        Installation is not available in this build. Downloading an update does
        not install it or restart the app.
      </p>
    </article>
  );
}

export function Updates({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const request = useRef(0);
  const accept = useCallback((value: DesktopUpdateState) => {
    setState((current) =>
      !current || value.revision >= current.revision ? value : current,
    );
  }, []);
  const invoke = useCallback(
    async (command: DesktopUpdateCommand) => {
      const sequence = ++request.current;
      setPending(true);
      setError('');
      try {
        const response = await bridge.invokeUpdate(command);
        if (!active.current || sequence !== request.current) return;
        if (response.ok) accept(response.state);
        else setError(response.error.message);
      } catch {
        if (active.current && sequence === request.current)
          setError(
            'The desktop update connection failed. Your notes were not changed.',
          );
      } finally {
        if (active.current && sequence === request.current) setPending(false);
      }
    },
    [bridge, accept],
  );
  useEffect(() => {
    active.current = true;
    const unsubscribe = bridge.onUpdateState((value) => {
      if (active.current) accept(value);
    });
    void invoke({ operation: 'getState' });
    return () => {
      active.current = false;
      request.current++;
      unsubscribe();
    };
  }, [bridge, accept, invoke]);
  return (
    <section className="privacy-page">
      <span className="eyebrow">DESKTOP APPLICATION</span>
      <h1>About &amp; updates.</h1>
      {error && (
        <div className="account-alert" role="alert">
          {error}
          <button
            className="quiet-button"
            disabled={pending}
            onClick={() => void invoke({ operation: 'getState' })}
          >
            Retry update connection
          </button>
        </div>
      )}
      {state ? (
        <UpdateCard
          state={state}
          pending={pending}
          onAction={(command) => void invoke(command)}
        />
      ) : (
        <p role="status">Loading update status...</p>
      )}
    </section>
  );
}
