import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createServer } from '@windows-ai-notes/api/server';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import {
  summaryReviewSchema,
  summarySourceSchema,
} from '@windows-ai-notes/contracts/generation';
import {
  ServiceError,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';
import { runOnce } from '@windows-ai-notes/worker';
import { WorkspaceController } from './workspace.js';
import { oidcFixture } from './oidc.fixture.js';
import { summaryIntentSchema } from './summaries.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'durable desktop summaries with the real provisioned API',
  () => {
    const schema = `notes_summaries_${randomUUID().replaceAll('-', '')}`;
    let admin: Database,
      db: Database,
      local: LocalStore,
      controller: WorkspaceController;
    let app: Awaited<ReturnType<typeof createServer>>,
      issuer: Awaited<ReturnType<typeof oidcFixture>>;
    let directory: string, key: Buffer, base: string;
    let actor: { user_id: string; workspace_id: string };
    const fields = (text: string) => ({
      title: 'Synthetic human title',
      tags: ['human'],
      content: richTextFromPlainText(text),
    });
    const open = () =>
      new WorkspaceController(local, issuer.browser, () => {}, {
        allowLoopback: true,
      });
    async function connect(text = 'Original human notes.') {
      const document = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic human title',
          notes: text,
        },
        randomUUID(),
      );
      await controller.execute({
        operation: 'connect',
        scope: controller.scope,
        service_url: base,
      });
      await controller.execute({
        operation: 'activateWorkspace',
        scope: controller.scope,
        workspace_id: actor.workspace_id,
        copy_offline: false,
      });
      await controller.synchronize();
      return document;
    }
    const command = (id: string) => ({
      operation: 'startSummary' as const,
      scope: controller.scope,
      id,
      language: 'en' as const,
      confirmed: true as const,
      new_attempt: true,
      consent_id: randomUUID(),
    });
    async function start(id: string) {
      await controller.summaries.start(command(id));
      return controller.snapshot().jobs.find((job) => job.kind === 'summary')!;
    }
    async function finish(
      id: string,
      observe?: (snapshot: SummarySnapshot) => void,
    ) {
      await runOnce(db, {
        provider: 'fixture',
        configurationVersion: 'desktop-summary-fixture-v1',
        transcribe: async () => {
          throw new Error('Unexpected audio dispatch.');
        },
        summarize: async (snapshot) => {
          observe?.(snapshot);
          const note = {
            source: 'note' as const,
            id: snapshot.document_id,
            revision: snapshot.note_revision,
          };
          const segment = snapshot.segments[0];
          return {
            summary: {
              overview: {
                text: 'Review the synthetic decision.',
                citations: [note],
              },
              topics: [],
              open_questions: [],
              decisions: segment
                ? [
                    {
                      text: 'A frozen transcript supports the review.',
                      citations: [
                        {
                          source: 'transcript',
                          id: segment.id,
                          revision: snapshot.transcript_revision,
                        },
                      ],
                    },
                  ]
                : [],
              action_items: [
                {
                  text: 'Verify the decision before use.',
                  citations: [note],
                  owner: null,
                  due_date: null,
                },
              ],
            },
            usage: { input_tokens: 100, output_tokens: 80, audio_ms: 0 },
          };
        },
      });
      const job = controller
        .snapshot()
        .jobs.find((job) => job.kind === 'summary')!;
      await controller.summaries.control({
        operation: 'controlSummary',
        scope: controller.scope,
        id,
        job_id: job.id,
        action: 'refresh',
        confirmed: true,
      });
      expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
      return job.id;
    }
    const reviewCommand = (id: string, job_id: string, rebase = false) => ({
      operation: 'openSummaryReview' as const,
      scope: controller.scope,
      id,
      job_id,
      rebase,
      confirmed: true as const,
    });
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
    });
    beforeEach(async () => {
      await db.pool.query('TRUNCATE users,workspaces CASCADE');
      issuer = await oidcFixture();
      actor = await db.provision(
        issuer.configuration.issuer,
        issuer.state.subject,
      );
      app = await createServer(db, {
        mode: 'oidc',
        host: '127.0.0.1',
        issuer: issuer.configuration.issuer,
        audience: issuer.configuration.audience,
        jwksUrl: `${issuer.state.issuer}keys`,
        requiredScope: 'notes.access',
        desktop: issuer.configuration,
      });
      base = await app.listen({ host: '127.0.0.1', port: 0 });
      directory = mkdtempSync(join(tmpdir(), 'windows-notes-summary-'));
      key = randomBytes(32);
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      controller?.dispose();
      await app?.close();
      await issuer?.close();
      local?.close();
      key?.fill(0);
      rmSync(directory, { recursive: true, force: true });
      expect(issuer.state.failures).toEqual([]);
    });
    afterAll(async () => {
      await db?.close();
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    });
    it('pins explicit full-meeting consent across a lost reply and restart without renegotiating or changing the original body', async () => {
      const document = await connect('证据'.repeat(10_000));
      await expect(
        controller.summaries.start(command(document.id)),
      ).rejects.toMatchObject({ code: 'context_too_large' });
      const request = {
        ...command(document.id),
        allow_long_context: true as const,
      };
      const original = globalThis.fetch;
      let lose = true,
        capabilities = true;
      const submissions: { key: string | null; body: unknown }[] = [];
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const url = String(args[0]);
        if (
          !capabilities &&
          (url.endsWith('/v1/templates') ||
            url.endsWith('/v1/summary-capabilities'))
        )
          throw new Error('Recovery must not renegotiate the saved consent.');
        const submission = url.endsWith('/summary-runs');
        if (submission)
          submissions.push({
            key: new Headers(args[1]?.headers).get('idempotency-key'),
            body: JSON.parse(String(args[1]?.body)),
          });
        const response = await original(...args);
        if (submission && lose) {
          lose = false;
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost long-meeting receipt.');
        }
        return response;
      });
      await expect(controller.summaries.start(request)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(controller.snapshot().summary_submission).toMatchObject({
        allow_long_context: true,
        job_id: null,
      });
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
      controller.dispose();
      local.close();
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      capabilities = false;
      await expect(
        controller.summaries.start({
          ...command(document.id),
          scope: controller.scope,
          new_attempt: false,
        }),
      ).rejects.toMatchObject({ code: 'summary_intent_frozen' });
      await controller.summaries.start({
        ...request,
        scope: controller.scope,
        new_attempt: false,
      });
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual(submissions[0]);
      expect(submissions[0]!.body).toEqual({
        note_revision: 1,
        transcript_revision: 0,
        language: 'en',
        allow_long_context: true,
      });
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
    });
    it('rejects an unsupported long-meeting capability before creating a new encrypted intent or billable job', async () => {
      const document = await connect();
      const original = globalThis.fetch;
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) =>
        String(args[0]).endsWith('/v1/summary-capabilities')
          ? new Response(
              JSON.stringify({ long_meetings: 'staged-evidence-v99' }),
              {
                headers: { 'content-type': 'application/json' },
              },
            )
          : original(...args),
      );
      await expect(
        controller.summaries.start({
          ...command(document.id),
          allow_long_context: true,
        }),
      ).rejects.toMatchObject({ code: 'unsupported_summary_context' });
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          'summary-submission',
          summaryIntentSchema,
        ),
      ).toBeNull();
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(0);
    });
    it('reconciles lost resume replies with their original consent token instead of authorizing another failed attempt', async () => {
      const document = await connect();
      const job = await start(document.id);
      const fail = async () =>
        runOnce(db, {
          provider: 'fixture',
          configurationVersion: 'desktop-summary-fixture-v1',
          transcribe: async () => {
            throw new Error('Unexpected audio dispatch.');
          },
          summarize: async () => {
            throw new ServiceError(
              'provider_unavailable',
              'Synthetic response loss.',
              503,
              true,
            );
          },
        });
      await fail();
      const lookup = {
        operation: 'getSummaryProgress' as const,
        scope: controller.scope,
        id: document.id,
        job_id: job.id,
      };
      const first = await controller.summaries.progress(lookup);
      expect(first).toMatchObject({
        resume_available: true,
        uncertain_requests: 1,
        completed_stages: 0,
      });
      const resume = {
        operation: 'controlSummary' as const,
        scope: controller.scope,
        id: document.id,
        job_id: job.id,
        action: 'resume' as const,
        resume_token: first.resume_token!,
        confirmed: true as const,
      };
      const original = db.summaries.resume.bind(db.summaries);
      const lost = vi
        .spyOn(db.summaries, 'resume')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new ServiceError(
            'synthetic_reply_lost',
            'Synthetic lost resume receipt.',
            503,
            true,
          );
        });
      await expect(controller.summaries.control(resume)).rejects.toMatchObject({
        code: 'synthetic_reply_lost',
      });
      lost.mockRestore();
      await fail();
      await controller.summaries.control(resume);
      expect(controller.snapshot().jobs[0]?.state).toBe('failed');
      expect(await db.claim()).toBeNull();
      const second = await controller.summaries.progress(lookup);
      expect(second.resume_token).not.toBe(first.resume_token);
      await controller.summaries.control({
        ...resume,
        resume_token: second.resume_token!,
      });
      await finish(document.id);
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        settled_requests: '1',
        uncertain_requests: '2',
      });
      await expect(
        controller.summaries.progress({
          ...lookup,
          scope: controller.scope + 1,
        }),
      ).rejects.toThrow();
    });
    it('persists a private frozen request before dispatch and recovers a lost receipt across restart without a duplicate job', async () => {
      const document = await connect();
      const request = command(document.id),
        profile = controller.profile;
      const original = globalThis.fetch;
      const submissions: { key: string | null; body: unknown }[] = [];
      let lose = true;
      vi.stubGlobal(
        'fetch',
        async (...arguments_: Parameters<typeof fetch>) => {
          const summary = String(arguments_[0]).endsWith('/summary-runs');
          if (summary) {
            const body = JSON.parse(String(arguments_[1]?.body));
            const key = new Headers(arguments_[1]?.headers).get(
              'idempotency-key',
            );
            expect(
              local.getArtifact(
                profile,
                document.id,
                'summary-submission',
                summaryIntentSchema,
              ),
            ).toMatchObject({ key, body });
            submissions.push({ key, body });
          }
          const response = await original(...arguments_);
          if (summary && lose) {
            lose = false;
            await response.arrayBuffer();
            throw new TypeError('Synthetic lost enqueue receipt.');
          }
          return response;
        },
      );
      await expect(controller.summaries.start(request)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(submissions[0]!.body).toEqual({
        note_revision: document.revision,
        transcript_revision: document.transcript_revision,
        language: 'en',
      });
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
      const stored = await db.pool.query<{ request_hash: string }>(
        'SELECT request_hash FROM jobs WHERE document_id=$1',
        [document.id],
      );
      expect(stored.rows[0]!.request_hash).toBe(
        createHash('sha256')
          .update(
            JSON.stringify({
              note_revision: document.revision,
              transcript_revision: document.transcript_revision,
              language: 'en',
            }),
          )
          .digest('hex'),
      );
      expect(controller.snapshot().summary_submission).toEqual({
        language: 'en',
        consent_id: request.consent_id,
        job_id: null,
        rejected: false,
      });
      expect(JSON.stringify(controller.snapshot())).not.toContain(
        submissions[0]!.key,
      );
      await expect(
        controller.summaries.start({ ...request, consent_id: randomUUID() }),
      ).rejects.toMatchObject({ code: 'summary_request_unresolved' });
      const draft = local.get(profile, document.id);
      local.save(
        profile,
        document.id,
        draft.local_revision,
        fields('Human edits after the unknown receipt.'),
      );
      controller.dispose();
      local.close();
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      await expect(
        controller.summaries.start({
          ...request,
          scope: controller.scope,
          language: 'zh',
        }),
      ).rejects.toMatchObject({ code: 'summary_intent_frozen' });
      await controller.summaries.start({
        ...request,
        scope: controller.scope,
        new_attempt: false,
      });
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual(submissions[0]);
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
      const job = controller.snapshot().jobs[0]!;
      await expect(
        controller.summaries.start(command(document.id)),
      ).rejects.toMatchObject({ code: 'job_in_progress' });
      await controller.summaries.control({
        operation: 'controlSummary',
        scope: controller.scope,
        id: document.id,
        job_id: job.id,
        action: 'cancel',
        confirmed: true,
      });
      await controller.summaries.start({
        ...command(document.id),
        language: 'zh',
      });
      expect(submissions).toHaveLength(3);
      expect(submissions[2]!.key).not.toBe(submissions[0]!.key);
      expect(submissions[2]!.body).toMatchObject({
        note_revision: (await db.document(actor.user_id, document.id)).revision,
        language: 'zh',
      });
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(2);
    });
    it('validates the authenticated template catalog before saving intent and preserves a chosen version across lost replies and restart', async () => {
      const document = await connect();
      expect(
        (await app.inject({ method: 'GET', url: '/v1/templates' })).statusCode,
      ).toBe(401);
      expect(
        (
          await controller.summaries.templates(controller.scope, document.id)
        ).templates.map((item) => item.id),
      ).toEqual(['meeting-summary-v1', 'decisions-actions-v1']);
      const original = globalThis.fetch;
      let supported = false,
        lose = true,
        catalogs = 0;
      const submissions: { key: string | null; body: unknown }[] = [];
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]).endsWith('/v1/templates')) {
          catalogs++;
          if (!supported)
            return new Response(
              JSON.stringify({
                templates: [
                  { id: 'meeting-summary-v1', name: 'Meeting summary' },
                ],
              }),
              { headers: { 'content-type': 'application/json' } },
            );
        }
        const summary = String(args[0]).endsWith('/summary-runs');
        if (summary)
          submissions.push({
            key: new Headers(args[1]?.headers).get('idempotency-key'),
            body: JSON.parse(String(args[1]?.body)),
          });
        const response = await original(...args);
        if (summary && lose) {
          lose = false;
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost versioned-template receipt.');
        }
        return response;
      });
      const request = {
        ...command(document.id),
        template_id: 'decisions-actions-v1' as const,
      };
      await expect(controller.summaries.start(request)).rejects.toMatchObject({
        code: 'unsupported_summary_template',
      });
      expect(submissions).toEqual([]);
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          'summary-submission',
          summaryIntentSchema,
        ),
      ).toBeNull();
      expect(await db.jobs(actor.user_id, document.id)).toEqual([]);
      supported = true;
      await expect(controller.summaries.start(request)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(controller.snapshot().summary_submission).toMatchObject({
        template_id: 'decisions-actions-v1',
        job_id: null,
      });
      controller.dispose();
      local.close();
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      const beforeRecovery = catalogs;
      await expect(
        controller.summaries.start({
          ...request,
          scope: controller.scope,
          template_id: 'meeting-summary-v1',
        }),
      ).rejects.toMatchObject({ code: 'summary_intent_frozen' });
      await controller.summaries.start({
        ...request,
        scope: controller.scope,
        new_attempt: false,
      });
      expect(catalogs).toBe(beforeRecovery);
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual(submissions[0]);
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
      const id = await finish(document.id, (snapshot) =>
        expect(snapshot.template_id).toBe('decisions-actions-v1'),
      );
      expect((await db.job(actor.user_id, id)).result).toMatchObject({
        kind: 'summary',
        prompt_version: 'decisions-actions-v1',
      });
    });
    it('locates only cited frozen evidence after note and transcript edits, and purges it when revocation is observed', async () => {
      const document = await connect('Original frozen note evidence.');
      const segment = {
        id: randomUUID(),
        start_ms: 100,
        end_ms: 600,
        text: 'Original frozen transcript evidence.',
      };
      const uncited = {
        ...segment,
        id: randomUUID(),
        text: 'Uncited evidence.',
      };
      await db.editTranscript(actor.user_id, document.id, 0, [
        segment,
        uncited,
      ]);
      await controller.synchronize();
      await start(document.id);
      const draft = local.get(controller.profile, document.id);
      local.save(
        controller.profile,
        document.id,
        draft.local_revision,
        fields('New manual note evidence.'),
      );
      await controller.synchronize();
      await db.editTranscript(actor.user_id, document.id, 1, [
        { ...segment, text: 'New manual transcript evidence.' },
      ]);
      const job_id = await finish(document.id, (snapshot) => {
        expect(snapshot.notes).toBe('Original frozen note evidence.');
        expect(snapshot.segments).toEqual([segment, uncited]);
      });
      const base = {
        operation: 'getSummarySource' as const,
        scope: controller.scope,
        id: document.id,
        job_id,
      };
      const citation = {
        source: 'note' as const,
        id: document.id,
        revision: 1,
      };
      expect(
        await controller.summaries.source({ ...base, citation }),
      ).toMatchObject({
        text: 'Original frozen note evidence.',
        start_ms: null,
      });
      expect(
        await controller.summaries.source({
          ...base,
          citation: { source: 'transcript', id: segment.id, revision: 1 },
        }),
      ).toMatchObject({ text: segment.text, start_ms: 100, end_ms: 600 });
      await expect(
        db.summarySource(actor.user_id, job_id, {
          source: 'transcript',
          id: uncited.id,
          revision: 1,
        }),
      ).rejects.toMatchObject({ code: 'citation_not_found' });
      await expect(
        db.summarySource(actor.user_id, job_id, { ...citation, revision: 2 }),
      ).rejects.toMatchObject({ code: 'citation_not_found' });
      await expect(
        db.summarySource(randomUUID(), job_id, citation),
      ).rejects.toMatchObject({ code: 'job_not_found' });
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
        [actor.workspace_id, actor.user_id],
      );
      await expect(
        controller.summaries.control({
          operation: 'controlSummary',
          scope: controller.scope,
          id: document.id,
          job_id,
          action: 'refresh',
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: 'workspace_access_revoked' });
      expect(controller.snapshot().selected).toBeNull();
      expect(controller.snapshot().jobs).toEqual([]);
    });
    it('persists editable reviews, preserves manual content and metadata, requires rebase, and appends exactly once', async () => {
      const document = await connect();
      await start(document.id);
      const job_id = await finish(document.id);
      let review = await controller.summaries.open(
        reviewCommand(document.id, job_id),
      );
      const save = {
        operation: 'saveSummaryReview' as const,
        scope: controller.scope,
        id: document.id,
        job_id,
        review_revision: review.revision,
        text: 'A deliberately reviewed synthetic summary [1].',
      };
      review = controller.summaries.save(save);
      expect(controller.summaries.save(save)).toEqual(review);
      expect(
        controller.summaries.save({
          ...save,
          review_revision: review.revision,
        }),
      ).toEqual(review);
      expect(() =>
        controller.summaries.save({
          ...save,
          text: 'A conflicting stale edit.',
        }),
      ).toThrow('saved review changed');
      const human = local.get(controller.profile, document.id);
      local.save(
        controller.profile,
        document.id,
        human.local_revision,
        fields('Original human notes.\nAnother human decision.'),
      );
      const current = local.get(controller.profile, document.id);
      const apply = {
        operation: 'applySummaryReview' as const,
        scope: controller.scope,
        id: document.id,
        job_id,
        review_revision: review.revision,
        local_revision: current.local_revision,
        confirmed: true as const,
      };
      await expect(controller.summaries.apply(apply)).rejects.toMatchObject({
        code: 'summary_notes_changed',
      });
      review = await controller.summaries.open(
        reviewCommand(document.id, job_id, true),
      );
      expect(review.text).toBe(save.text);
      await controller.summaries.apply({
        ...apply,
        review_revision: review.revision,
      });
      const appended = local.get(controller.profile, document.id);
      expect(richTextToPlainText(appended.content)).toContain(
        'Original human notes.\nAnother human decision.',
      );
      expect(richTextToPlainText(appended.content)).toContain(save.text);
      expect(richTextToPlainText(appended.content)).toContain(
        `Note ${document.id}, revision 1`,
      );
      expect(appended.title).toBe('Synthetic human title');
      expect(appended.tags).toEqual(['human']);
      await controller.summaries.apply({
        ...apply,
        review_revision: review.revision,
      });
      expect(local.get(controller.profile, document.id)).toEqual(appended);
      expect(() =>
        controller.summaries.save({
          ...save,
          review_revision: review.revision,
          text: 'Cannot edit an applied review.',
        }),
      ).toThrow('already appended');
      const citation = {
        source: 'note' as const,
        id: document.id,
        revision: 1,
      };
      await controller.summaries.source({
        operation: 'getSummarySource',
        scope: controller.scope,
        id: document.id,
        job_id,
        citation,
      });
      controller.dispose();
      local.close();
      expect(
        readFileSync(join(directory, 'notes.sqlite')).includes(
          Buffer.from(save.text),
        ),
      ).toBe(false);
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new TypeError('Synthetic offline network.'),
      );
      expect(
        await controller.summaries.open(reviewCommand(document.id, job_id)),
      ).toMatchObject({
        text: save.text,
        applied_local_revision: appended.local_revision,
      });
      expect(
        await controller.summaries.source({
          operation: 'getSummarySource',
          scope: controller.scope,
          id: document.id,
          job_id,
          citation,
        }),
      ).toMatchObject({ text: 'Original human notes.' });
      expect(
        await controller.summaries.export({
          operation: 'exportSummaryReview',
          scope: controller.scope,
          id: document.id,
          job_id,
          review_revision: review.revision,
          format: 'markdown',
        }),
      ).toContain(save.text);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it('rejects an oversized append without changing existing notes or marking the review applied', async () => {
      const text = 'n'.repeat(39_950);
      const document = await connect(text);
      await start(document.id);
      const job_id = await finish(document.id);
      const review = await controller.summaries.open(
        reviewCommand(document.id, job_id),
      );
      const original = local.get(controller.profile, document.id);
      await expect(
        controller.summaries.apply({
          operation: 'applySummaryReview',
          scope: controller.scope,
          id: document.id,
          job_id,
          review_revision: review.revision,
          local_revision: original.local_revision,
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: 'summary_notes_too_large' });
      expect(local.get(controller.profile, document.id)).toEqual(original);
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          `summary-review:${job_id}`,
          summaryReviewSchema,
        ),
      ).toEqual(review);
    });
    it('fences a local-note race at the atomic append and does not record a successful application', async () => {
      const document = await connect();
      await start(document.id);
      const job_id = await finish(document.id);
      const review = await controller.summaries.open(
        reviewCommand(document.id, job_id),
      );
      const original = local.get(controller.profile, document.id);
      const applying = controller.summaries.apply({
        operation: 'applySummaryReview',
        scope: controller.scope,
        id: document.id,
        job_id,
        review_revision: review.revision,
        local_revision: original.local_revision,
        confirmed: true,
      });
      const changed = local.save(
        controller.profile,
        document.id,
        original.local_revision,
        fields('Human text won the append race.'),
      );
      await expect(applying).rejects.toMatchObject({
        code: 'local_revision_conflict',
      });
      expect(local.get(controller.profile, document.id)).toEqual(changed);
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          `summary-review:${job_id}`,
          summaryReviewSchema,
        ),
      ).toEqual(review);
    });
    it('does not cache or return a late frozen source after switching to another workspace scope', async () => {
      const document = await connect();
      await start(document.id);
      const job_id = await finish(document.id);
      const scope = controller.scope,
        profile = controller.profile;
      let reached!: () => void, release!: () => void;
      const seen = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        async (...arguments_: Parameters<typeof fetch>) => {
          const response = await original(...arguments_);
          if (!String(arguments_[0]).endsWith('/citation')) return response;
          const bytes = await response.arrayBuffer();
          reached();
          await waiting;
          return new Response(bytes, {
            status: response.status,
            headers: response.headers,
          });
        },
      );
      const citation = {
        source: 'note' as const,
        id: document.id,
        revision: 1,
      };
      const reading = controller.summaries.source({
        operation: 'getSummarySource',
        scope,
        id: document.id,
        job_id,
        citation,
      });
      await seen;
      await controller.execute({ operation: 'workOffline', scope });
      release();
      await expect(reading).rejects.toMatchObject({
        code: 'workspace_changed',
      });
      expect(controller.snapshot().summary_submission).toBeNull();
      expect(
        local.getArtifact(
          profile,
          document.id,
          `summary-source:${job_id}:note:${document.id}:1`,
          summarySourceSchema,
        ),
      ).toBeNull();
    });
    it('permits fresh consent after a known pre-enqueue rejection without silently replacing an uncertain request', async () => {
      const document = await connect('');
      const first = command(document.id);
      await expect(controller.summaries.start(first)).rejects.toMatchObject({
        code: 'empty_context',
      });
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(0);
      expect(controller.snapshot().summary_submission).toMatchObject({
        job_id: null,
        rejected: true,
      });
      await expect(controller.summaries.start(first)).rejects.toMatchObject({
        code: 'summary_request_rejected',
      });
      const draft = local.get(controller.profile, document.id);
      local.save(
        controller.profile,
        document.id,
        draft.local_revision,
        fields('New evidence after explicit rejection.'),
      );
      await controller.summaries.start(command(document.id));
      expect(await db.jobs(actor.user_id, document.id)).toHaveLength(1);
      expect(controller.snapshot().summary_submission).toMatchObject({
        rejected: false,
      });
    });
    it('reconciles concurrent duplicate apply requests as one atomic append', async () => {
      const document = await connect();
      await start(document.id);
      const job_id = await finish(document.id);
      const review = await controller.summaries.open(
        reviewCommand(document.id, job_id),
      );
      const apply = {
        operation: 'applySummaryReview' as const,
        scope: controller.scope,
        id: document.id,
        job_id,
        review_revision: review.revision,
        local_revision: review.base_local_revision,
        confirmed: true as const,
      };
      await Promise.all([
        controller.summaries.apply(apply),
        controller.summaries.apply(apply),
      ]);
      expect(
        richTextToPlainText(
          local.get(controller.profile, document.id).content,
        ).split('AI summary draft - reviewed locally'),
      ).toHaveLength(2);
    });
    it('pins export authorization to the saved review revision and rejects a status for a different job', async () => {
      const document = await connect();
      const initial = await start(document.id);
      const job_id = await finish(document.id);
      const review = await controller.summaries.open(
        reviewCommand(document.id, job_id),
      );
      const exporting = {
        operation: 'exportSummaryReview' as const,
        scope: controller.scope,
        id: document.id,
        job_id,
        review_revision: review.revision,
        format: 'text' as const,
      };
      controller.summaries.assertExport(exporting);
      const changed = controller.summaries.save({
        operation: 'saveSummaryReview',
        scope: controller.scope,
        id: document.id,
        job_id,
        review_revision: review.revision,
        text: 'Newer explicitly saved review.',
      });
      expect(() => controller.summaries.assertExport(exporting)).toThrow(
        'saved review changed',
      );
      await expect(
        controller.summaries.export(exporting),
      ).rejects.toMatchObject({ code: 'summary_review_changed' });
      expect(
        await controller.summaries.export({
          ...exporting,
          review_revision: changed.revision,
        }),
      ).toContain(changed.text);
      const original = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        async (...arguments_: Parameters<typeof fetch>) => {
          if (String(arguments_[0]).endsWith(`/v1/jobs/${job_id}`))
            return Response.json({ ...initial, id: randomUUID() });
          return original(...arguments_);
        },
      );
      await expect(
        controller.summaries.control({
          operation: 'controlSummary',
          scope: controller.scope,
          id: document.id,
          job_id,
          action: 'refresh',
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
      expect(controller.snapshot().jobs[0]).toMatchObject({
        id: job_id,
        state: 'succeeded',
      });
    });
    it('cannot review or read evidence for an unfinished or cancelled job', async () => {
      const document = await connect();
      const job = await start(document.id);
      await expect(
        controller.summaries.open(reviewCommand(document.id, job.id)),
      ).rejects.toMatchObject({ code: 'summary_unavailable' });
      await expect(
        db.summarySource(actor.user_id, job.id, {
          source: 'note',
          id: document.id,
          revision: 1,
        }),
      ).rejects.toMatchObject({ code: 'summary_unavailable' });
      await controller.summaries.control({
        operation: 'controlSummary',
        scope: controller.scope,
        id: document.id,
        job_id: job.id,
        action: 'cancel',
        confirmed: true,
      });
      expect(controller.snapshot().jobs[0]?.state).toBe('cancelled');
      await expect(
        controller.summaries.open(reviewCommand(document.id, job.id)),
      ).rejects.toMatchObject({ code: 'summary_unavailable' });
    });
  },
);
