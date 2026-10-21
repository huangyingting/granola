import { useEffect, useState } from 'react';
import { AccountUsagePanel } from './AccountUsage.js';
import type {
  DesktopCommand,
  DesktopState,
} from '@windows-ai-notes/contracts/desktop';

type Invoke = (command: DesktopCommand) => Promise<DesktopState | null>;
export function Account({
  state,
  invoke,
  switchScope,
  blocked,
}: {
  state: DesktopState;
  invoke: Invoke;
  switchScope: Invoke;
  blocked: boolean;
}) {
  const connection = state.connection;
  const [service, setService] = useState(connection.service_url ?? '');
  const [copyOffline, setCopyOffline] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [preserve, setPreserve] = useState(true);
  useEffect(
    () => setService(connection.service_url ?? ''),
    [connection.service_url],
  );
  const signingIn = connection.status === 'connecting';
  return (
    <section className="account-page">
      <span className="eyebrow">A CONNECTED WORKSPACE. A PRIVATE DEVICE.</span>
      <h1>Your notes, in sync.</h1>
      <p className="account-intro">
        Sign in through your system browser. Tokens stay encrypted on this
        device and never reach the editor.
      </p>
      {connection.error && (
        <div className="account-alert" role="status">
          {connection.error.message}
        </div>
      )}
      <article className="account-card">
        <h2>
          {connection.user_id ? 'Connected account' : 'Connect your service'}
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void invoke({
              operation: 'connect',
              scope: state.scope,
              service_url: service,
            });
          }}
        >
          <label className="field-label" htmlFor="service-url">
            Service URL
          </label>
          <input
            id="service-url"
            className="service-input"
            type="url"
            placeholder="https://notes.example.com"
            value={service}
            required
            autoComplete="url"
            disabled={Boolean(connection.user_id) || signingIn || blocked}
            onChange={(event) => setService(event.target.value)}
          />
          <div className="inline-actions">
            {signingIn ? (
              <>
                <span role="status">Finish sign-in in your browser.</span>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void invoke({ operation: 'cancelConnect' })}
                >
                  Cancel sign-in
                </button>
              </>
            ) : (
              <>
                <button
                  className="primary"
                  type="submit"
                  disabled={!service || blocked}
                >
                  {connection.user_id
                    ? 'Sign in again'
                    : 'Sign in with browser'}
                </button>
                {connection.active_workspace && (
                  <button
                    className="secondary"
                    type="button"
                    disabled={
                      blocked ||
                      connection.status === 'syncing' ||
                      connection.status === 'reauth_required' ||
                      connection.next_retry_at > Date.now()
                    }
                    onClick={() =>
                      void invoke({ operation: 'sync', scope: state.scope })
                    }
                  >
                    Sync now
                  </button>
                )}
              </>
            )}
          </div>
        </form>
        <p className="quiet-note">
          Use only the service URL provided by your administrator; it selects
          your sign-in provider. Access must be provisioned first. This app does
          not create accounts or request Azure API keys.
        </p>
      </article>
      {connection.user_id && (
        <article className="account-card">
          <h2>Choose a workspace</h2>
          <p className="quiet-note">
            Workspace caches are isolated. Device-only drafts are never uploaded
            automatically.
          </p>
          {connection.offline_count > 0 && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={copyOffline}
                disabled={blocked || signingIn}
                onChange={(event) => setCopyOffline(event.target.checked)}
              />
              Copy my device-only drafts ({connection.offline_count}) into the
              workspace I open. Keep the originals on this device. Copies
              include written notes, not raw audio.
            </label>
          )}
          <div className="workspace-list">
            {connection.workspaces.map((workspace) => (
              <button
                key={workspace.id}
                className="workspace-option"
                disabled={
                  blocked ||
                  signingIn ||
                  connection.status === 'reauth_required'
                }
                aria-pressed={connection.active_workspace === workspace.id}
                onClick={() =>
                  void switchScope({
                    operation: 'activateWorkspace',
                    scope: state.scope,
                    workspace_id: workspace.id,
                    copy_offline: copyOffline,
                  })
                }
              >
                <span>{workspace.name}</span>
                <span>
                  {connection.active_workspace === workspace.id
                    ? 'Current workspace'
                    : 'Open workspace'}
                </span>
              </button>
            ))}
            <button
              className="workspace-option"
              disabled={blocked || signingIn}
              aria-pressed={!connection.active_workspace}
              onClick={() =>
                void switchScope({
                  operation: 'workOffline',
                  scope: state.scope,
                })
              }
            >
              <span>On this device</span>
              <span>No cloud upload</span>
            </button>
          </div>
          {!connection.workspaces.length && (
            <p className="quiet-note">
              No workspace access is currently available. Contact your
              administrator or sign in again.
            </p>
          )}
        </article>
      )}
      {connection.active_workspace &&
        ['ready', 'syncing', 'attention'].includes(connection.status) && (
          <AccountUsagePanel key={state.scope} scope={state.scope} />
        )}
      {connection.user_id && (
        <article className="account-card">
          <h2>Disconnect or switch accounts</h2>
          <p className="quiet-note">
            Disconnect before signing in with a different account or service.
            Your browser may keep its own sign-in session.
          </p>
          {!confirmLogout ? (
            <button
              className="secondary"
              disabled={blocked || signingIn}
              onClick={() => setConfirmLogout(true)}
            >
              Disconnect account
            </button>
          ) : (
            <div className="logout-confirm">
              <p>
                Cloud caches and all pending operations will be removed from
                this device. Pending deletions will not be sent. Cloud documents
                and existing remote audio are not deleted. Cached workspace
                audio is deleted too, including recordings not yet uploaded.
                Kept draft copies contain notes only.
              </p>
              {connection.unsent_count > 0 && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={preserve}
                    onChange={(event) => setPreserve(event.target.checked)}
                    disabled={blocked}
                  />
                  Keep my {connection.unsent_count} unsynced drafts as
                  device-only copies.
                </label>
              )}
              <div className="inline-actions">
                <button
                  className="secondary"
                  disabled={blocked}
                  onClick={() => setConfirmLogout(false)}
                >
                  Stay connected
                </button>
                <button
                  className="danger-button"
                  disabled={blocked}
                  onClick={() => {
                    void switchScope({
                      operation: 'disconnect',
                      scope: state.scope,
                      preserve_unsent: preserve,
                    }).then((result) => {
                      if (result) setConfirmLogout(false);
                    });
                  }}
                >
                  {connection.status === 'disconnecting'
                    ? 'Disconnecting...'
                    : 'Confirm disconnect'}
                </button>
              </div>
            </div>
          )}
        </article>
      )}
    </section>
  );
}
