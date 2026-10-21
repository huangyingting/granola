import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
import { Database, digest, type ClaimedJob } from '@windows-ai-notes/db';
import {
  summaryPromptVersion,
  summaryEvidence,
  type AiProviders,
} from '@windows-ai-notes/ai';
import {
  ServiceError,
  summaryResultSchema,
  summarySnapshotCitations,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';
import {
  summaryProgressSchema,
  type SummaryStageSpec,
} from '@windows-ai-notes/contracts/evidence';
import { runOnce } from '@windows-ai-notes/worker';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const identity = {
  provider: 'fixture' as const,
  configurationVersion: 'stages-fixture-v1',
  pipelineVersion: 'direct-summary-v1',
};
const actual = { input_tokens: 3, output_tokens: 2, audio_ms: 0 };
const budget = { input_tokens: 10, output_tokens: 5, audio_ms: 0 };
const summary = (input: SummarySnapshot) => ({
  overview: {
    text: 'Verify the frozen evidence.',
    citations: summarySnapshotCitations(input),
  },
  topics: [],
  decisions: [],
  action_items: [],
  open_questions: [],
});
const providers: AiProviders = {
  ...identity,
  summarize: async (input) => ({ summary: summary(input), usage: actual }),
  transcribe: async () => {
    throw new Error('Unexpected audio dispatch.');
  },
};
const unavailable: AiProviders = {
  ...providers,
  summarize: async () => {
    throw new ServiceError(
      'provider_unavailable',
      'Synthetic response loss.',
      503,
      true,
    );
  },
};
function spec(job: ClaimedJob): SummaryStageSpec {
  if (job.input.kind !== 'summary') throw new Error('Expected summary.');
  return {
    phase: 'generate',
    round: 0,
    index: 0,
    input_hash: digest(summaryEvidence(job.input.snapshot)),
    prompt_version: summaryPromptVersion(job.input.snapshot),
    citations: summarySnapshotCitations(job.input.snapshot),
  };
}
function output(job: ClaimedJob) {
  if (job.input.kind !== 'summary') throw new Error('Expected summary.');
  return summaryResultSchema.parse({
    kind: 'summary',
    summary: summary(job.input.snapshot),
    usage: actual,
    provider: identity.provider,
    configuration_version: identity.configurationVersion,
    prompt_version: summaryPromptVersion(job.input.snapshot),
  });
}

describe.skipIf(!databaseUrl)(
  'durable summary stages and replay-safe consent',
  () => {
    const schema = `notes_stages_${randomUUID().replaceAll('-', '')}`;
    let admin: Database, db: Database, scopedUrl: string;
    let app: Awaited<ReturnType<typeof createServer>>;
    let actor: { user_id: string; workspace_id: string },
      headers: { 'x-dev-subject': string };
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      scopedUrl = scoped.href;
      db = new Database(scopedUrl);
      await db.migrate();
      await db.migrate();
      await db.assertReady();
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    });
    beforeEach(async () => {
      await db.pool.query('TRUNCATE users,workspaces CASCADE');
      const subject = randomUUID();
      actor = await db.provision('urn:windows-ai-notes:development', subject);
      headers = { 'x-dev-subject': subject };
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function queued() {
      const document = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic staged summary',
          notes: 'Original frozen summary evidence.',
        },
        randomUUID(),
      );
      return db.enqueueSummary(
        actor.user_id,
        document.id,
        {
          note_revision: 1,
          transcript_revision: 0,
          language: 'en',
        },
        randomUUID(),
      );
    }
    async function ready() {
      await queued();
      const job = (await db.claim())!;
      const stage = spec(job);
      await db.summaries.begin(job, identity);
      await db.summaries.prepare(job, stage);
      return { job, stage };
    }
    const expireLease = (job: ClaimedJob) =>
      db.pool.query(
        "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [job.id],
      );
    const retry = (id: string, token?: string, requestHeaders = headers) =>
      app.inject({
        method: 'POST',
        url: `/v1/jobs/${id}/retry`,
        headers: requestHeaders,
        payload: { confirmed: true, ...(token ? { resume_token: token } : {}) },
      });
    async function progress(id: string) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${id}/summary-progress`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      return summaryProgressSchema.parse(response.json());
    }
    async function saved() {
      const value = await ready();
      const call = await db.summaries.sending(value.job, value.stage, budget);
      await db.usage.settle(call, actual);
      await db.summaries.save(value.job, value.stage, {
        kind: 'summary',
        result: output(value.job),
      });
      return value;
    }
    it('rolls back the reservation with the dispatch marker, and admits exactly one concurrent sender', async () => {
      const { job, stage } = await ready();
      const original = db.usage.start.bind(db.usage);
      const broken = vi
        .spyOn(db.usage, 'start')
        .mockImplementation(async (...args) => {
          await original(...args);
          throw new Error('Synthetic transaction interruption.');
        });
      await expect(db.summaries.sending(job, stage, budget)).rejects.toThrow(
        'Synthetic transaction',
      );
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '0',
      });
      expect((await db.summaries.prepare(job, stage)).state).toBe('pending');
      broken.mockRestore();
      const calls = await Promise.allSettled([
        db.summaries.sending(job, stage, budget),
        db.summaries.sending(job, stage, budget),
      ]);
      expect(calls.map((call) => call.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '1',
        uncertain: { input_tokens: '10', output_tokens: '5' },
      });
    });
    it('requires matching settled usage and commits saved output with its progress event', async () => {
      const { job, stage } = await ready();
      const call = await db.summaries.sending(job, stage, budget);
      const result = output(job);
      await expect(
        db.summaries.save(job, stage, { kind: 'summary', result }),
      ).rejects.toMatchObject({ code: 'summary_usage_unconfirmed' });
      await db.usage.settle(call, actual);
      await expect(
        db.summaries.save(job, stage, {
          kind: 'summary',
          result: { ...result, usage: { ...actual, input_tokens: 4 } },
        }),
      ).rejects.toMatchObject({ code: 'summary_usage_unconfirmed' });
      const event = vi
        .spyOn(db, 'event')
        .mockRejectedValueOnce(new Error('Synthetic event interruption.'));
      await expect(
        db.summaries.save(job, stage, { kind: 'summary', result }),
      ).rejects.toThrow('Synthetic event');
      expect((await db.summaries.prepare(job, stage)).state).toBe('sending');
      event.mockRestore();
      await db.summaries.save(job, stage, { kind: 'summary', result });
      await db.summaries.save(job, stage, { kind: 'summary', result });
      expect(await db.summaries.completed(job)).toEqual(result);
      expect((await progress(job.id)).completed_stages).toBe(1);
    });
    it.each(['replacement', 'confirmed resume'])(
      'publishes saved final output after %s without a provider repeat or configuration rewrite',
      async (mode) => {
        const { job } = await saved();
        if (mode === 'replacement') await expireLease(job);
        else {
          await db.finish(job, null, {
            code: 'worker_restarting',
            message: 'Synthetic publication interruption.',
            retryable: false,
          });
          const resume = await progress(job.id);
          expect((await retry(job.id, resume.resume_token!)).statusCode).toBe(
            200,
          );
        }
        const replacement = new Database(scopedUrl);
        const summarize = vi.fn(providers.summarize);
        try {
          expect(
            await runOnce(replacement, {
              ...providers,
              configurationVersion: 'replacement-v2',
              summarize,
            }),
          ).toBe(true);
          expect(summarize).not.toHaveBeenCalled();
          expect(await db.job(actor.user_id, job.id)).toMatchObject({
            state: 'succeeded',
            result: {
              configuration_version: identity.configurationVersion,
              usage: actual,
            },
          });
          expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
            settled_requests: '1',
            uncertain_requests: '0',
          });
        } finally {
          await replacement.close();
        }
      },
    );
    it('pauses an abandoned sending stage under a new lease without repeating its unknown call', async () => {
      const { job, stage } = await ready();
      await db.summaries.sending(job, stage, budget);
      await expireLease(job);
      const summarize = vi.fn(providers.summarize);
      await runOnce(db, { ...providers, summarize });
      expect(summarize).not.toHaveBeenCalled();
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
        error: { code: 'summary_dispatch_unconfirmed', retryable: false },
      });
      expect(await progress(job.id)).toMatchObject({
        completed_stages: 0,
        provider_requests: 1,
        uncertain_requests: 1,
        resume_available: true,
      });
      expect(await runOnce(db, providers)).toBe(false);
    });
    it('consumes consent once across concurrent replies, another failure and a successful retry', async () => {
      const job = await queued();
      await runOnce(db, unavailable);
      const first = await progress(job.id);
      expect((await retry(job.id)).statusCode).toBe(400);
      expect((await retry(job.id, randomUUID())).statusCode).toBe(409);
      const confirmations = await Promise.all([
        retry(job.id, first.resume_token!),
        retry(job.id, first.resume_token!),
      ]);
      expect(confirmations.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      await runOnce(db, unavailable);
      const second = await progress(job.id);
      expect(second).toMatchObject({
        state: 'failed',
        uncertain_requests: 2,
        provider_requests: 2,
      });
      expect(second.resume_token).not.toBe(first.resume_token);
      const replay = await retry(job.id, first.resume_token!);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().state).toBe('failed');
      expect(await db.claim()).toBeNull();
      expect((await retry(job.id, second.resume_token!)).statusCode).toBe(200);
      await runOnce(db, providers);
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'succeeded',
      });
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        settled_requests: '1',
        uncertain_requests: '2',
        uncertain: { input_tokens: '128000', output_tokens: '8192' },
      });
      expect((await retry(job.id, first.resume_token!)).json().state).toBe(
        'succeeded',
      );
    });
    it('does not expose the next resume token from a torn failed-state read during another confirmed resume', async () => {
      const job = await queued();
      await runOnce(db, unavailable);
      const confirmation = (await progress(job.id)).resume_token!;
      const original = db.job.bind(db);
      vi.spyOn(db, 'job').mockImplementationOnce(async (...args) => {
        const previous = await original(...args);
        await db.summaries.resume(actor.user_id, job.id, confirmation);
        return previous;
      });
      expect(await progress(job.id)).toMatchObject({
        state: 'queued',
        resume_available: false,
        resume_token: null,
        provider_requests: 1,
        uncertain_requests: 1,
      });
    });
    it('fences changed input, prompt and provider identities without another dispatch', async () => {
      const { job, stage } = await ready();
      for (const identity_ of [
        { ...identity, configurationVersion: 'changed-v2' },
        { ...identity, pipelineVersion: 'changed-v2' },
        { ...identity, provider: 'azure' as const },
      ])
        await expect(db.summaries.begin(job, identity_)).rejects.toMatchObject({
          code: 'provider_configuration_changed',
        });
      for (const stage_ of [
        { ...stage, input_hash: digest('changed') },
        { ...stage, prompt_version: 'changed-v2' },
      ])
        await expect(db.summaries.prepare(job, stage_)).rejects.toMatchObject({
          code: 'summary_stage_changed',
        });
      if (job.input.kind !== 'summary') throw new Error('Expected summary.');
      const forged = {
        ...job,
        input: {
          ...job.input,
          snapshot: { ...job.input.snapshot, notes: 'Changed input.' },
        },
      };
      await expect(db.summaries.begin(forged, identity)).rejects.toMatchObject({
        code: 'summary_stage_changed',
      });
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '0',
      });
    });
    it('stores reusable extraction/merge facts only against their original citation allowlists', async () => {
      const { job, stage } = await ready();
      const fact = {
        category: 'decision' as const,
        text: 'Verify the evidence.',
        citations: stage.citations,
        owner: null,
        due_date: null,
      };
      for (const key of [
        { phase: 'extract' as const, round: 0, index: 0 },
        { phase: 'merge' as const, round: 1, index: 0 },
      ]) {
        const step = { ...stage, ...key };
        await db.summaries.prepare(job, step);
        const call = await db.summaries.sending(job, step, budget);
        await db.usage.settle(call, actual);
        await expect(
          db.summaries.save(job, step, {
            kind: 'facts',
            facts: [
              {
                ...fact,
                citations: [{ ...stage.citations[0]!, id: randomUUID() }],
              },
            ],
            usage: actual,
          }),
        ).rejects.toMatchObject({ code: 'invalid_citation' });
        await db.summaries.save(job, step, {
          kind: 'facts',
          facts: [fact],
          usage: actual,
        });
        expect(await db.summaries.prepare(job, step)).toMatchObject({
          state: 'completed',
          output: { kind: 'facts', facts: [fact] },
        });
      }
      const invalid = {
        ...stage,
        phase: 'extract' as const,
        index: 1,
        citations: [{ ...stage.citations[0]!, revision: 2 }],
      };
      await expect(db.summaries.prepare(job, invalid)).rejects.toMatchObject({
        code: 'invalid_citation',
      });
      await expireLease(job);
      const replacement = (await db.claim())!;
      await db.summaries.begin(replacement, identity);
      expect(
        (
          await db.summaries.prepare(replacement, {
            ...stage,
            phase: 'extract',
          })
        ).state,
      ).toBe('completed');
      expect(await progress(job.id)).toMatchObject({
        total_stages: 3,
        completed_stages: 2,
        provider_requests: 2,
      });
    });
    it('rejects final citation or prompt substitutions after recording known provider usage', async () => {
      const { job, stage } = await ready();
      const call = await db.summaries.sending(job, stage, budget);
      await db.usage.settle(call, actual);
      const result = output(job);
      await expect(
        db.summaries.save(job, stage, {
          kind: 'summary',
          result: { ...result, prompt_version: 'changed-v2' },
        }),
      ).rejects.toMatchObject({ code: 'summary_stage_changed' });
      result.summary.overview.citations[0]!.revision++;
      await expect(
        db.summaries.save(job, stage, { kind: 'summary', result }),
      ).rejects.toMatchObject({ code: 'invalid_citation' });
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        settled_requests: '1',
        uncertain_requests: '0',
      });
      expect((await db.summaries.prepare(job, stage)).state).toBe('sending');
    });
    it.each(['cancel', 'delete', 'membership', 'account'])(
      'discards late saved artifacts after %s while retaining known usage',
      async (action) => {
        const { job, stage } = await ready();
        const call = await db.summaries.sending(job, stage, budget);
        if (action === 'cancel') await db.cancel(actor.user_id, job.id);
        else if (action === 'delete')
          await db.deleteDocument(actor.user_id, job.documentId);
        else if (action === 'membership')
          await db.pool.query(
            'UPDATE memberships SET active=false WHERE user_id=$1',
            [actor.user_id],
          );
        else
          await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
            actor.user_id,
          ]);
        await db.usage.settle(call, actual);
        await expect(
          db.summaries.save(job, stage, {
            kind: 'summary',
            result: output(job),
          }),
        ).rejects.toBeInstanceOf(ServiceError);
        expect(await db.finish(job, output(job), null)).toBe(false);
        expect(
          (
            await db.pool.query(
              'SELECT job_id FROM summary_runs WHERE job_id=$1',
              [job.id],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await db.pool.query(
              'SELECT actual FROM ai_usage_calls WHERE id=$1',
              [call],
            )
          ).rows[0]!.actual,
        ).toEqual({ input_tokens: '3', output_tokens: '2', audio_ms: '0' });
        expect(
          (await db.pool.query('SELECT result FROM jobs WHERE id=$1', [job.id]))
            .rows[0]!.result,
        ).toBeNull();
      },
    );
    it('serializes deletion behind an in-flight stage commit and removes its saved output', async () => {
      const { job, stage } = await ready();
      const call = await db.summaries.sending(job, stage, budget);
      await db.usage.settle(call, actual);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = db.event.bind(db);
      vi.spyOn(db, 'event').mockImplementation(async (...args) => {
        if (args[2] === 'job.progress') {
          entered();
          await waiting;
        }
        await original(...args);
      });
      const saving = db.summaries.save(job, stage, {
        kind: 'summary',
        result: output(job),
      });
      await started;
      const deleting = db.deleteDocument(actor.user_id, job.documentId);
      await delay(30);
      release();
      await Promise.all([saving, deleting]);
      expect(
        (
          await db.pool.query(
            'SELECT job_id FROM summary_runs WHERE job_id=$1',
            [job.id],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('expires failed progress without releasing its hold or recreating missing stages', async () => {
      const { job, stage } = await ready();
      await db.summaries.sending(job, stage, budget);
      await db.finish(job, null, {
        code: 'interrupted',
        message: 'Synthetic interruption.',
        retryable: false,
      });
      const confirmation = (await progress(job.id)).resume_token!;
      await db.pool.query(
        "UPDATE jobs SET updated_at=now()-interval '25 hours' WHERE id=$1",
        [job.id],
      );
      expect(await progress(job.id)).toMatchObject({
        resume_available: false,
        resume_token: null,
      });
      await db.cleanup();
      expect((await retry(job.id, confirmation)).statusCode).toBe(410);
      await db.pool.query(
        "UPDATE jobs SET state='queued',attempt=0,available_at=now() WHERE id=$1",
        [job.id],
      );
      const summarize = vi.fn(providers.summarize);
      await runOnce(db, { ...providers, summarize });
      expect(summarize).not.toHaveBeenCalled();
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        error: { code: 'summary_progress_expired' },
      });
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '1',
        uncertain: { input_tokens: '10' },
      });
    });
    it('does not replay a pre-upgrade provider dispatch without durable stage records', async () => {
      await queued();
      const legacy = (await db.claim())!;
      await db.usage.start(legacy, {
        operation: 'summary',
        provider: identity.provider,
        configurationVersion: identity.configurationVersion,
        budget,
      });
      await expireLease(legacy);
      const summarize = vi.fn(providers.summarize);
      await runOnce(db, { ...providers, summarize });
      expect(summarize).not.toHaveBeenCalled();
      expect(await db.job(actor.user_id, legacy.id)).toMatchObject({
        error: { code: 'summary_progress_expired' },
      });
      expect((await progress(legacy.id)).resume_available).toBe(false);
      expect(
        (await db.pool.query('SELECT job_id FROM summary_runs')).rowCount,
      ).toBe(0);
    });
    it('authorizes progress and resume by owner and preserves the existing job progress schema', async () => {
      const job = await queued();
      const original = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${job.id}`,
        headers,
      });
      expect(original.json().progress).toBeNull();
      await runOnce(db, unavailable);
      const confirmation = (await progress(job.id)).resume_token!;
      const subject = randomUUID();
      await db.provision(
        'urn:windows-ai-notes:development',
        subject,
        actor.workspace_id,
      );
      const other = { 'x-dev-subject': subject };
      expect((await retry(job.id, confirmation, other)).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/jobs/${job.id}/summary-progress`,
            headers: other,
          })
        ).statusCode,
      ).toBe(404);
      const unconfirmed = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/retry`,
        headers,
        payload: { confirmed: false, resume_token: confirmation },
      });
      expect(unconfirmed.statusCode).toBe(400);
      expect((await progress(job.id)).resume_token).toBe(confirmation);
    });
    it('does not consume a confirmation or release uncertain usage when the pending-job cap blocks resume', async () => {
      const job = await queued();
      await runOnce(db, unavailable);
      const confirmation = (await progress(job.id)).resume_token!;
      for (let i = 0; i < 8; i++)
        await db.enqueueSummary(
          actor.user_id,
          job.document_id,
          {
            note_revision: 1,
            transcript_revision: 0,
            language: 'en',
          },
          randomUUID(),
        );
      expect((await retry(job.id, confirmation)).statusCode).toBe(429);
      expect((await progress(job.id)).resume_token).toBe(confirmation);
      expect(
        (await db.pool.query('SELECT token FROM summary_resumes')).rowCount,
      ).toBe(0);
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '1',
      });
    });
    it('prunes revoked and successful cached stages without retaining or reissuing their provider output', async () => {
      const { job } = await saved();
      await db.finish(job, output(job), null);
      await db.pool.query(
        "UPDATE jobs SET updated_at=now()-interval '8 days' WHERE id=$1",
        [job.id],
      );
      await db.cleanup();
      expect(
        (await db.pool.query('SELECT job_id FROM summary_runs')).rowCount,
      ).toBe(0);
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'succeeded',
        result: output(job),
      });
      await queued();
      const revoked = (await db.claim())!;
      await db.summaries.begin(revoked, identity);
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1',
        [actor.user_id],
      );
      await db.cleanup();
      expect(
        (await db.pool.query('SELECT job_id FROM summary_runs')).rowCount,
      ).toBe(0);
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE user_id=$1',
        [actor.user_id],
      );
      await expect(db.summaries.begin(revoked, identity)).rejects.toMatchObject(
        { code: 'summary_progress_expired' },
      );
    });
  },
);
