import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
import { Database } from '@windows-ai-notes/db';
import type { AiProviders } from '@windows-ai-notes/ai';
import {
  ServiceError,
  accountUsageSchema,
  DEFAULT_AI_LIMITS,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';
import { runOnce } from '@windows-ai-notes/worker';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const actual = { input_tokens: 7, output_tokens: 3, audio_ms: 0 };
const budget = { input_tokens: 10, output_tokens: 0, audio_ms: 0 };
const request = {
  operation: 'summary',
  provider: 'fixture' as const,
  configurationVersion: 'accounting-fixture-v1',
  budget,
};
function summary(snapshot: SummarySnapshot) {
  return {
    overview: {
      text: 'Synthetic known evidence.',
      citations: [
        {
          source: 'note' as const,
          id: snapshot.document_id,
          revision: snapshot.note_revision,
        },
      ],
    },
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
  };
}
const providers: AiProviders = {
  provider: 'fixture',
  configurationVersion: 'accounting-fixture-v1',
  summarize: async (snapshot) => ({
    summary: summary(snapshot),
    usage: actual,
  }),
  transcribe: async () => {
    throw new Error('This fixture does not process audio.');
  },
};

describe.skipIf(!databaseUrl)(
  'durable owner-wide AI allowances and provider usage',
  () => {
    const schema = `notes_usage_${randomUUID().replaceAll('-', '')}`;
    let admin: Database;
    let db: Database;
    let url: string;
    let app: Awaited<ReturnType<typeof createServer>>;
    let actor: { user_id: string; workspace_id: string };
    let headers: { 'x-dev-subject': string };
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      url = scoped.href;
      db = new Database(url);
      await db.migrate();
    });
    beforeEach(async () => {
      const subject = randomUUID();
      actor = await db.provision('urn:windows-ai-notes:development', subject);
      headers = { 'x-dev-subject': subject };
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    });
    afterEach(async () => {
      await app?.close();
      await db.pool
        .query(`UPDATE jobs SET state='cancelled',lease_token=lease_token+1,lease_until=NULL
      WHERE state IN ('queued','running','retry_wait')`);
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function queued() {
      const doc = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic cost test',
          notes: 'Known private meeting evidence.',
        },
        randomUUID(),
      );
      return db.enqueueSummary(
        actor.user_id,
        doc.id,
        {
          note_revision: 1,
          transcript_revision: 0,
          language: 'en',
        },
        randomUUID(),
      );
    }
    async function claimed() {
      const queuedJob = await queued();
      const job = await db.claim();
      expect(job?.id).toBe(queuedJob.id);
      if (!job) throw new Error('Expected a leased fixture job.');
      return job;
    }
    const snapshot = () => db.usage.snapshot(actor.user_id);
    it('serializes parallel reservations, refuses duplicate dispatch and settles concurrent identical receipts exactly once', async () => {
      await db.usage.setLimits(actor.user_id, {
        ...DEFAULT_AI_LIMITS,
        input_tokens: 10,
      });
      const jobs = [await claimed(), await claimed()];
      const decisions = await Promise.allSettled(
        jobs.map((job) => db.usage.start(job, request)),
      );
      const index = decisions.findIndex(
        (decision) => decision.status === 'fulfilled',
      );
      expect(
        decisions.filter((decision) => decision.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        decisions.find((decision) => decision.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'quota_exceeded' } });
      const winner = decisions[index];
      if (winner?.status !== 'fulfilled')
        throw new Error('Expected one reserved call.');
      const call = winner.value;
      expect(await snapshot()).toMatchObject({
        uncertain: { input_tokens: '10' },
        uncertain_requests: '1',
      });
      await expect(db.usage.start(jobs[index]!, request)).rejects.toMatchObject(
        { code: 'provider_request_already_started' },
      );
      await Promise.all([
        db.usage.settle(call, { ...actual, output_tokens: 0 }),
        db.usage.settle(call, { ...actual, output_tokens: 0 }),
      ]);
      expect(await snapshot()).toMatchObject({
        settled: { input_tokens: '7' },
        uncertain: { input_tokens: '0' },
        settled_requests: '1',
        uncertain_requests: '0',
      });
      await expect(
        db.usage.settle(call, { ...actual, output_tokens: 0, input_tokens: 8 }),
      ).rejects.toMatchObject({ code: 'usage_settlement_conflict' });
      expect((await snapshot()).settled.input_tokens).toBe('7');
    });
    it('fails before a provider call when the full conservative reservation is unavailable', async () => {
      await db.usage.setLimits(actor.user_id, {
        ...DEFAULT_AI_LIMITS,
        input_tokens: 63_999,
      });
      const job = await queued();
      const summarize = vi.fn(providers.summarize);
      await runOnce(db, { ...providers, summarize });
      expect(summarize).not.toHaveBeenCalled();
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
        error: { code: 'quota_exceeded', retryable: false },
      });
      expect(await snapshot()).toMatchObject({
        settled_requests: '0',
        uncertain_requests: '0',
      });
    });
    it('changes deployment-only allowances through the real CLI without resetting held usage', async () => {
      const job = await claimed();
      await db.usage.start(job, request);
      const cli = fileURLToPath(
        new URL('../../../packages/db/dist/cli.js', import.meta.url),
      );
      const command = promisify(execFile);
      const arguments_ = [
        cli,
        'usage-limits',
        '--user-id',
        actor.user_id,
        '--audio-ms',
        '1000',
        '--input-tokens',
        '20',
        '--output-tokens',
        '5',
      ];
      const result = await command(process.execPath, arguments_, {
        env: { ...process.env, DATABASE_URL: url },
      });
      expect(accountUsageSchema.parse(JSON.parse(result.stdout))).toMatchObject(
        {
          limits: { audio_ms: '1000', input_tokens: '20', output_tokens: '5' },
          uncertain: { input_tokens: '10' },
          uncertain_requests: '1',
        },
      );
      await expect(
        command(process.execPath, [...arguments_.slice(0, -1), '-1'], {
          env: { ...process.env, DATABASE_URL: url },
        }),
      ).rejects.toHaveProperty('code', 1);
      expect((await snapshot()).limits.output_tokens).toBe('5');
    });
    it('retains uncertain failed attempts and accounts only an explicitly confirmed resume separately', async () => {
      const job = await queued();
      await runOnce(db, {
        ...providers,
        summarize: async () => {
          throw new ServiceError(
            'provider_unavailable',
            'Synthetic response loss.',
            503,
            true,
          );
        },
      });
      expect(await snapshot()).toMatchObject({
        uncertain: { input_tokens: '64000', output_tokens: '4096' },
        uncertain_requests: '1',
      });
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
        error: { retryable: false },
      });
      await db.pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [
        job.id,
      ]);
      const replacement = new Database(url);
      try {
        expect(await runOnce(replacement, providers)).toBe(false);
        const progress = await replacement.summaries.progress(
          actor.user_id,
          job.id,
        );
        expect(progress.resume_token).not.toBeNull();
        await replacement.summaries.resume(
          actor.user_id,
          job.id,
          progress.resume_token!,
        );
        await runOnce(replacement, providers);
        expect(await replacement.usage.snapshot(actor.user_id)).toMatchObject({
          settled: { input_tokens: '7', output_tokens: '3' },
          uncertain: { input_tokens: '64000', output_tokens: '4096' },
          settled_requests: '1',
          uncertain_requests: '1',
        });
        expect(await replacement.job(actor.user_id, job.id)).toMatchObject({
          state: 'succeeded',
        });
      } finally {
        await replacement.close();
      }
    });
    it.each(['cancel', 'delete'])(
      'counts late known usage after %s without publishing a late artifact',
      async (action) => {
        const job = await queued();
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const running = runOnce(db, {
          ...providers,
          summarize: async (input, _signal, report) => {
            entered();
            await waiting;
            await report?.(actual);
            return { summary: summary(input), usage: actual };
          },
        });
        await started;
        if (action === 'cancel') await db.cancel(actor.user_id, job.id);
        else await db.deleteDocument(actor.user_id, job.document_id);
        finish();
        await running;
        expect(await snapshot()).toMatchObject({
          settled: { input_tokens: '7' },
          uncertain_requests: '0',
          settled_requests: '1',
        });
        const row = (
          await db.pool.query('SELECT state,result FROM jobs WHERE id=$1', [
            job.id,
          ])
        ).rows[0];
        expect(row).toMatchObject({ state: 'cancelled', result: null });
        await db.pool.query('DELETE FROM jobs WHERE id=$1', [job.id]);
        expect(
          (
            await db.pool.query(
              'SELECT job_id FROM ai_usage_calls WHERE owner_id=$1',
              [actor.user_id],
            )
          ).rows[0].job_id,
        ).toBeNull();
        expect((await snapshot()).settled.input_tokens).toBe('7');
      },
    );
    it('records known usage even when model citations are rejected', async () => {
      const job = await queued();
      await runOnce(db, {
        ...providers,
        summarize: async (input, _signal, report) => {
          await report?.(actual);
          const output = summary(input);
          output.overview.citations[0]!.revision++;
          return { summary: output, usage: actual };
        },
      });
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
        result: null,
      });
      expect(await snapshot()).toMatchObject({
        settled: { input_tokens: '7' },
        uncertain_requests: '0',
      });
    });
    it('keeps reservations and late settlement in their original UTC period when a new worker starts next month', async () => {
      await db.usage.setLimits(actor.user_id, {
        ...DEFAULT_AI_LIMITS,
        input_tokens: 10,
      });
      const old = await claimed();
      const call = await db.usage.start(old, request);
      await db.pool.query(
        `UPDATE ai_usage_periods SET period_start=(period_start-interval '1 month')::date WHERE owner_id=$1`,
        [actor.user_id],
      );
      expect(await snapshot()).toMatchObject({
        uncertain_requests: '0',
        settled_requests: '0',
      });
      await db.pool.query(
        "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      const replacement = await db.claim();
      if (!replacement) throw new Error('Expected a replacement lease.');
      await expect(db.usage.start(old, request)).rejects.toMatchObject({
        code: 'job_lease_lost',
      });
      await db.usage.start(replacement, request);
      await db.usage.settle(call, {
        input_tokens: 3,
        output_tokens: 0,
        audio_ms: 0,
      });
      expect(await snapshot()).toMatchObject({
        settled: { input_tokens: '0' },
        uncertain: { input_tokens: '10' },
        uncertain_requests: '1',
      });
      const periods = await db.pool.query<{
        settled: { input_tokens: string };
      }>(
        'SELECT settled FROM ai_usage_periods WHERE owner_id=$1 ORDER BY period_start',
        [actor.user_id],
      );
      expect(periods.rows.map((row) => row.settled.input_tokens)).toEqual([
        '3',
        '0',
      ]);
    });
    it('preserves exact totals beyond JavaScript integer precision and isolates the authenticated aggregate API', async () => {
      await db.usage.setLimits(actor.user_id, {
        ...DEFAULT_AI_LIMITS,
        input_tokens: 20,
      });
      const calls = await Promise.all(
        [await claimed(), await claimed()].map((job) =>
          db.usage.start(job, request),
        ),
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const call of calls)
        await db.usage.settle(call, {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 0,
          audio_ms: 0,
        });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('usage_reservation_exceeded'),
      );
      const other = await db.provision(
        'urn:windows-ai-notes:development',
        randomUUID(),
      );
      expect(
        (await db.usage.snapshot(other.user_id)).settled.input_tokens,
      ).toBe('0');
      const response = await app.inject({
        url: `/v1/usage?owner_id=${other.user_id}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const usage = accountUsageSchema.parse(response.json());
      expect(usage.settled.input_tokens).toBe('18014398509481982');
      expect(usage.over_limit).toBe(true);
      expect(response.body).not.toContain('configuration');
      expect((await app.inject('/v1/usage')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/v1/usage',
            headers,
            payload: { input_tokens: 999999 },
          })
        ).statusCode,
      ).toBe(404);
      const job = await claimed();
      await expect(db.usage.start(job, request)).rejects.toMatchObject({
        code: 'quota_exceeded',
      });
      expect((await snapshot()).settled.input_tokens).toBe('18014398509481982');
    });
  },
);
