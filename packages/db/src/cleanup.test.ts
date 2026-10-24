import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@windows-ai-notes/contracts/server';
import { Database, digest, type Transaction } from './index.js';
import { pruneJobHistory } from './cleanup.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('bounded transactional job housekeeping', () => {
  const schema = `job_cleanup_${randomUUID().replaceAll('-', '')}`;
  const id = (ordinal: number) =>
    `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  let admin: Database, db: Database, scopedUrl: string;
  let actor: { user_id: string; workspace_id: string }, document: string;
  beforeAll(async () => {
    admin = new Database(databaseUrl!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.href;
    db = new Database(scopedUrl);
    await db.migrate();
    await db.migrate();
    await db.assertReady();
  });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE users,workspaces CASCADE;
      INSERT INTO job_cleanup_cursor VALUES(true,NULL)
      ON CONFLICT(singleton) DO UPDATE SET job_id=NULL`);
    actor = await db.provision('urn:job-cleanup:test', randomUUID());
    document = (
      await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic job retention',
          notes: 'Synthetic retained evidence.',
        },
        randomUUID(),
      )
    ).id;
  });
  afterAll(async () => {
    try {
      await db?.close();
    } finally {
      if (admin) {
        try {
          await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.close();
        }
      }
    }
  });
  async function job(
    key: string,
    kind: 'summary' | 'recording_transcription' = 'summary',
    state: Job['state'] = 'failed',
    hours = 25,
  ) {
    const input =
      kind === 'summary'
        ? {
            kind,
            snapshot: {
              document_id: document,
              notes: 'Synthetic retained evidence.',
              segments: [],
              note_revision: 1,
              transcript_revision: 0,
              language: 'en',
            },
          }
        : {
            kind,
            recording_id: randomUUID(),
            seal_sha256: 'a'.repeat(64),
            base_transcript_revision: 0,
            locale: 'en-US',
            chunk_count: 1005,
            accept_incomplete: false,
          };
    await db.pool.query(
      `INSERT INTO jobs(id,document_id,workspace_id,owner_id,kind,idempotency_key,request_hash,input,state,updated_at,summary_started)
       VALUES($1::uuid,$2,$3,$4,$5,$1::text,$6,$7,$8,now()-($9*interval '1 hour'),$10)`,
      [
        key,
        document,
        actor.workspace_id,
        actor.user_id,
        kind,
        digest(input, true),
        JSON.stringify(input),
        state,
        hours,
        kind === 'summary',
      ],
    );
    return key;
  }
  async function events(key: string, count: number) {
    await db.pool.query(
      `INSERT INTO job_events(job_id,seq,event_type,payload,created_at)
       SELECT $1,n,'job.progress','{}',now()-interval '8 days' FROM generate_series(1,$2::integer) n`,
      [key, count],
    );
    await db.pool.query('UPDATE jobs SET event_seq=$2 WHERE id=$1', [
      key,
      count,
    ]);
  }
  async function recording(key: string, count: number) {
    await db.pool.query(
      `INSERT INTO recording_transcription_runs(job_id,provider,configuration_version,usage)
       VALUES($1,'fixture','cleanup-test','{"input_tokens":0,"output_tokens":0,"audio_ms":0}')`,
      [key],
    );
    await db.pool.query(
      `INSERT INTO recording_transcription_chunks(job_id,chunk_id,ordinal,segments)
       SELECT $1,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,n-1,'[]'
       FROM generate_series(1,$2::integer) n`,
      [key, count],
    );
  }
  async function summary(key: string, count: number) {
    await db.pool.query(
      `INSERT INTO summary_runs(job_id,input_hash,provider,configuration_version,pipeline_version,resume_token)
       SELECT id,request_hash,'fixture','cleanup-test','cleanup-test',$2 FROM jobs WHERE id=$1`,
      [key, randomUUID()],
    );
    await db.pool.query(
      `INSERT INTO summary_steps(job_id,phase,round,ordinal,input_hash,prompt_version,citations)
       SELECT $1,'extract',0,n-1,$3,'cleanup-test','[{"source":"note","revision":1}]'
       FROM generate_series(1,$2::integer) n`,
      [key, count, 'a'.repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO summary_resumes(job_id,token)
       SELECT $1,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
       FROM generate_series(1,$2::integer) n`,
      [key, count],
    );
  }
  async function counts() {
    return (
      await db.pool.query<{
        events: number;
        recordings: number;
        chunks: number;
        summaries: number;
        steps: number;
        resumes: number;
      }>(`SELECT
        (SELECT count(*)::integer FROM job_events) events,
        (SELECT count(*)::integer FROM recording_transcription_runs) recordings,
        (SELECT count(*)::integer FROM recording_transcription_chunks) chunks,
        (SELECT count(*)::integer FROM summary_runs) summaries,
        (SELECT count(*)::integer FROM summary_steps) steps,
        (SELECT count(*)::integer FROM summary_resumes) resumes`)
    ).rows[0]!;
  }
  async function checkpoint() {
    return (
      await db.pool.query<{ job_id: string | null }>(
        'SELECT job_id FROM job_cleanup_cursor WHERE singleton',
      )
    ).rows[0]?.job_id;
  }
  // Isolated schemas still share the database-wide housekeeping leader.
  const prune = () => db.transaction(pruneJobHistory);
  it('deletes at most1000 replay rows and retains exact expired-cursor snapshot recovery', async () => {
    const key = await job(id(1));
    await events(key, 1005);
    await prune();
    expect((await counts()).events).toBe(5);
    await expect(db.events(actor.user_id, key, 0)).rejects.toMatchObject({
      code: 'event_cursor_expired',
      status: 410,
    });
    expect(await db.eventState(actor.user_id, key)).toMatchObject({
      job: { id: key, state: 'failed' },
      last_event_id: 1005,
    });
    await prune();
    expect((await counts()).events).toBe(0);
    expect(await db.events(actor.user_id, key, 1005)).toMatchObject({
      events: [],
    });
  });
  it('applies the1000 replay-row budget across jobs, not separately to each job', async () => {
    await events(await job(id(1)), 600);
    await events(await job(id(2)), 600);
    await prune();
    expect((await counts()).events).toBe(200);
    await prune();
    expect((await counts()).events).toBe(0);
  });
  it('denies logically expired replay before physical housekeeping, including out-of-order timestamps', async () => {
    const key = await job(id(1));
    await events(key, 3);
    await db.pool.query(
      'UPDATE job_events SET created_at=now() WHERE job_id=$1 AND seq=2',
      [key],
    );
    await expect(db.events(actor.user_id, key, 2)).rejects.toMatchObject({
      code: 'event_cursor_expired',
      status: 410,
    });
    expect(await db.events(actor.user_id, key, 3)).toMatchObject({
      events: [],
    });
    await prune();
    expect(
      (await db.pool.query('SELECT seq FROM job_events ORDER BY seq')).rows,
    ).toEqual([{ seq: 2 }, { seq: 3 }]);
    await expect(db.events(actor.user_id, key, 1)).rejects.toMatchObject({
      code: 'event_cursor_expired',
    });
  });
  it('retains the exact seven-day event boundary and24-hour failed-run boundary using the transaction clock', async () => {
    const key = await job(id(1));
    await events(key, 1);
    await summary(key, 1);
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE job_events SET created_at=now()-interval '7 days' WHERE job_id=$1",
        [key],
      );
      await tx.query(
        "UPDATE jobs SET updated_at=now()-interval '24 hours' WHERE id=$1",
        [key],
      );
      await pruneJobHistory(tx);
    });
    expect(await counts()).toMatchObject({
      events: 1,
      summaries: 1,
      steps: 1,
      resumes: 1,
    });
  });
  it('retires progress before bounded child deletion and never expands the batch through parent cascades', async () => {
    const first = await job(id(1), 'recording_transcription');
    const second = await job(id(2));
    await recording(first, 1005);
    await summary(second, 1005);
    await prune();
    expect(await counts()).toMatchObject({
      recordings: 1,
      chunks: 5,
      summaries: 1,
      steps: 5,
      resumes: 5,
    });
    expect(await db.summaries.progress(actor.user_id, second)).toMatchObject({
      total_stages: 0,
      completed_stages: 0,
      resume_available: false,
      resume_token: null,
    });
    expect(await db.eventState(actor.user_id, second)).toMatchObject({
      completed_stages: 0,
    });
    await prune();
    expect(await counts()).toMatchObject({
      recordings: 0,
      chunks: 0,
      summaries: 0,
      steps: 0,
      resumes: 0,
    });
  });
  it('shares each child-table budget across every selected parent', async () => {
    for (const ordinal of [1, 2])
      await recording(await job(id(ordinal), 'recording_transcription'), 600);
    for (const ordinal of [3, 4]) await summary(await job(id(ordinal)), 600);
    await prune();
    expect(await counts()).toMatchObject({
      chunks: 200,
      steps: 200,
      resumes: 200,
    });
    await prune();
    expect(await counts()).toMatchObject({
      recordings: 0,
      summaries: 0,
      chunks: 0,
      steps: 0,
      resumes: 0,
    });
  });
  it('reports physical backlog before and after bounded pruning without erasing data or losing retired runs after reactivation', async () => {
    const first = await job(id(1), 'recording_transcription');
    const second = await job(id(2));
    await recording(first, 1005);
    await summary(second, 1005);
    await events(first, 1005);
    await db.pool.query(
      "UPDATE sync_changes SET created_at=now()-interval '8 days'",
    );
    const before = await db.operationsHousekeeping();
    expect(before.housekeeping).toMatchObject({
      sync: { workspaces: '1', expired_workspaces: '1', expired_changes: '1' },
      replay: { expired_jobs: '1', expired_events: '1005' },
      recordings: {
        obsolete_runs: '1',
        retired_runs: '0',
        chunks_pending_cleanup: '1005',
      },
      summaries: {
        obsolete_runs: '1',
        retired_runs: '0',
        steps_pending_cleanup: '1005',
        resume_receipts_pending_cleanup: '1005',
      },
    });
    expect(
      BigInt(before.housekeeping.sync.oldest_expired_change_age_ms!),
    ).toBeGreaterThanOrEqual(8n * 24n * 60n * 60n * 1000n);
    expect(
      BigInt(before.housekeeping.replay.oldest_expired_event_age_ms!),
    ).toBeGreaterThanOrEqual(8n * 24n * 60n * 60n * 1000n);
    expect(await counts()).toMatchObject({
      events: 1005,
      chunks: 1005,
      steps: 1005,
      resumes: 1005,
    });
    await prune();
    await db.pool.query("UPDATE jobs SET state='queued',updated_at=now()");
    const partial = await db.operationsHousekeeping();
    expect(partial.housekeeping).toMatchObject({
      replay: { expired_events: '5' },
      recordings: {
        obsolete_runs: '1',
        retired_runs: '1',
        chunks_pending_cleanup: '5',
      },
      summaries: {
        obsolete_runs: '1',
        retired_runs: '1',
        steps_pending_cleanup: '5',
        resume_receipts_pending_cleanup: '5',
      },
    });
    await db.transaction(async (tx) => {
      await pruneJobHistory(tx);
      await db.sync.prune(tx);
    });
    const after = (await db.operationsHousekeeping()).housekeeping;
    expect(after.sync).toMatchObject({
      expired_workspaces: '0',
      expired_changes: '0',
      oldest_expired_change_age_ms: null,
    });
    expect(after.replay).toEqual({
      expired_jobs: '0',
      expired_events: '0',
      oldest_expired_event_age_ms: null,
    });
    expect(after.recordings.obsolete_runs).toBe('0');
    expect(after.summaries.obsolete_runs).toBe('0');
  });
  it.each([
    { state: 'queued', hours: 200, recordingKept: true, summaryKept: true },
    { state: 'running', hours: 200, recordingKept: true, summaryKept: true },
    {
      state: 'retry_wait',
      hours: 200,
      recordingKept: true,
      summaryKept: true,
    },
    { state: 'failed', hours: 1, recordingKept: true, summaryKept: true },
    { state: 'failed', hours: 25, recordingKept: false, summaryKept: false },
    {
      state: 'succeeded',
      hours: 1,
      recordingKept: false,
      summaryKept: true,
    },
    {
      state: 'succeeded',
      hours: 200,
      recordingKept: false,
      summaryKept: false,
    },
    {
      state: 'cancelled',
      hours: 1,
      recordingKept: false,
      summaryKept: false,
    },
  ] as const)(
    'preserves original expiry eligibility for $state after$hours hours',
    async ({ state, hours, recordingKept, summaryKept }) => {
      await recording(
        await job(id(1), 'recording_transcription', state, hours),
        1,
      );
      await summary(await job(id(2), 'summary', state, hours), 1);
      const backlog = (await db.operationsHousekeeping()).housekeeping;
      expect(backlog.recordings.obsolete_runs).toBe(
        String(Number(!recordingKept)),
      );
      expect(backlog.summaries.obsolete_runs).toBe(
        String(Number(!summaryKept)),
      );
      await prune();
      expect(await counts()).toMatchObject({
        recordings: Number(recordingKept),
        chunks: Number(recordingKept),
        summaries: Number(summaryKept),
        steps: Number(summaryKept),
        resumes: Number(summaryKept),
      });
    },
  );
  it.each(['users', 'memberships'] as const)(
    'retires unauthorized progress when%s is revoked',
    async (table) => {
      await recording(
        await job(id(1), 'recording_transcription', 'running', 0),
        1,
      );
      await summary(await job(id(2), 'summary', 'running', 0), 1);
      await db.pool.query(`UPDATE ${table} SET active=false`);
      const backlog = (await db.operationsHousekeeping()).housekeeping;
      expect(backlog.recordings.obsolete_runs).toBe('1');
      expect(backlog.summaries.obsolete_runs).toBe('1');
      await prune();
      expect(await counts()).toMatchObject({
        recordings: 0,
        summaries: 0,
        chunks: 0,
        steps: 0,
        resumes: 0,
      });
    },
  );
  it('visits at most100 jobs and durably fills its budget across wraparound after restart', async () => {
    for (let ordinal = 1; ordinal <= 101; ordinal++) {
      const key = await job(id(ordinal));
      await events(key, 1);
      await summary(key, 0);
    }
    await prune();
    expect(await counts()).toMatchObject({ events: 1, summaries: 1 });
    expect(await checkpoint()).toBe(id(100));
    const lower = await job(id(0));
    await events(lower, 1);
    await summary(lower, 0);
    const restarted = new Database(scopedUrl);
    try {
      await restarted.transaction(pruneJobHistory);
    } finally {
      await restarted.close();
    }
    expect(await checkpoint()).toBe(id(98));
    expect(await counts()).toMatchObject({ events: 0, summaries: 0 });
  });
  it('skips an actually locked job without blocking other history and revisits it', async () => {
    await events(await job(id(1)), 1);
    await events(await job(id(2)), 1);
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [id(1)]);
      await db.transaction(async (tx) => {
        await tx.query("SET LOCAL statement_timeout='500ms'");
        await pruneJobHistory(tx);
      });
      expect((await counts()).events).toBe(1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    await prune();
    expect((await counts()).events).toBe(0);
  });
  it.each([1, 2])(
    'stops replay pruning at busy event%s instead of waiting or creating a cursor hole',
    async (busy) => {
      const key = await job(id(1));
      await events(key, 3);
      const lock = await db.pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query(
          'SELECT seq FROM job_events WHERE job_id=$1 AND seq=$2 FOR UPDATE',
          [key, busy],
        );
        await db.transaction(async (tx) => {
          await tx.query("SET LOCAL statement_timeout='500ms'");
          await pruneJobHistory(tx);
        });
        expect(
          (await db.pool.query('SELECT seq FROM job_events ORDER BY seq')).rows,
        ).toEqual(
          Array.from({ length: 4 - busy }, (_, index) => ({
            seq: busy + index,
          })),
        );
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
      await prune();
      expect((await counts()).events).toBe(0);
    },
  );
  it.each([
    'recording_transcription_chunks',
    'summary_steps',
    'summary_resumes',
  ] as const)(
    'does not cascade or block through a locked%s child',
    async (table) => {
      const key = await job(
        id(1),
        table === 'recording_transcription_chunks'
          ? 'recording_transcription'
          : 'summary',
      );
      if (table === 'recording_transcription_chunks') await recording(key, 1);
      else await summary(key, 1);
      const lock = await db.pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query(`SELECT job_id FROM ${table} FOR UPDATE`);
        await db.transaction(async (tx) => {
          await tx.query("SET LOCAL statement_timeout='500ms'");
          await pruneJobHistory(tx);
        });
        expect(
          (await db.pool.query(`SELECT job_id FROM ${table}`)).rowCount,
        ).toBe(1);
        const parent =
          table === 'recording_transcription_chunks'
            ? 'recording_transcription_runs'
            : 'summary_runs';
        expect(
          (
            await db.pool.query(
              `SELECT retired_at IS NOT NULL retired FROM ${parent} WHERE job_id=$1`,
              [key],
            )
          ).rows,
        ).toEqual([{ retired: true }]);
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
      await prune();
      expect(await counts()).toMatchObject({
        recordings: 0,
        summaries: 0,
        chunks: 0,
        steps: 0,
        resumes: 0,
      });
    },
  );
  it('rolls back retirement, child deletion and cursor movement together', async () => {
    const key = await job(id(1));
    await events(key, 3);
    await summary(key, 1005);
    const failure = new Error('Synthetic job cleanup rollback.');
    await expect(
      db.transaction(async (tx: Transaction) => {
        await pruneJobHistory(tx);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await checkpoint()).toBeNull();
    expect(await counts()).toMatchObject({
      events: 3,
      summaries: 1,
      steps: 1005,
      resumes: 1005,
    });
    expect(
      (await db.pool.query('SELECT retired_at FROM summary_runs')).rows,
    ).toEqual([{ retired_at: null }]);
  });
  it('reports missing housekeeping state instead of restarting a successful-looking sweep', async () => {
    await events(await job(id(1)), 1);
    await db.pool.query('DELETE FROM job_cleanup_cursor');
    await expect(prune()).rejects.toThrow('The job cleanup cursor is missing.');
    expect((await counts()).events).toBe(1);
  });
});
