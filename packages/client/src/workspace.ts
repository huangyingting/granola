import { z } from 'zod';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import {
  oidcClientConfigurationSchema,
  resourceId,
  jobSchema,
  transcriptSchema,
} from '@windows-ai-notes/contracts/server';
import type {
  DesktopChange,
  DesktopCommand,
  DesktopConnection,
  DesktopState,
} from '@windows-ai-notes/contracts/desktop';
import { AccountSession, clientConfiguration, OidcClient } from './auth.js';
import { ApiClient, ClientError, serverUrl } from './http.js';
import { SyncEngine, workspaceProfile } from './sync.js';

const workspaceSchema = z.strictObject({
  id: resourceId,
  name: z.string().max(200),
});
const accountSchema = z.strictObject({
  service: z.string(),
  configuration: oidcClientConfigurationSchema,
  user_id: resourceId,
  subject: z.string().min(1).max(1024),
  workspaces: z.array(workspaceSchema),
  active_workspace: resourceId.nullable(),
});
type Account = z.infer<typeof accountSchema>;
type ConnectionError = NonNullable<DesktopConnection['error']>;

export class WorkspaceController {
  private account: Account | null;
  private session: AccountSession | null = null;
  private api: ApiClient | null = null;
  private engine: SyncEngine | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDue = 0;
  private started = false;
  private disposed = false;
  private auth: AbortController | null = null;
  private generation = 0;
  private critical = false;
  private retryCount = 0;
  private retryAt = 0;
  private status: DesktopConnection['status'] = 'offline';
  private error: ConnectionError | null = null;
  private revision = 1;
  private scopeRevision = 1;
  private service: string | null;
  private pendingPurge = new Set<string>();
  private query = '';
  private offset = 0;
  private readonly selection = new Map<string, string | null>();
  constructor(
    private readonly local: LocalStore,
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly changed: (change: DesktopChange) => void,
    private readonly options: { allowLoopback?: boolean } = {},
  ) {
    this.account = local.getValue('root', 'account', accountSchema);
    this.service = local.getValue('root', 'service', z.string());
    if (this.account) {
      this.service = serverUrl(this.account.service, options.allowLoopback);
      this.session = this.createSession(
        this.account.configuration,
        this.service,
      );
      const summary = this.session.summary();
      this.status =
        summary.status === 'active' && summary.subject === this.account.subject
          ? 'ready'
          : 'reauth_required';
      this.api = this.createApi(this.session, this.service);
      if (this.status === 'ready') this.replaceEngine();
    }
    this.local.purgeCredentials(this.session?.profile ?? null);
  }
  get scope() {
    return this.scopeRevision;
  }
  get profile(): string {
    return this.account?.active_workspace
      ? this.profileFor(this.account, this.account.active_workspace)
      : 'offline';
  }
  private profileFor(account: Account, workspace: string) {
    return workspaceProfile(
      account.service,
      account.user_id,
      workspace,
      this.options.allowLoopback,
    );
  }
  private createSession(
    configuration: Account['configuration'],
    service: string,
  ) {
    return new AccountSession(
      this.local,
      new OidcClient(configuration, this.options.allowLoopback),
      service,
      this.options.allowLoopback,
    );
  }
  private createApi(session: AccountSession, service: string) {
    return new ApiClient(
      service,
      async () => ({ Authorization: await session.authorization() }),
      this.options,
    );
  }
  assertScope(scope: number) {
    if (this.disposed)
      throw new ClientError('workspace_closed', 'This workspace has closed.');
    if (scope !== this.scopeRevision)
      throw new ClientError(
        'workspace_changed',
        'The active workspace changed. Reload before editing.',
      );
    if (this.critical)
      throw new ClientError(
        'workspace_transition',
        'Wait for the workspace change to finish.',
      );
  }
  private emit(kind: DesktopChange['kind']) {
    if (kind === 'scope' || kind === 'revoked') {
      this.query = '';
      this.offset = 0;
    }
    this.revision++;
    this.changed({ version: this.revision, scope: this.scopeRevision, kind });
  }
  private persist(account: Account) {
    this.local.putValue('root', 'account', account);
    this.account = account;
  }
  snapshot(): DesktopState {
    if (this.disposed)
      throw new ClientError('workspace_closed', 'This workspace has closed.');
    const profile = this.profile;
    const page = this.local.page(profile, this.query, this.offset);
    const requested = this.selection.has(profile)
      ? this.selection.get(profile)
      : this.local.getValue(profile, 'selected-document', resourceId);
    let selected: DesktopState['selected'] = null;
    if (requested) {
      try {
        selected = this.local.get(profile, requested);
      } catch (error) {
        if (
          !(error instanceof LocalError) ||
          error.code !== 'local_document_missing'
        )
          throw error;
      }
    }
    if (!selected) {
      const first = page.documents[0] ?? this.local.page(profile).documents[0];
      if (first) selected = this.local.get(profile, first.id);
    }
    this.selection.set(profile, selected?.id ?? null);
    const details = selected ? this.local.details(profile, selected.id) : null;
    const account = this.account;
    return {
      version: this.revision,
      scope: this.scopeRevision,
      ...page,
      selected,
      query: this.query,
      offset: this.offset,
      selected_id: selected?.id ?? null,
      storage: 'encrypted',
      connection: {
        status: this.status,
        service_url: this.service,
        user_id: this.account?.user_id ?? null,
        workspaces: this.account?.workspaces ?? [],
        active_workspace: this.account?.active_workspace ?? null,
        unsent_count:
          account?.workspaces.reduce(
            (sum, workspace) =>
              sum +
              this.local.unsentCount(this.profileFor(account, workspace.id)),
            0,
          ) ?? 0,
        offline_count: this.local.unsentCount('offline'),
        next_retry_at: this.retryAt,
        error: this.error,
      },
      conflict: details?.conflict ?? null,
      transcript_revision: details?.transcript_revision ?? 0,
      transcript:
        selected && details?.transcript_revision
          ? this.local.getArtifact(
              profile,
              selected.id,
              `transcript:${details.transcript_revision}`,
              transcriptSchema,
            )
          : null,
      jobs: selected
        ? (this.local.getArtifact(
            profile,
            selected.id,
            'job-history',
            z.strictObject({ jobs: z.array(jobSchema).max(20) }),
          )?.jobs ?? [])
        : [],
    };
  }
  start() {
    this.started = true;
    this.schedule(0);
  }
  dispose() {
    this.disposed = true;
    this.started = false;
    this.generation++;
    this.auth?.abort();
    this.session?.cancel();
    this.selection.clear();
    this.stopEngine();
  }
  private stopEngine() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDue = 0;
    this.engine?.stop();
    this.engine = null;
    this.running = null;
  }
  private replaceEngine() {
    this.stopEngine();
    if (this.account?.active_workspace && this.api) {
      this.engine = new SyncEngine(
        this.local,
        this.api,
        this.account.user_id,
        this.account.active_workspace,
      );
    }
  }
  private schedule(delay: number) {
    if (
      !this.started ||
      this.disposed ||
      !this.engine ||
      this.auth ||
      this.critical ||
      this.status === 'reauth_required' ||
      (this.error && !this.error.retryable)
    )
      return;
    const due = Math.max(Date.now() + delay, this.retryAt);
    if (this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.synchronize().catch((error: unknown) => {
          if (error instanceof ClientError && error.code === 'sync_cancelled')
            return;
          console.error(
            JSON.stringify({
              code: 'background_sync_failed',
              kind: error instanceof Error ? error.name : 'unknown',
            }),
          );
        });
      },
      Math.max(0, due - Date.now()),
    );
  }
  synchronize(): Promise<void> {
    if (this.running) return this.running;
    if (!this.engine || !this.session)
      return Promise.reject(
        new ClientError(
          'not_connected',
          'Select a connected workspace before synchronizing.',
        ),
      );
    if (this.retryAt > Date.now())
      return Promise.reject(
        new ClientError(
          'sync_backoff',
          'The service requested a pause. Synchronization will retry automatically.',
          429,
          true,
        ),
      );
    const engine = this.engine;
    const session = this.session;
    const work = this.runSync(engine, session).finally(() => {
      if (this.running === work) this.running = null;
    });
    this.running = work;
    return work;
  }
  private async runSync(engine: SyncEngine, session: AccountSession) {
    this.status = 'syncing';
    this.emit('status');
    try {
      let result: { more: boolean };
      try {
        result = await engine.synchronize();
      } catch (error) {
        if (
          !(error instanceof ClientError) ||
          error.status !== 401 ||
          engine !== this.engine ||
          session.summary().status !== 'active'
        )
          throw error;
        await session.authorization(true);
        result = await engine.synchronize();
      }
      if (engine !== this.engine || this.disposed)
        throw new ClientError('sync_cancelled', 'Synchronization stopped.');
      this.retryCount = 0;
      this.retryAt = 0;
      this.status = 'ready';
      this.error = null;
      this.emit('data');
      this.schedule(result.more ? 1000 : 10_000);
    } catch (error) {
      if (engine !== this.engine || this.disposed)
        throw new ClientError('sync_cancelled', 'Synchronization stopped.');
      if (
        error instanceof ClientError &&
        error.status === 403 &&
        (error.code === 'identity_not_provisioned' ||
          error.code === 'workspace_access_revoked')
      ) {
        this.revoke(error);
      } else {
        this.error = this.describe(error);
        this.status =
          (error instanceof ClientError && error.status === 401) ||
          session.summary().status !== 'active'
            ? 'reauth_required'
            : 'attention';
        this.retryCount++;
        this.retryAt = this.error.retryable
          ? Date.now() +
            Math.max(
              error instanceof ClientError ? error.retryAfterSeconds * 1000 : 0,
              Math.min(60_000, 1000 * 2 ** Math.min(this.retryCount, 6)),
            )
          : 0;
        this.emit('data');
        this.schedule(Math.max(0, this.retryAt - Date.now()));
      }
      throw error;
    }
  }
  private describe(error: unknown): ConnectionError {
    if (error instanceof ClientError || error instanceof LocalError)
      return {
        code: error.code,
        message: error.message,
        retryable: error instanceof ClientError && error.retryable,
      };
    console.error(
      JSON.stringify({
        code: 'workspace_operation_failed',
        kind: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return {
      code: 'workspace_operation_failed',
      message:
        'The workspace operation failed. Existing local data was preserved.',
      retryable: false,
    };
  }
  private revoke(error: ClientError) {
    const account = this.account;
    if (!account) throw error;
    const all = error.code === 'identity_not_provisioned';
    this.stopEngine();
    this.reconcileMemberships(
      account,
      all
        ? []
        : account.workspaces.filter(
            (workspace) => workspace.id !== account.active_workspace,
          ),
      error,
      all,
    );
  }
  private reconcileMemberships(
    account: Account,
    workspaces: Account['workspaces'],
    reason = new ClientError(
      'workspace_access_revoked',
      'Workspace access changed. Revoked workspace caches and unsent edits were removed.',
      403,
    ),
    forgetCredentials = false,
  ) {
    const removed = account.workspaces.filter(
      (workspace) => !workspaces.some((item) => item.id === workspace.id),
    );
    const lost =
      account.active_workspace !== null &&
      !workspaces.some(
        (workspace) => workspace.id === account.active_workspace,
      );
    const next = {
      ...account,
      active_workspace: lost ? null : account.active_workspace,
      workspaces,
    };
    for (const workspace of removed)
      this.pendingPurge.add(this.profileFor(account, workspace.id));
    let purgeFailure: unknown;
    try {
      this.local.atomic(() => {
        for (const profile of this.pendingPurge)
          this.local.purgeProfile(profile);
        this.local.putValue('root', 'account', next);
        if (forgetCredentials) this.local.purgeCredentials();
      });
      this.pendingPurge.clear();
    } catch (failure) {
      purgeFailure = failure;
    }
    if (forgetCredentials) this.session?.cancel();
    this.account = next;
    if (lost) this.scopeRevision++;
    this.status = forgetCredentials ? 'reauth_required' : 'ready';
    this.error = purgeFailure
      ? {
          code: 'revoked_cache_removal_failed',
          message:
            'Access was revoked and the workspace is blocked. Its encrypted cache could not be removed. Keep local files protected and retry disconnecting after resolving the storage error.',
          retryable: false,
        }
      : removed.length || forgetCredentials
        ? this.describe(reason)
        : null;
    this.retryAt = 0;
    this.emit(lost ? 'revoked' : 'status');
    if (purgeFailure) throw purgeFailure;
    return next;
  }
  private checkOperation(generation: number) {
    if (
      this.disposed ||
      generation !== this.generation ||
      this.auth?.signal.aborted
    )
      throw new ClientError(
        'authentication_cancelled',
        'This account operation was cancelled.',
      );
  }
  private async connect(service: string) {
    const origin = serverUrl(service, this.options.allowLoopback);
    if (this.auth || this.critical)
      throw new ClientError(
        'authentication_in_progress',
        'Finish or cancel the current account operation.',
      );
    if (this.account && this.account.service !== origin)
      throw new ClientError(
        'disconnect_first',
        'Disconnect this account before connecting another service.',
      );
    this.stopEngine();
    this.session?.cancel();
    const generation = ++this.generation;
    const auth = (this.auth = new AbortController());
    this.status = 'connecting';
    this.error = null;
    this.service = origin;
    this.local.putValue('root', 'service', origin);
    this.emit('status');
    try {
      if (this.session) await this.session.logout(undefined, auth.signal);
      this.checkOperation(generation);
      const configuration = await clientConfiguration(
        origin,
        this.options.allowLoopback,
        auth.signal,
      );
      this.checkOperation(generation);
      const session = this.createSession(configuration, origin);
      this.session = session;
      const summary = await session.signIn(this.openBrowser);
      this.checkOperation(generation);
      if (!summary.subject)
        throw new ClientError(
          'invalid_identity_token',
          'The signed-in identity has no verified subject.',
        );
      const api = this.createApi(session, origin);
      const identity = await api.identity(auth.signal);
      this.checkOperation(generation);
      if (this.account && identity.id !== this.account.user_id) {
        await session.logout(undefined, auth.signal);
        throw new ClientError(
          'account_mismatch',
          'This is a different account. Disconnect the previous account before switching.',
        );
      }
      const memberships = await api.workspaces(auth.signal);
      this.checkOperation(generation);
      const previous = this.account;
      const reconciled = previous
        ? this.reconcileMemberships(previous, memberships.workspaces)
        : null;
      const next: Account = {
        service: origin,
        configuration,
        user_id: identity.id,
        subject: summary.subject,
        workspaces: memberships.workspaces,
        active_workspace: reconciled?.active_workspace ?? null,
      };
      this.local.putValue('root', 'account', next);
      this.account = next;
      this.api = api;
      this.status = 'ready';
      this.retryAt = 0;
      this.retryCount = 0;
      this.replaceEngine();
      this.emit('status');
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        if (this.pendingPurge.size) {
          this.status = 'attention';
          this.emit('status');
          throw error;
        }
        if (
          error instanceof ClientError &&
          error.code === 'identity_not_provisioned' &&
          error.status === 403 &&
          this.account &&
          this.session?.summary().subject === this.account.subject
        )
          this.revoke(error);
        else {
          if (this.session) {
            try {
              await this.session.logout(undefined, AbortSignal.abort());
            } catch (cleanupError) {
              if (generation === this.generation && !this.disposed) {
                this.status = 'attention';
                this.error = this.describe(cleanupError);
                this.emit('status');
              }
              throw cleanupError;
            }
          }
          if (generation !== this.generation || this.disposed) throw error;
          this.status = this.account ? 'reauth_required' : 'offline';
          this.error = this.describe(error);
          this.emit('status');
        }
      }
      throw error;
    } finally {
      if (generation === this.generation) {
        this.auth = null;
        this.schedule(0);
      }
    }
  }
  private async cancelConnect() {
    if (!this.auth) return;
    const generation = ++this.generation;
    this.auth.abort();
    this.auth = null;
    this.session?.cancel();
    if (this.session) await this.session.logout(undefined, AbortSignal.abort());
    if (this.disposed || generation !== this.generation) return;
    this.status = this.account ? 'reauth_required' : 'offline';
    this.error = {
      code: 'authentication_cancelled',
      message: 'Sign-in was cancelled. Local notes were not changed.',
      retryable: false,
    };
    this.emit('status');
  }
  private async activate(workspace: string, copyOffline: boolean) {
    const account = this.account;
    const api = this.api;
    if (
      !account ||
      !api ||
      !this.session ||
      this.session.summary().status !== 'active'
    )
      throw new ClientError(
        'reauthentication_required',
        'Sign in before selecting a workspace.',
        401,
      );
    if (this.auth)
      throw new ClientError(
        'authentication_in_progress',
        'Finish or cancel sign-in first.',
      );
    this.critical = true;
    this.stopEngine();
    this.status = 'switching';
    this.emit('status');
    const generation = this.generation;
    try {
      const identity = await api.identity();
      const memberships = await api.workspaces();
      if (this.disposed || generation !== this.generation)
        throw new ClientError(
          'sync_cancelled',
          'The workspace change was cancelled.',
        );
      if (identity.id !== account.user_id)
        throw new ClientError(
          'account_mismatch',
          'The signed-in account changed. Disconnect before switching accounts.',
        );
      this.reconcileMemberships(account, memberships.workspaces);
      if (!memberships.workspaces.some((item) => item.id === workspace))
        throw new ClientError(
          'workspace_access_revoked',
          'You no longer have access to this workspace. Its cached notes and unsent workspace edits were removed.',
          403,
        );
      const next = {
        ...account,
        workspaces: memberships.workspaces,
        active_workspace: workspace,
      };
      this.local.atomic(() => {
        if (copyOffline)
          this.local.copyDrafts(
            'offline',
            this.profileFor(next, workspace),
            'all',
          );
        this.local.putValue('root', 'account', next);
      });
      this.account = next;
      this.scopeRevision++;
      this.status = 'ready';
      this.error = null;
      this.retryAt = 0;
      this.replaceEngine();
      this.emit('scope');
    } catch (error) {
      if (!this.disposed) {
        if (this.pendingPurge.size) {
          this.status = 'attention';
          this.emit('status');
          throw error;
        }
        if (
          error instanceof ClientError &&
          error.code === 'identity_not_provisioned' &&
          error.status === 403
        )
          this.revoke(error);
        else {
          this.error = this.describe(error);
          this.status = 'attention';
          this.replaceEngine();
          this.emit('status');
        }
      }
      throw error;
    } finally {
      this.critical = false;
      if (!this.disposed) this.schedule(0);
    }
  }
  private offline() {
    this.stopEngine();
    if (this.account) this.persist({ ...this.account, active_workspace: null });
    this.scopeRevision++;
    this.retryAt = 0;
    this.status = this.account
      ? this.session?.summary().status === 'active'
        ? 'ready'
        : 'reauth_required'
      : 'offline';
    this.emit('scope');
  }
  private async disconnect(preserve: boolean) {
    if (this.auth)
      throw new ClientError(
        'authentication_in_progress',
        'Cancel sign-in before disconnecting.',
      );
    this.stopEngine();
    this.critical = true;
    this.status = 'disconnecting';
    this.emit('status');
    const account = this.account;
    const forget: () => undefined = () => {
      if (account)
        for (const workspace of account.workspaces) {
          const profile = this.profileFor(account, workspace.id);
          if (preserve) this.local.copyDrafts(profile, 'offline', 'unsent');
          this.local.purgeProfile(profile);
        }
      this.local.deleteValue('root', 'account');
      for (const profile of this.pendingPurge) this.local.purgeProfile(profile);
      this.local.purgeCredentials();
    };
    try {
      const result = this.session
        ? await this.session.logout(forget)
        : (this.local.atomic(forget), null);
      if (this.disposed)
        throw new ClientError('workspace_closed', 'The workspace has closed.');
      this.account = null;
      this.pendingPurge.clear();
      this.session = null;
      this.api = null;
      this.scopeRevision++;
      this.status = 'offline';
      this.retryAt = 0;
      this.error =
        result && result.remote !== 'revoked'
          ? {
              code: 'provider_revocation_unconfirmed',
              message:
                result.remote === 'unsupported'
                  ? 'Local account data was removed. This identity provider does not support token revocation; its browser session may still be signed in.'
                  : 'Local account data was removed. Remote token revocation could not be confirmed; its browser session may still be signed in.',
              retryable: false,
            }
          : null;
      this.emit('scope');
    } catch (error) {
      if (!this.disposed) {
        this.status = 'attention';
        this.error = this.describe(error);
        this.emit('status');
      }
      throw error;
    } finally {
      this.critical = false;
    }
  }
  async execute(command: DesktopCommand): Promise<DesktopState> {
    if (command.operation === 'bootstrap') return this.snapshot();
    if (command.operation === 'cancelConnect') {
      await this.cancelConnect();
      return this.snapshot();
    }
    if (!('scope' in command))
      throw new ClientError(
        'unsupported_command',
        'This command requires the native desktop host.',
      );
    this.assertScope(command.scope);
    if (command.operation === 'connect')
      await this.connect(command.service_url);
    else if (command.operation === 'activateWorkspace')
      await this.activate(command.workspace_id, command.copy_offline);
    else if (command.operation === 'workOffline') this.offline();
    else if (command.operation === 'disconnect')
      await this.disconnect(command.preserve_unsent);
    else if (command.operation === 'sync') {
      if (this.error && !this.error.retryable) this.error = null;
      await this.synchronize();
    } else {
      const profile = this.profile;
      if (command.operation === 'search') {
        this.query = command.query;
        this.offset = command.offset;
      } else if (command.operation === 'create') {
        this.local.atomic(() => {
          const draft = this.local.create(profile, command.value);
          this.local.putValue(profile, 'selected-document', draft.id);
        });
        this.selection.delete(profile);
      } else if (command.operation === 'select') {
        this.local.get(profile, command.id);
        this.local.putValue(profile, 'selected-document', command.id);
        this.selection.delete(profile);
      } else if (command.operation === 'save') {
        this.local.save(
          profile,
          command.id,
          command.local_revision,
          command.value,
        );
      } else if (command.operation === 'delete') {
        this.local.get(profile, command.id);
        this.local.remove(profile, command.id);
      } else if (command.operation === 'resolve') {
        this.local.atomic(() => {
          const draft = this.local.resolve(profile, command.id, command.choice);
          if (draft)
            this.local.putValue(profile, 'selected-document', draft.id);
        });
        this.selection.delete(profile);
      } else
        throw new ClientError(
          'unsupported_command',
          'This command requires the native desktop host.',
        );
      this.revision++;
      if (command.operation !== 'select' && command.operation !== 'search')
        this.schedule(1000);
    }
    return this.snapshot();
  }
}
