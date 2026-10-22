import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextSchema,
} from '@windows-ai-notes/contracts/content';
import {
  jobSchema,
  summaryRequestSchema,
  idempotencyKey,
  LONG_SUMMARY_VERSION,
  summaryCapabilitiesSchema,
} from '@windows-ai-notes/contracts/server';
import {
  summaryCitations,
  summaryText,
  summaryReferences,
  summaryReviewSchema,
  summarySourceSchema,
  type SummaryReview,
} from '@windows-ai-notes/contracts/generation';
import type { DesktopCommand } from '@windows-ai-notes/contracts/desktop';
import {
  DEFAULT_SUMMARY_TEMPLATE,
  summaryTemplateCatalogSchema,
} from '@windows-ai-notes/contracts/templates';
import { ApiClient, ClientError } from './http.js';
import { summaryProgressSchema } from '@windows-ai-notes/contracts/evidence';

export const summaryIntentSchema = z.strictObject({
  body: summaryRequestSchema,
  key: idempotencyKey,
  consent_id: z.uuidv4(),
  job_id: z.uuidv4().nullable(),
  rejected: z.boolean().default(false),
});
type Owner = {
  profile: string;
  authorize: () => void;
  remote: { api: ApiClient; authorize: () => void } | null;
};
type Hooks = {
  owner: (scope: number) => Owner;
  synchronize: () => Promise<void>;
  changed: () => void;
  cacheJob: (
    profile: string,
    id: string,
    job: z.infer<typeof jobSchema>,
  ) => void;
  revoked: (error: unknown, profile: string, api: ApiClient) => void;
  reads: Set<AbortController>;
};
type Command<Name extends DesktopCommand['operation']> = Extract<
  DesktopCommand,
  { operation: Name }
>;
const problem = (code: string, message: string) =>
  new ClientError(code, message);
const active = (job: z.infer<typeof jobSchema>) =>
  ['queued', 'running', 'retry_wait'].includes(job.state);
function summaryJob(
  job: z.infer<typeof jobSchema>,
  id: string,
  expectedId?: string,
) {
  if (
    job.document_id !== id ||
    job.kind !== 'summary' ||
    (expectedId !== undefined && job.id !== expectedId)
  )
    throw problem(
      'invalid_server_response',
      'The service returned another meeting or job type.',
    );
  return job;
}

