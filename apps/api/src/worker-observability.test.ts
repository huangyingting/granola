import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
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
import { makeSilentWav } from '@windows-ai-notes/ai/wav';
import {
  ServiceError,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';
import { runOnce } from '@windows-ai-notes/worker';
import {
  workerObservability,
  type WorkerObservability,
} from '@windows-ai-notes/worker/observability';
import { createServer } from './server.js';

const url = process.env.TEST_DATABASE_URL;
const privateText = 'private-worker-meeting-configuration';
function summary(snapshot: SummarySnapshot) {
  return {
    overview: {
      text: privateText,
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
function providers(extra: Partial<AiProviders> = {}): AiProviders {
  return {
    provider: 'fixture',
    configurationVersion: privateText,
    summarize: async (snapshot) => ({
      summary: summary(snapshot),
      usage: { input_tokens: 2, output_tokens: 3, audio_ms: 0 },
    }),
    transcribe: async () => ({
      segments: [
        { id: randomUUID(), start_ms: 0, end_ms: 1000, text: privateText },
      ],
      usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
    }),
    answer: async (input) => ({
      answer: {
        answer: { text: privateText, citations: [input.units[0]!.citation] },
        status: 'answered',
      },
      usage: { input_tokens: 2, output_tokens: 3, audio_ms: 0 },
    }),
    ...extra,
  };
}

describe.skipIf(!url)(
  'authoritative worker claim, completion and lease observations',
  () => {
    const schema = `worker_metrics_${randomUUID().replaceAll('-', '')}`;
    let admin: Database, db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    let rows: Record<string, unknown>[], telemetry: WorkerObservability;
    beforeAll(async () => {
      admin = new Database(url!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(url!);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(scoped.href);
      await db.migrate();
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    });
    beforeEach(async () => {
      await db.pool.query('TRUNCATE users,workspaces,audit_events CASCADE');
      rows = [];
      telemetry = workerObservability(
        new Writable({
          write(chunk, _encoding, done) {
            rows.push(JSON.parse(String(chunk)));
            done();
          },
        }),
      );
    });
    afterEach(() => {
      telemetry.close();
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function actor() {
      const subject = randomUUID();
      const owner = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const document = await db.createDocument(
        owner.user_id,
        {
          workspace_id: owner.workspace_id,
          title: privateText,
          notes: privateText,
        },
        randomUUID(),
      );
      return {
        owner,
        document: document.id,
        headers: { 'x-dev-subject': subject, 'x-request-id': privateText },
      };
    }
    async function queue(
      kind: 'summary' | 'transcription' | 'chat' = 'summary',
    ) {
      const user = await actor();
      const clip = kind === 'transcription';
      const response = await app.inject({
        method: 'POST',
        url: `/v1/documents/${user.document}/${clip ? 'transcription-runs?base_revision=0&locale=en-US' : kind === 'chat' ? 'chat-turns' : 'summary-runs'}`,
        headers: {
          ...user.headers,
          'idempotency-key': randomUUID(),
          ...(clip ? { 'content-type': 'audio/wav' } : {}),
        },
        payload: clip
          ? makeSilentWav(1000)
          : {
              note_revision: 1,
              transcript_revision: 0,
              ...(kind === 'chat'
                ? { language: 'en', question: privateText, confirmed: true }
                : {}),
            },
      });
      expect(response.statusCode, response.body).toBe(202);
      return {
        ...user,
        id: String(response.json().id),
        request: String(response.headers['x-request-id']),
      };
    }
    const completed = () =>
      rows.filter((row) => row.code === 'worker_attempt_completed');

    it('correlates concurrent committed summary and chat outcomes with generated acceptance IDs, not meeting bodies or caller IDs', async () => {
      const jobs = [await queue('chat'), await queue()];
      expect(
        await Promise.all(
          jobs.map(() => runOnce(db, providers(), undefined, null, telemetry)),
        ),
      ).toEqual([true, true]);
      expect(
        rows.filter((row) => row.code === 'worker_attempt_started'),
      ).toHaveLength(2);
      expect(completed()).toHaveLength(2);
      for (const job of jobs) {
        const event = completed().find(
          (row) => row.origin_request_id === job.request,
        )!;
        expect(event).toMatchObject({
          completion: 'succeeded',
          completion_errors: 0,
          reclaimed_lease: false,
          attempt: 1,
        });
        expect([event.job_id, event.turn_id]).toContain(job.id);
        expect(event.acceptance_to_claim_ms).toMatch(/^(0|[1-9][0-9]*)$/);
        expect(event.processing_ms).toEqual(expect.any(Number));
        expect(JSON.stringify(rows)).not.toContain(job.owner.user_id);
        expect(JSON.stringify(rows)).not.toContain(job.document);
      }
      expect(new Set(completed().map((row) => row.attempt_id)).size).toBe(2);
      expect(JSON.stringify(rows)).not.toContain(privateText);
    });

    it('records a committed revision conflict as failed even though transcription returned successfully', async () => {
      const job = await queue('transcription');
      const base = providers();
      await runOnce(
        db,
        providers({
          transcribe: async (...args) => {
            await db.editTranscript(job.owner.user_id, job.document, 0, [
              {
                id: randomUUID(),
                start_ms: 0,
                end_ms: 1,
                text: 'Keep manual changes.',
              },
            ]);
            return base.transcribe(...args);
          },
        }),
        undefined,
        null,
        telemetry,
      );
      expect(await db.job(job.owner.user_id, job.id)).toMatchObject({
        state: 'failed',
        error: { code: 'revision_conflict' },
      });
      expect(completed()).toMatchObject([
        {
          completion: 'failed',
          completion_errors: 0,
          task_kind: 'transcription',
        },
      ]);
    });

    it('distinguishes a committed retry from terminal failure', async () => {
      const job = await queue('transcription');
      await runOnce(
        db,
        providers({
          transcribe: async () => {
            throw new ServiceError(
              'provider_unavailable',
              privateText,
              503,
              true,
            );
          },
        }),
        undefined,
        null,
        telemetry,
      );
      expect((await db.job(job.owner.user_id, job.id)).state).toBe(
        'retry_wait',
      );
      expect(completed()).toMatchObject([
        { completion: 'retry_wait', completion_errors: 0 },
      ]);
      expect(JSON.stringify(rows)).not.toContain(privateText);
    });

    it('reports actual permission cancellation instead of provider success and retains known usage', async () => {
      const job = await queue();
      const base = providers();
      await runOnce(
        db,
        providers({
          summarize: async (...args) => {
            await db.pool.query(
              'UPDATE memberships SET active=false WHERE user_id=$1',
              [job.owner.user_id],
            );
            return base.summarize(...args);
          },
        }),
        undefined,
        null,
        telemetry,
      );
      expect(
        (await db.pool.query('SELECT state FROM jobs WHERE id=$1', [job.id]))
          .rows[0].state,
      ).toBe('cancelled');
      expect(completed()).toMatchObject([
        { completion: 'cancelled', completion_errors: 0 },
      ]);
      expect(
        (await db.usage.snapshot(job.owner.user_id)).settled_requests,
      ).toBe('1');
    });

    it('identifies expired-lease reclamation without exposing fencing tokens', async () => {
      const job = await queue();
      const prior = (await db.claim())!;
      await db.pool.query(
        "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      await runOnce(db, providers(), undefined, null, telemetry);
      expect(completed()).toMatchObject([
        { completion: 'succeeded', reclaimed_lease: true, attempt: 2 },
      ]);
      expect(
        await db.finish(prior, null, {
          code: 'stale',
          message: privateText,
          retryable: false,
        }),
      ).toBe(false);
      expect(
        await db.finishOutcome(prior, null, {
          code: 'stale',
          message: privateText,
          retryable: false,
        }),
      ).toBe('fenced');
      expect((await db.job(job.owner.user_id, job.id)).state).toBe('succeeded');
      expect(
        rows.every((row) => !('lease_token' in row) && !('leaseToken' in row)),
      ).toBe(true);
    });

    it('keeps completion unobserved when PostgreSQL rolls back both deferred finalization commits', async () => {
      const job = await queue();
      await db.pool.query(`
        CREATE FUNCTION reject_completion_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state IN ('succeeded','failed') THEN
            RAISE EXCEPTION 'private-database-finalization';
          END IF;
          RETURN NEW;
        END; $$;
        CREATE CONSTRAINT TRIGGER reject_completion_commit AFTER UPDATE ON jobs
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_completion_commit()`);
      try {
        await expect(
          runOnce(db, providers(), undefined, null, telemetry),
        ).rejects.toThrow('private-database-finalization');
        expect(completed()).toMatchObject([
          { completion: 'unobserved', completion_errors: 2 },
        ]);
        expect(
          (
            await db.pool.query(
              'SELECT state,result,error FROM jobs WHERE id=$1',
              [job.id],
            )
          ).rows,
        ).toEqual([{ state: 'running', result: null, error: null }]);
        expect(JSON.stringify(rows)).not.toContain('private-');
      } finally {
        await db.pool.query(
          'DROP TRIGGER reject_completion_commit ON jobs; DROP FUNCTION reject_completion_commit()',
        );
      }
    });

    it.each(['failed', 'cancelled', 'fenced'] as const)(
      'observes chat finalization %s rather than assuming provider completion succeeded',
      async (outcome) => {
        const job = await queue('chat');
        const answer = providers().answer;
        if (!answer) throw new Error('Expected a synthetic question provider.');
        await runOnce(
          db,
          providers({
            answer: async (...args) => {
              if (outcome === 'failed')
                throw new ServiceError(
                  'provider_unavailable',
                  privateText,
                  503,
                );
              if (outcome === 'cancelled')
                await db.pool.query(
                  'UPDATE memberships SET active=false WHERE user_id=$1',
                  [job.owner.user_id],
                );
              else
                await db.pool.query(
                  "UPDATE chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1",
                  [job.id],
                );
              return answer(...args);
            },
          }),
          undefined,
          null,
          telemetry,
        );
        expect(completed()).toMatchObject([
          {
            completion: outcome,
            task_kind: 'chat',
            turn_id: job.id,
            job_id: null,
            origin_request_id: job.request,
          },
        ]);
        expect(
          (
            await db.pool.query('SELECT state FROM chat_turns WHERE id=$1', [
              job.id,
            ])
          ).rows[0].state,
        ).toBe(outcome === 'fenced' ? 'running' : outcome);
        if (outcome !== 'failed')
          expect(
            (await db.usage.snapshot(job.owner.user_id)).settled_requests,
          ).toBe('1');
      },
    );

    it('does not invent origins or zero acceptance latency for historical/future-dated rows', async () => {
      const job = await queue();
      await db.pool.query(
        "UPDATE jobs SET origin_request_id=NULL,created_at=now()+interval '1 day' WHERE id=$1",
        [job.id],
      );
      await runOnce(db, providers(), undefined, null, telemetry);
      expect(completed()).toMatchObject([
        {
          origin_request_id: null,
          acceptance_to_claim_ms: null,
          completion: 'succeeded',
        },
      ]);
    });

    it('observes a real periodic database renewal refusal and provider abort, then reports fenced rather than failed publication', async () => {
      const job = await queue();
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const shutdown = new AbortController();
      const model = providers({
        summarize: async (_snapshot, signal) => {
          if (!signal) throw new Error('Expected the worker lease signal.');
          return new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  new ServiceError('provider_cancelled', privateText, 503),
                ),
              { once: true },
            );
            started();
          });
        },
      });
      const running = runOnce(db, model, shutdown.signal, null, telemetry);
      try {
        await entered;
        await db.pool.query(
          "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
          [job.id],
        );
        await running;
        expect(
          rows.filter((row) => row.code === 'worker_lease_observed'),
        ).toMatchObject([
          {
            job_id: job.id,
            observation: 'renewal_refused',
            elapsed_ms: expect.any(Number),
          },
        ]);
        expect(completed()).toMatchObject([
          { completion: 'fenced', lease_observation: 'renewal_refused' },
        ]);
        expect((await db.job(job.owner.user_id, job.id)).state).toBe('running');
      } finally {
        shutdown.abort();
        await running;
      }
    }, 15_000);
  },
);
