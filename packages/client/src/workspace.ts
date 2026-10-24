import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import {
  oidcClientConfigurationSchema,
  resourceId,
  jobSchema,
  jobHistorySchema,
  cachedTranscriptSchema,
  transcriptPageSchema,
  makeTranscriptPage,
  type TranscriptPage,
  transcriptTimelinePageSchema,
  finalizeTranscriptSchema,
  idempotencyKey,
  accountUsageSchema,
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
import { DesktopSummaries, summaryIntentSchema } from './summaries.js';
import { DesktopChat } from './chat.js';
import type { DesktopDelivery } from './delivery.js';
import { PendingWork } from './lifecycle.js';
import { retryDelay } from './retry.js';

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
const finalizationIntentSchema = z.strictObject({
  body: finalizeTranscriptSchema,
  key: idempotencyKey,
  consent_id: resourceId,
  job_id: resourceId.nullable(),
});

export class WorkspaceController {
  readonly summaries: DesktopSummaries;
  readonly chat: DesktopChat;
  private account: Account | null;
  private session: AccountSession | null = null;
  private api: ApiClient | null = null;
  private engine: SyncEngine | null = null;
  private running: Promise<void> | null = null;
  private readonly background = new PendingWork();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDue = 0;
  private started = false;
  private disposed = false;
  private auth: AbortController | null = null;
  // Critical-state notifications cancel reads, not the transition itself.
  private transition: AbortController | null = null;
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
  private readonly transcriptReads = new Set<AbortController>();
  private readonly finalizationWrites = new Set<string>();
  private jobHistory: {
    profile: string;
    document: string;
    version: string;
    jobs: DesktopState['jobs'];
  } | null = null;
  constructor(
    private readonly local: LocalStore,
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly changed: (change: DesktopChange) => void,
    private readonly options: {
      allowLoopback?: boolean;
      delivery?: DesktopDelivery;
    } = {},
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
    const artifactHooks = {
      ...(options.delivery ? { delivery: options.delivery } : {}),
      owner: (scope) => {
        this.assertScope(scope);
        const profile = this.profile;
        return {
          profile,
          remote: this.recordingUploadContext(),
          authorize: () => {
            this.assertScope(scope);
            if (this.profile !== profile)
              throw new ClientError(
                'workspace_changed',
                'The meeting workspace changed.',
              );
          },
        };
      },
      reads: this.transcriptReads,
      synchronize: () => this.synchronize(),
      revoked: (error, profile, api) =>
        this.artifactRevocation(error, profile, api),
      changed: () => {
        this.emit('data');
        this.schedule(1000);
      },
    } satisfies ConstructorParameters<typeof DesktopChat>[1];
    this.chat = new DesktopChat(local, artifactHooks);
    this.summaries = new DesktopSummaries(local, {
      ...artifactHooks,
      cacheJob: (profile, id, job) => this.cacheJob(profile, id, job),
    });
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
    if (this.critical || kind === 'scope' || kind === 'revoked')
      this.options.delivery?.cancelAll();
    if (this.critical || kind === 'scope' || kind === 'revoked')
      this.summaries?.events.stop();
    if (this.critical || kind === 'scope' || kind === 'revoked')
      this.chat?.events.stop();
    if (this.critical || kind === 'scope' || kind === 'revoked')
      for (const read of this.transcriptReads) read.abort();
    if (kind === 'scope' || kind === 'revoked') {
      this.jobHistory = null;
      this.query = '';
      this.offset = 0;
    }
    this.revision++;
    this.changed({ version: this.revision, scope: this.scopeRevision, kind });
  }
  audioChanged() {
    if (!this.disposed) this.emit('audio');
  }
  async accountUsage(scope: number) {
    this.assertScope(scope);
    const context = this.recordingUploadContext();
    if (!context)
      throw new ClientError(
        'account_usage_unavailable',
        'Reconnect an authorized cloud workspace to read current AI usage.',
      );
    if (this.transcriptReads.size >= 4)
      throw new ClientError(
        'request_busy',
        'Wait for the current account or transcript requests to finish.',
      );
    const read = new AbortController();
    this.transcriptReads.add(read);
    try {
      const usage = await context.api.request('/v1/usage', accountUsageSchema, {
        signal: read.signal,
      });
      context.authorize();
      if (read.signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The account usage request was cancelled.',
        );
      return usage;
    } catch (error) {
      this.artifactRevocation(error, context.profile, context.api);
      throw error;
    } finally {
      this.transcriptReads.delete(read);
    }
  }
  recordingUploadContext() {
    if (
      this.disposed ||
      this.critical ||
      this.auth ||
      !this.api ||
      !this.account?.active_workspace ||
      this.session?.summary().status !== 'active' ||
      this.profile === 'offline'
    )
      return null;
    const scope = this.scope;
    const profile = this.profile;
    const api = this.api;
    return {
      profile,
      scope,
      api,
      allowLoopback: this.options.allowLoopback ?? false,
      reads: this.transcriptReads,
      authorize: () => {
        this.assertScope(scope);
        if (
          this.auth ||
          this.profile !== profile ||
          this.api !== api ||
          this.session?.summary().status !== 'active'
        )
          throw new ClientError(
            'workspace_changed',
            'The workspace or authenticated account changed.',
          );
      },
    };
  }
  private persist(account: Account) {
    this.local.putValue('root', 'account', account);
    this.account = account;
  }
  private cachedJobs(profile: string, document: string): DesktopState['jobs'] {
    const version = this.local.cacheVersion();
    const cached = this.jobHistory;
    if (
      version !== null &&
      cached?.profile === profile &&
      cached.document === document &&
      cached.version === version
    )
      return structuredClone(cached.jobs);
    this.jobHistory = null;
    const jobs = (
      this.local.getArtifact(profile, document, 'job-history', jobHistorySchema)
        ?.jobs ?? []
    ).map((job) => {
      if (job.result?.kind !== 'summary') return job;
      const { summary: _summary, ...result } = job.result;
      return { ...job, result };
    });
    if (version !== null)
      this.jobHistory = { profile, document, version, jobs };
    return structuredClone(jobs);
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
    if (!selected) this.jobHistory = null;
    const details = selected ? this.local.details(profile, selected.id) : null;
    const cached =
      selected && details?.transcript_revision
        ? this.cachedTranscript(
            profile,
            selected.id,
            details.transcript_revision,
          )
        : null;
    const transcript = !cached
      ? null
      : 'offset' in cached
        ? transcriptPageSchema.parse(cached)
        : makeTranscriptPage(
            {
              document_id: cached.document_id,
              revision: cached.revision,
              source: cached.source,
              total_segments: cached.segments.length,
            },
            0,
            cached.segments,
          );
    const account = this.account;
    const summaryIntent = selected
      ? this.local.getArtifact(
          profile,
          selected.id,
          'summary-submission',
          summaryIntentSchema,
        )
      : null;
    return {
      version: this.revision,
      ...(this.options.delivery
        ? {
            presentations: this.options.delivery.markers(
              this.scopeRevision,
              selected?.id ?? null,
            ),
          }
        : {}),
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
      summary_submission: summaryIntent
        ? {
            language: summaryIntent.body.language,
            consent_id: summaryIntent.consent_id,
            job_id: summaryIntent.job_id,
            rejected: summaryIntent.rejected,
            ...(summaryIntent.body.allow_long_context
              ? { allow_long_context: true as const }
              : {}),
            ...(summaryIntent.body.template_id === undefined
              ? {}
              : { template_id: summaryIntent.body.template_id }),
          }
        : null,
      summary_generation: this.summaries.events.snapshot(
        profile,
        selected?.id ?? null,
      ),
      chat_generation: this.chat.events.snapshot(profile, selected?.id ?? null),
      transcript_revision: details?.transcript_revision ?? 0,
      transcript,
      jobs: selected ? this.cachedJobs(profile, selected.id) : [],
    };
  }
  start() {
    this.started = true;
    this.schedule(0);
  }
  dispose() {
    this.options.delivery?.cancelAll();
    this.disposed = true;
    this.started = false;
    this.generation++;
    this.auth?.abort();
    this.session?.cancel();
    this.transition?.abort();
    this.selection.clear();
    this.jobHistory = null;
    this.stopEngine();
  }
  async close() {
    this.dispose();
    await Promise.all([
      this.background.drain(),
      this.summaries.events.close(),
      this.chat.events.close(),
    ]);
  }
  private stopEngine() {
    this.summaries?.events.stop();
    this.chat?.events.stop();
    for (const read of this.transcriptReads) read.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDue = 0;
    this.engine?.stop();
    this.engine = null;
    this.running = null;
  }
  private cachedTranscript(profile: string, id: string, revision: number) {
    const value = this.local.getArtifact(
      profile,
      id,
      `transcript:${revision}`,
      cachedTranscriptSchema,
    );
    if (
      value &&
      (value.document_id !== id ||
        value.revision !== revision ||
        ('offset' in value && value.offset !== 0))
    )
      throw new ClientError(
        'invalid_server_response',
        'The cached transcript does not match this meeting revision.',
      );
    return value;
  }
  async transcriptPage(
    scope: number,
    id: string,
    revision: number,
    offset: number,
  ): Promise<TranscriptPage> {
    this.assertScope(scope);
    const profile = this.profile;
    const draft = this.local.get(profile, id);
    if (draft.status === 'deleted_remote' || draft.remote_revision === 0)
      throw new ClientError(
        'transcript_unavailable',
        'This meeting has no available cloud transcript.',
      );
    const first = this.cachedTranscript(profile, id, revision);
    let cached: TranscriptPage | null = null;
    if (first && !('offset' in first)) {
      if (offset > first.segments.length)
        throw new ClientError(
          'invalid_transcript_page',
          'The requested transcript position is outside this revision.',
        );
      cached = makeTranscriptPage(
        {
          document_id: id,
          revision: first.revision,
          source: first.source,
          total_segments: first.segments.length,
        },
        offset,
        first.segments.slice(offset),
      );
    } else
      cached =
        offset === 0 && first && 'offset' in first
          ? first
          : this.local.getArtifact(
              profile,
              id,
              `transcript-page:${revision}:${offset}`,
              transcriptPageSchema,
            );
    const provenance = (page: TranscriptPage) =>
      canonicalJson({
        candidate: page.is_candidate ?? false,
        base: page.based_on_revision ?? null,
        recording: page.recording ?? null,
      });
    const check = (page: TranscriptPage) => {
      if (
        page.document_id !== id ||
        page.revision !== revision ||
        page.offset !== offset ||
        (first &&
          (page.source !== first.source ||
            ('total_segments' in first &&
              page.total_segments !== first.total_segments) ||
            ('offset' in first && provenance(page) !== provenance(first))))
      )
        throw new ClientError(
          'invalid_server_response',
          'The transcript page does not match the requested revision.',
        );
      return page;
    };
    if (cached) return check(cached);
    const api = this.api;
    if (!api || !this.account?.active_workspace || this.auth)
      throw new ClientError(
        'transcript_not_cached',
        'This page is not cached. Reconnect to download it.',
      );
    if (this.transcriptReads.size >= 4)
      throw new ClientError(
        'transcript_busy',
        'Wait for the current transcript page requests to finish.',
      );
    const controller = new AbortController();
    this.transcriptReads.add(controller);
    const delivery = this.options.delivery?.begin({
      scope,
      document: id,
      kind: 'transcript_page',
      operation_id: null,
      revision,
      offset,
    });
    try {
      const page = await api.transcriptPage(
        id,
        revision,
        offset,
        controller.signal,
      );
      this.assertScope(scope);
      if (api !== this.api || profile !== this.profile || this.auth)
        throw new ClientError(
          'workspace_changed',
          'The active account changed while loading the transcript.',
        );
      if (controller.signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The transcript page request was cancelled.',
        );
      check(page);
      this.local.putArtifact(
        profile,
        id,
        offset === 0
          ? `transcript:${revision}`
          : `transcript-page:${revision}:${offset}`,
        page,
      );
      this.options.delivery?.offer(delivery, 'network');
      return page;
    } catch (error) {
      this.options.delivery?.cancel(delivery);
      if (
        api === this.api &&
        profile === this.profile &&
        !this.disposed &&
        error instanceof ClientError &&
        error.status === 403 &&
        (error.code === 'identity_not_provisioned' ||
          error.code === 'workspace_access_revoked')
      )
        this.revoke(error);
      throw error;
    } finally {
      this.transcriptReads.delete(controller);
    }
  }
  private replaceEngine() {
    this.stopEngine();
    if (this.account?.active_workspace && this.api) {
      const profile = this.profile,
        scope = this.scopeRevision;
      this.engine = new SyncEngine(
        this.local,
        this.api,
        this.account.user_id,
        this.account.active_workspace,
        this.options.delivery
          ? (page, started) => {
              if (
                this.disposed ||
                this.profile !== profile ||
                this.scopeRevision !== scope
              )
                return;
              const delivery = this.options.delivery?.begin(
                {
                  scope,
                  document: page.document_id,
                  kind: 'transcript_page',
                  operation_id: null,
                  revision: page.revision,
                  offset: page.offset,
                },
                started,
              );
              this.options.delivery?.offer(delivery, 'synchronization');
            }
          : undefined,
      );
    }
  }
  async transcriptTimeline(
    scope: number,
    id: string,
    revision: number,
    offset: number,
  ) {
    this.assertScope(scope);
    const profile = this.profile;
    const draft = this.local.get(profile, id);
    if (draft.status === 'deleted_remote' || draft.remote_revision === 0)
      throw new ClientError(
        'transcript_unavailable',
        'This meeting has no available cloud capture evidence.',
      );
    const name = `transcript-timeline:${revision}:${offset}`;
    const cached = this.local.getArtifact(
      profile,
      id,
      name,
      transcriptTimelinePageSchema,
    );
    const first = this.cachedTranscript(profile, id, revision);
    const check = (page: z.infer<typeof transcriptTimelinePageSchema>) => {
      if (
        page.document_id !== id ||
        page.revision !== revision ||
        page.offset !== offset ||
        (first &&
          'recording' in first &&
          first.recording &&
          page.total !== first.recording.timeline_count)
      )
        throw new ClientError(
          'invalid_server_response',
          'The capture timeline does not match this transcript revision.',
        );
      return page;
    };
    if (cached) return check(cached);
    const context = this.recordingUploadContext();
    if (!context)
      throw new ClientError(
        'transcript_not_cached',
        'This capture timeline page is not cached. Reconnect to download it.',
      );
    if (this.transcriptReads.size >= 4)
      throw new ClientError(
        'transcript_busy',
        'Wait for the current transcript requests to finish.',
      );
    const controller = new AbortController();
    this.transcriptReads.add(controller);
    try {
      const page = await context.api.transcriptTimeline(
        id,
        revision,
        offset,
        controller.signal,
      );
      context.authorize();
      if (controller.signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The capture timeline request was cancelled.',
        );
      check(page);
      this.local.putArtifact(profile, id, name, page);
      return page;
    } catch (error) {
      this.artifactRevocation(error, context.profile, context.api);
      throw error;
    } finally {
      this.transcriptReads.delete(controller);
    }
  }
  private artifactRevocation(error: unknown, profile: string, api: ApiClient) {
    if (
      !this.disposed &&
      profile === this.profile &&
      api === this.api &&
      error instanceof ClientError &&
      error.status === 403 &&
      ['identity_not_provisioned', 'workspace_access_revoked'].includes(
        error.code,
      )
    )
      this.revoke(error);
  }
  private cacheJob(
    profile: string,
    id: string,
    job: z.infer<typeof jobSchema>,
  ) {
    if (job.document_id !== id)
      throw new ClientError(
        'invalid_server_response',
        'The service returned another meeting job.',
      );
    const history = this.local.getArtifact(
      profile,
      id,
      'job-history',
      jobHistorySchema,
    );
    this.local.atomic(() => {
      this.local.putArtifact(profile, id, `job:${job.id}`, job);
      this.local.putArtifact(profile, id, 'job-history', {
        jobs: [
          job,
          ...(history?.jobs ?? []).filter((item) => item.id !== job.id),
        ].slice(0, 20),
      });
    });
    this.emit('data');
    this.schedule(0);
  }
  async finalizeRecording(
    command: Extract<
      DesktopCommand,
      { operation: 'finalizeRecordingTranscript' }
    >,
  ) {
    this.assertScope(command.scope);
    const context = this.recordingUploadContext();
    if (!context)
      throw new ClientError(
        'workspace_not_connected',
        'Connect the original cloud workspace before starting transcription.',
      );
    const profile = context.profile,
      id = command.id;
    const upload = this.local.recordingUpload(
      profile,
      id,
      command.recording_id,
    );
    if (!upload?.plan || upload.state !== 'complete')
      throw new ClientError(
        'recording_incomplete',
        'Finish and verify the saved audio upload before transcribing it.',
      );
    const name = `recording-finalization:${command.recording_id}`;
    let intent = this.local.getArtifact(
      profile,
      id,
      name,
      finalizationIntentSchema,
    );
    if (!intent && !command.new_attempt)
      throw new ClientError(
        'transcription_request_missing',
        'There is no saved local request to reconcile. Refresh AI activity to inspect the existing server job.',
      );
    const mutex = `${profile}:${command.recording_id}`;
    if (this.finalizationWrites.has(mutex))
      throw new ClientError(
        'transcription_busy',
        'Wait for the current transcription request to finish.',
      );
    this.finalizationWrites.add(mutex);
    const controller = new AbortController();
    this.transcriptReads.add(controller);
    try {
      const previous = intent;
      if (
        previous?.job_id &&
        command.new_attempt &&
        previous.consent_id !== command.consent_id
      ) {
        const job = await context.api.request(
          `/v1/jobs/${previous.job_id}`,
          jobSchema,
          { signal: controller.signal },
        );
        context.authorize();
        if (job.document_id !== id || job.recording_id !== command.recording_id)
          throw new ClientError(
            'invalid_server_response',
            'The previous transcription does not belong to this recording.',
          );
        if (['queued', 'running', 'retry_wait'].includes(job.state))
          throw new ClientError(
            'job_in_progress',
            'Cancel or finish the existing transcription before starting a new one.',
          );
        intent = null;
      }
      if (!intent) {
        intent = finalizationIntentSchema.parse({
          body: {
            base_revision: this.local.details(profile, id).transcript_revision,
            locale: command.locale,
            seal_sha256: createHash('sha256')
              .update(canonicalJson(upload.plan.seal))
              .digest('hex'),
            accept_incomplete: command.accept_incomplete,
          },
          key: `finalize:${randomUUID()}`,
          consent_id: command.consent_id,
          job_id: null,
        });
        this.local.putArtifact(profile, id, name, intent);
      } else if (
        command.new_attempt &&
        (intent.body.locale !== command.locale ||
          intent.body.accept_incomplete !== command.accept_incomplete)
      )
        throw new ClientError(
          'transcription_intent_frozen',
          `Reconcile the saved ${intent.body.locale} transcription request before changing its language or capture acceptance.`,
        );
      const job = await context.api.finalizeRecording(
        command.recording_id,
        intent.body,
        intent.key,
        controller.signal,
      );
      context.authorize();
      if (controller.signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The request was cancelled; its saved idempotency key was preserved.',
        );
      if (
        job.kind !== 'recording_transcription' ||
        job.recording_id !== command.recording_id ||
        job.document_id !== id
      )
        throw new ClientError(
          'invalid_server_response',
          'The service returned an inconsistent recording transcription.',
        );
      this.local.putArtifact(profile, id, name, { ...intent, job_id: job.id });
      this.cacheJob(profile, id, job);
    } catch (error) {
      this.artifactRevocation(error, context.profile, context.api);
      throw error;
    } finally {
      this.transcriptReads.delete(controller);
      this.finalizationWrites.delete(mutex);
    }
    return this.snapshot();
  }
  async controlTranscription(
    command: Extract<DesktopCommand, { operation: 'controlTranscriptionJob' }>,
  ) {
    this.assertScope(command.scope);
    const context = this.recordingUploadContext();
    if (!context)
      throw new ClientError(
        'workspace_not_connected',
        'Reconnect before changing server transcription jobs.',
      );
    this.local.get(context.profile, command.id);
    const controller = new AbortController();
    this.transcriptReads.add(controller);
    try {
      const job = await context.api.request(
        `/v1/jobs/${command.job_id}`,
        jobSchema,
        { signal: controller.signal },
      );
      context.authorize();
      if (
        job.document_id !== command.id ||
        job.kind !== 'recording_transcription'
      )
        throw new ClientError(
          'invalid_desktop_request',
          'This transcription does not belong to the selected meeting.',
        );
      const result =
        command.action === 'cancel'
          ? (
              await context.api.request(
                `/v1/jobs/${job.id}/cancel`,
                z.strictObject({
                  already_terminal: z.boolean(),
                  job: jobSchema,
                }),
                { method: 'POST', body: {}, signal: controller.signal },
              )
            ).job
          : await context.api.request(`/v1/jobs/${job.id}/retry`, jobSchema, {
              method: 'POST',
              body: { confirmed: true },
              signal: controller.signal,
            });
      context.authorize();
      if (controller.signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The transcription control request was cancelled.',
        );
      this.cacheJob(context.profile, command.id, result);
    } catch (error) {
      this.artifactRevocation(error, context.profile, context.api);
      throw error;
    } finally {
      this.transcriptReads.delete(controller);
    }
    return this.snapshot();
  }
  async applyTranscript(
    command: Extract<DesktopCommand, { operation: 'applyTranscript' }>,
  ) {
    this.assertScope(command.scope);
    const context = this.recordingUploadContext();
    if (!context)
      throw new ClientError(
        'workspace_not_connected',
        'Reconnect before applying a transcript.',
      );
    const profile = context.profile,
      id = command.id;
    const name = `transcript-application:${command.source_revision}:${command.base_revision}`;
    let key = this.local.getArtifact(profile, id, name, idempotencyKey);
    if (!key) {
      key = `apply:${randomUUID()}`;
      this.local.putArtifact(profile, id, name, key);
    }
    const controller = new AbortController();
    this.transcriptReads.add(controller);
    try {
      const page = await context.api.request(
        `/v1/documents/${id}/transcript/apply`,
        transcriptPageSchema,
        {
          method: 'POST',
          body: {
            base_revision: command.base_revision,
            source_revision: command.source_revision,
            confirmed: true,
          },
          key,
          signal: controller.signal,
        },
      );
      context.authorize();
      if (controller.signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The transcript decision was cancelled; its saved request key was preserved.',
        );
      if (page.document_id !== id || page.is_candidate || page.offset !== 0)
        throw new ClientError(
          'invalid_server_response',
          'The service returned an inconsistent applied transcript.',
        );
      this.local.putArtifact(profile, id, `transcript:${page.revision}`, page);
      await this.synchronize();
    } catch (error) {
      this.artifactRevocation(error, context.profile, context.api);
      throw error;
    } finally {
      this.transcriptReads.delete(controller);
    }
    return this.snapshot();
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
          if (error instanceof ClientError && error.code === 'sync_backoff') {
            this.schedule(Math.max(0, this.retryAt - Date.now()));
            return;
          }
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
    const work = this.background.track(
      this.runSync(engine, session).finally(() => {
        if (this.running === work) this.running = null;
      }),
    );
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
            retryDelay(
              Math.min(60_000, 1000 * 2 ** Math.min(this.retryCount, 6)),
              error instanceof ClientError ? error.retryAfterSeconds * 1000 : 0,
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
    const transition = (this.transition = new AbortController());
    const generation = this.generation;
    try {
      this.status = 'switching';
      this.emit('status');
      const identity = await api.identity(transition.signal);
      const memberships = await api.workspaces(transition.signal);
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
      if (this.transition === transition) this.transition = null;
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
    const transition = (this.transition = new AbortController());
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
      this.status = 'disconnecting';
      this.emit('status');
      const result = this.session
        ? await this.session.logout(
            forget,
            AbortSignal.any([transition.signal, AbortSignal.timeout(20_000)]),
          )
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
      if (this.transition === transition) this.transition = null;
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
        this.chat.events.stop();
        this.local.atomic(() => {
          const draft = this.local.create(profile, command.value);
          this.local.putValue(profile, 'selected-document', draft.id);
        });
        this.selection.delete(profile);
      } else if (command.operation === 'select') {
        this.summaries.events.stop();
        this.chat.events.stop();
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
        this.summaries.events.stop();
        this.chat.events.stop();
        this.local.get(profile, command.id);
        this.local.remove(profile, command.id);
      } else if (command.operation === 'resolve') {
        this.chat.events.stop();
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