export class DesktopSummaries {
  private readonly writes = new Set<string>();
  constructor(
    private readonly local: LocalStore,
    private readonly hooks: Hooks,
  ) {}
  private async remote<T>(
    scope: number,
    id: string,
    operation: (
      owner: Owner & { api: ApiClient },
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    const owner = this.hooks.owner(scope);
    this.local.get(owner.profile, id);
    const remote = owner.remote;
    if (!remote)
      throw problem(
        'workspace_not_connected',
        'Reconnect the original cloud workspace for this summary operation.',
      );
    if (this.hooks.reads.size >= 4)
      throw problem(
        'request_busy',
        'Wait for the current account or meeting requests to finish.',
      );
    const read = new AbortController();
    this.hooks.reads.add(read);
    const authorize = () => {
      owner.authorize();
      remote.authorize();
      if (read.signal.aborted)
        throw problem(
          'request_cancelled',
          'The summary request was cancelled. Any saved request key was preserved.',
        );
      this.local.get(owner.profile, id);
    };
    try {
      authorize();
      const value = await operation(
        { ...owner, api: remote.api, authorize },
        read.signal,
      );
      authorize();
      return value;
    } catch (error) {
      let failure = error;
      if (
        error instanceof ClientError &&
        ['job_not_found', 'document_not_found'].includes(error.code)
      ) {
        // Job reads hide revoked documents behind 404; synchronize through the workspace guard.
        authorize();
        try {
          await this.hooks.synchronize();
          authorize();
        } catch (accessError) {
          failure = accessError;
        }
      }
      this.hooks.revoked(failure, owner.profile, remote.api);
      throw failure;
    } finally {
      this.hooks.reads.delete(read);
    }
  }
  async templates(scope: number, id: string) {
    return this.remote(scope, id, (context, signal) =>
      context.api.request('/v1/templates', summaryTemplateCatalogSchema, {
        signal,
      }),
    );
  }
  async start(command: Command<'startSummary'>) {
    if (command.confirmed !== true)
      throw problem(
        'summary_consent_required',
        'Confirm Azure processing before generating a summary.',
      );
    const owner = this.hooks.owner(command.scope);
    const mutex = `${owner.profile}:${command.id}`;
    if (this.writes.has(mutex))
      throw problem(
        'summary_busy',
        'Wait for the current summary submission to finish.',
      );
    this.writes.add(mutex);
    try {
      await this.remote(command.scope, command.id, async (context, signal) => {
        let intent = this.local.getArtifact(
          context.profile,
          command.id,
          'summary-submission',
          summaryIntentSchema,
        );
        if (!intent && !command.new_attempt)
          throw problem(
            'summary_request_missing',
            'There is no saved summary request to recover.',
          );
        if (
          intent &&
          command.new_attempt &&
          intent.consent_id !== command.consent_id
        ) {
          if (intent.rejected) intent = null;
          else if (!intent.job_id)
            throw problem(
              'summary_request_unresolved',
              'Recover the saved request before starting another billable summary.',
            );
          if (intent) {
            const previous = summaryJob(
              await context.api.request(
                `/v1/jobs/${intent.job_id}`,
                jobSchema,
                {
                  signal,
                },
              ),
              command.id,
              intent.job_id ?? undefined,
            );
            context.authorize();
            this.hooks.cacheJob(context.profile, command.id, previous);
            if (active(previous))
              throw problem(
                'job_in_progress',
                'Finish or cancel the current summary before generating another.',
              );
            intent = null;
          }
        }
        if (!intent) {
          const template = command.template_id ?? DEFAULT_SUMMARY_TEMPLATE;
          const [catalog, capability] = await Promise.all([
            context.api.request('/v1/templates', summaryTemplateCatalogSchema, {
              signal,
            }),
            command.allow_long_context
              ? context.api.request(
                  '/v1/summary-capabilities',
                  summaryCapabilitiesSchema,
                  { signal },
                )
              : Promise.resolve(null),
          ]);
          context.authorize();
          if (
            command.allow_long_context &&
            capability?.long_meetings !== LONG_SUMMARY_VERSION
          )
            throw problem(
              'unsupported_summary_context',
              'The connected service does not support this long-meeting processing version.',
            );
          if (!catalog.templates.some((item) => item.id === template))
            throw problem(
              'unsupported_summary_template',
              'Choose a summary template supported by the connected service.',
            );
          await this.hooks.synchronize();
          context.authorize();
          const draft = this.local.get(context.profile, command.id);
          if (draft.status !== 'synced')
            throw problem(
              'summary_input_unsynced',
              'Save and synchronize these notes, resolving conflicts before generating.',
            );
          const document = await context.api.document(command.id, signal);
          context.authorize();
          const latest = this.local.get(context.profile, command.id);
          if (
            document.id !== command.id ||
            latest.local_revision !== draft.local_revision ||
            latest.status !== 'synced' ||
            latest.remote_revision !== document.revision
          )
            throw problem(
              'summary_input_changed',
              'The meeting changed during preparation. Synchronize and review the latest notes before starting.',
            );
          intent = summaryIntentSchema.parse({
            body: {
              note_revision: document.revision,
              transcript_revision: document.transcript_revision,
              language: command.language,
              ...(template === DEFAULT_SUMMARY_TEMPLATE
                ? {}
                : { template_id: template }),
              ...(command.allow_long_context
                ? { allow_long_context: true }
                : {}),
            },
            key: `summary:${randomUUID()}`,
            consent_id: command.consent_id,
            job_id: null,
          });
          this.local.putArtifact(
            context.profile,
            command.id,
            'summary-submission',
            intent,
          );
          this.hooks.changed();
        } else if (intent.rejected)
          throw problem(
            'summary_request_rejected',
            'The service rejected this input before creating a job. Review the meeting and confirm a new summary request.',
          );
        else if (
          intent.body.language !== command.language ||
          (intent.body.template_id ?? DEFAULT_SUMMARY_TEMPLATE) !==
            (command.template_id ?? DEFAULT_SUMMARY_TEMPLATE) ||
          intent.body.allow_long_context !== command.allow_long_context
        )
          throw problem(
            'summary_intent_frozen',
            'Recover the saved request with its original language, template and long-meeting consent before changing summary settings.',
          );
        let job: z.infer<typeof jobSchema>;
        try {
          job = summaryJob(
            intent.job_id
              ? await context.api.request(
                  `/v1/jobs/${intent.job_id}`,
                  jobSchema,
                  { signal },
                )
              : await context.api.request(
                  `/v1/documents/${command.id}/summary-runs`,
                  jobSchema,
                  {
                    method: 'POST',
                    body: intent.body,
                    key: intent.key,
                    signal,
                  },
                ),
            command.id,
            intent.job_id ?? undefined,
          );
        } catch (error) {
          // Snapshot rejection follows durable key lookup and precedes job insertion.
          if (
            !intent.job_id &&
            error instanceof ClientError &&
            [
              'revision_conflict',
              'context_too_large',
              'empty_context',
            ].includes(error.code)
          ) {
            context.authorize();
            this.local.putArtifact(
              context.profile,
              command.id,
              'summary-submission',
              { ...intent, rejected: true },
            );
            this.hooks.changed();
          }
          throw error;
        }
        context.authorize();
        this.local.putArtifact(
          context.profile,
          command.id,
          'summary-submission',
          { ...intent, job_id: job.id },
        );
        this.hooks.cacheJob(context.profile, command.id, job);
      });
    } finally {
      this.writes.delete(mutex);
    }
  }
  async control(command: Command<'controlSummary'>) {
    await this.remote(command.scope, command.id, async (context, signal) => {
      let job = summaryJob(
        await context.api.request(`/v1/jobs/${command.job_id}`, jobSchema, {
          signal,
        }),
        command.id,
        command.job_id,
      );
      context.authorize();
      if (command.action === 'resume') {
        if (!command.resume_token)
          throw problem(
            'summary_resume_required',
            'Refresh and confirm the failed summary before resuming it.',
          );
        job = await context.api.request(`/v1/jobs/${job.id}/retry`, jobSchema, {
          method: 'POST',
          body: { confirmed: true, resume_token: command.resume_token },
          signal,
        });
      }
      if (command.action === 'cancel' && active(job))
        job = (
          await context.api.request(
            `/v1/jobs/${job.id}/cancel`,
            z.strictObject({
              already_terminal: z.boolean(),
              job: jobSchema,
            }),
            { method: 'POST', body: {}, signal },
          )
        ).job;
      context.authorize();
      this.hooks.cacheJob(
        context.profile,
        command.id,
        summaryJob(job, command.id, command.job_id),
      );
    });
  }
  async progress(command: Command<'getSummaryProgress'>) {
    return this.remote(command.scope, command.id, async (context, signal) => {
      const progress = await context.api.request(
        `/v1/jobs/${command.job_id}/summary-progress`,
        summaryProgressSchema,
        { signal },
      );
      if (
        progress.job_id !== command.job_id ||
        progress.document_id !== command.id
      )
        throw problem(
          'invalid_server_response',
          'The service returned summary progress for another meeting or job.',
        );
      return progress;
    });
  }
  private async result(scope: number, id: string, jobId: string) {
    const owner = this.hooks.owner(scope);
    this.local.get(owner.profile, id);
    const cached = this.local.getArtifact(
      owner.profile,
      id,
      `job:${jobId}`,
      jobSchema,
    );
    const job =
      cached ??
      (await this.remote(scope, id, async (context, signal) => {
        const value = summaryJob(
          await context.api.request(`/v1/jobs/${jobId}`, jobSchema, { signal }),
          id,
        );
        context.authorize();
        this.hooks.cacheJob(context.profile, id, value);
        return value;
      }));
    owner.authorize();
    summaryJob(job, id);
    if (
      job.id !== jobId ||
      job.state !== 'succeeded' ||
      job.result?.kind !== 'summary'
    )
      throw problem(
        'summary_unavailable',
        'This job has no completed summary to review.',
      );
    return { owner, summary: job.result.summary };
  }
  private review(scope: number, id: string, job: string, revision?: number) {
    const owner = this.hooks.owner(scope);
    this.local.get(owner.profile, id);
    const review = this.local.getArtifact(
      owner.profile,
      id,
      `summary-review:${job}`,
      summaryReviewSchema,
    );
    if (!review || review.document_id !== id || review.job_id !== job)
      throw problem(
        'summary_review_missing',
        'Open an editable summary review first.',
      );
    if (revision !== undefined && review.revision !== revision)
      throw problem(
        'summary_review_changed',
        'The saved review changed. Reload it without discarding unsaved text.',
      );
    return { owner, review };
  }
  async open(command: Command<'openSummaryReview'>): Promise<SummaryReview> {
    const { owner, summary } = await this.result(
      command.scope,
      command.id,
      command.job_id,
    );
    owner.authorize();
    const draft = this.local.get(owner.profile, command.id);
    const previous = this.local.getArtifact(
      owner.profile,
      command.id,
      `summary-review:${command.job_id}`,
      summaryReviewSchema,
    );
    if (
      previous &&
      (!command.rebase || previous.applied_local_revision !== null)
    )
      return previous;
    const text = previous?.text ?? summaryText(summary);
    if (!summaryReviewSchema.shape.text.safeParse(text).success)
      throw problem(
        'summary_review_too_large',
        'This generated result exceeds the 40,000-character editable review limit.',
      );
    const review = summaryReviewSchema.parse({
      document_id: command.id,
      job_id: command.job_id,
      revision: (previous?.revision ?? 0) + 1,
      base_local_revision: draft.local_revision,
      text,
      edited: previous?.edited ?? false,
      applied_local_revision: null,
    });
    this.local.putArtifact(
      owner.profile,
      command.id,
      `summary-review:${command.job_id}`,
      review,
    );
    return review;
  }
  save(command: Command<'saveSummaryReview'>) {
    const { owner, review } = this.review(
      command.scope,
      command.id,
      command.job_id,
    );
    if (review.revision !== command.review_revision) {
      if (review.text === command.text) return review;
      throw problem(
        'summary_review_changed',
        'The saved review changed. Keep your unsaved text and reload the saved version before deciding.',
      );
    }
    if (review.text === command.text) return review;
    if (review.applied_local_revision !== null)
      throw problem(
        'summary_already_applied',
        'This review was already appended. Edit the notes directly instead.',
      );
    const saved = summaryReviewSchema.parse({
      ...review,
      revision: review.revision + 1,
      text: command.text,
      edited: true,
    });
    this.local.putArtifact(
      owner.profile,
      command.id,
      `summary-review:${command.job_id}`,
      saved,
    );
    return saved;
  }
  async apply(command: Command<'applySummaryReview'>) {
    if (command.confirmed !== true)
      throw problem(
        'summary_consent_required',
        'Confirm appending this review to your notes.',
      );
    const { owner, review } = this.review(
      command.scope,
      command.id,
      command.job_id,
      command.review_revision,
    );
    if (review.applied_local_revision !== null) return;
    const draft = this.local.get(owner.profile, command.id);
    if (
      draft.local_revision !== command.local_revision ||
      draft.local_revision !== review.base_local_revision
    )
      throw problem(
        'summary_notes_changed',
        'Your notes changed after this review began. Review the latest notes before appending.',
      );
    if (draft.status === 'conflict' || draft.status === 'deleted_remote')
      throw problem(
        'summary_note_conflict',
        'Resolve the meeting conflict before applying generated text.',
      );
    const { summary } = await this.result(
      command.scope,
      command.id,
      command.job_id,
    );
    owner.authorize();
    const content = richTextSchema.safeParse({
      type: 'doc',
      content: [
        ...draft.content.content,
        ...richTextFromPlainText(
          `AI summary draft - reviewed locally\n\n${review.text}\n\nSource locators (verify edited claims)\n${summaryReferences(summary)}`,
        ).content,
      ],
    });
    if (!content.success)
      throw problem(
        'summary_notes_too_large',
        'Appending this draft would exceed the note size or structure limit. Existing notes were not changed.',
      );
    this.local.atomic(() => {
      const current = this.review(
        command.scope,
        command.id,
        command.job_id,
        command.review_revision,
      ).review;
      if (current.applied_local_revision !== null) return;
      const saved = this.local.save(
        owner.profile,
        command.id,
        command.local_revision,
        {
          title: draft.title,
          tags: draft.tags,
          content: content.data,
        },
      );
      this.local.putArtifact(
        owner.profile,
        command.id,
        `summary-review:${command.job_id}`,
        {
          ...review,
          applied_local_revision: saved.local_revision,
        },
      );
    });
    this.hooks.changed();
  }
  async source(command: Command<'getSummarySource'>) {
    const { owner, summary } = await this.result(
      command.scope,
      command.id,
      command.job_id,
    );
    owner.authorize();
    const selected = command.citation;
    if (
      !summaryCitations(summary).some(
        (citation) =>
          citation.source === selected.source &&
          citation.id === selected.id &&
          citation.revision === selected.revision,
      )
    )
      throw problem(
        'citation_not_found',
        'This source is not cited by the completed summary.',
      );
    const name = `summary-source:${command.job_id}:${selected.source}:${selected.id}:${selected.revision}`;
    const cached = this.local.getArtifact(
      owner.profile,
      command.id,
      name,
      summarySourceSchema,
    );
    if (cached) return cached;
    return this.remote(command.scope, command.id, async (context, signal) => {
      const source = await context.api.request(
        `/v1/jobs/${command.job_id}/citation`,
        summarySourceSchema,
        {
          method: 'POST',
          body: selected,
          signal,
        },
      );
      context.authorize();
      if (
        source.document_id !== command.id ||
        source.job_id !== command.job_id ||
        source.citation.source !== selected.source ||
        source.citation.id !== selected.id ||
        source.citation.revision !== selected.revision
      )
        throw problem(
          'invalid_server_response',
          'The service returned another frozen summary source.',
        );
      this.local.putArtifact(context.profile, command.id, name, source);
      return source;
    });
  }
  assertExport(command: Command<'exportSummaryReview'>) {
    this.review(
      command.scope,
      command.id,
      command.job_id,
      command.review_revision,
    );
  }
  async export(command: Command<'exportSummaryReview'>) {
    const { owner, review } = this.review(
      command.scope,
      command.id,
      command.job_id,
      command.review_revision,
    );
    const { summary } = await this.result(
      command.scope,
      command.id,
      command.job_id,
    );
    owner.authorize();
    this.review(
      command.scope,
      command.id,
      command.job_id,
      command.review_revision,
    );
    return `AI summary draft - verify claims and sources\n\n${review.text}\n\nSource locators\n${summaryReferences(summary)}`;
  }
}
