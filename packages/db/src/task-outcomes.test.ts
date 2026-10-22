import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import {
  operationsSnapshotSchema,
  taskOutcomesSnapshotSchema,
} from '@windows-ai-notes/contracts/operations';
import { Database, type Transaction } from './index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const privateMarker = 'private-task-outcomes-marker';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const empty = {
  succeeded: '0',
  failed: '0',
  cancelled: '0',
  non_cancelled_terminal_entries: '0',
  success_share_ppm: null,
};

describe.skipIf(!databaseUrl)('transactional deployment task outcomes', () => {
  let admin: Database, db: Database, scopedUrl: string;
  const schema = `task_outcomes_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = new Database(databaseUrl!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.href;
    db = new Database(scopedUrl);
    await db.migrate();
  });
  beforeEach(async () => {
    await db.migrate();
    await db.pool.query(`TRUNCATE audit_events,workspaces,users CASCADE;
      UPDATE deletion_recovery_state SET usage_review_required=false;
      INSERT INTO task_outcome_coverage VALUES(true,clock_timestamp(),false)
        ON CONFLICT(singleton) DO UPDATE SET observed_since=excluded.observed_since,recovery_pending=false`);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  });
  async function fixture() {
    const user = await db.provision(privateMarker, randomUUID());
    const document = await db.createDocument(
      user.user_id,
      {
        workspace_id: user.workspace_id,
        title: privateMarker,
        notes: privateMarker,
      },
      randomUUID(),
    );
    return { user, document };
  }
  async function job(source: Awaited<ReturnType<typeof fixture>>) {
    return db.enqueueSummary(
      source.user.user_id,
      source.document.id,
      { note_revision: 1, transcript_revision: 0, language: 'en' },
      randomUUID(),
    );
  }
  async function turn(source: Awaited<ReturnType<typeof fixture>>) {
    const thread = randomUUID(),
      id = randomUUID();
    await db.pool.query(
      'INSERT INTO chat_threads(id,document_id,owner_id,title,last_position) VALUES($1,$2,$3,$4,1)',
      [thread, source.document.id, source.user.user_id, privateMarker],
    );
    await db.pool.query(
      `INSERT INTO chat_turns(id,thread_id,document_id,owner_id,position,idempotency_key,request_hash,request,evidence_hash,mode)
       VALUES($1::uuid,$2,$3,$4,1,$1::text,$5,$6,$5,'full')`,
      [
        id,
        thread,
        source.document.id,
        source.user.user_id,
        'a'.repeat(64),
        JSON.stringify({ question: privateMarker }),
      ],
    );
    return id;
  }
  it('reads a consistent read-only snapshot, with null success share for an empty denominator', async () => {
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(
      async <T>(operation: (tx: Transaction) => Promise<T>): Promise<T> =>
        original(async (tx) => {
          const result = await operation(tx);
          expect(
            (await tx.query('SHOW transaction_read_only')).rows[0],
          ).toEqual({
            transaction_read_only: 'on',
          });
          expect(
            (await tx.query('SHOW transaction_isolation')).rows[0],
          ).toEqual({
            transaction_isolation: 'repeatable read',
          });
          return result;
        }),
    );
    const snapshot = await db.taskOutcomes();
    expect(snapshot).toMatchObject({
      status: 'observing',
      basis: 'audit_terminal_state_entries',
      window_hours: 24,
      window_complete: false,
      entries: { jobs: empty, chat: empty },
    });
    expect(snapshot.window_start).toBe(snapshot.coverage_since);
  });
  it('counts terminal entries, not no-op writes, transient retries, lease replacements or rolled-back work', async () => {
    const source = await fixture();
    const queued = await job(source);
    await db.pool.query(`UPDATE jobs SET state='running' WHERE id=$1`, [
      queued.id,
    ]);
    await db.pool.query(
      `UPDATE jobs SET lease_token=lease_token+1 WHERE id=$1`,
      [queued.id],
    );
    await db.pool.query(`UPDATE jobs SET state='retry_wait' WHERE id=$1`, [
      queued.id,
    ]);
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`UPDATE jobs SET state='succeeded' WHERE id=$1`, [
          queued.id,
        ]);
        throw new Error('rollback-outcome');
      }),
    ).rejects.toThrow('rollback-outcome');
    expect((await db.taskOutcomes()).entries?.jobs).toEqual(empty);
    await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
      queued.id,
    ]);
    await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
      queued.id,
    ]);
    await db.pool.query(`UPDATE jobs SET state='queued' WHERE id=$1`, [
      queued.id,
    ]);
    await db.pool.query(`UPDATE jobs SET state='succeeded' WHERE id=$1`, [
      queued.id,
    ]);
    const cancelled = await job(source);
    await db.cancel(source.user.user_id, cancelled.id);
    await db.cancel(source.user.user_id, cancelled.id);
    const snapshot = await db.taskOutcomes();
    expect(snapshot.entries?.jobs).toEqual({
      succeeded: '1',
      failed: '1',
      cancelled: '1',
      non_cancelled_terminal_entries: '2',
      success_share_ppm: 500_000,
    });
    expect((await db.operations()).jobs).toMatchObject({
      succeeded: '1',
      failed: '0',
      cancelled: '1',
    });
  });
  it('does not count fenced or repeated worker failure callbacks, and does not count retry_wait as failed', async () => {
    const source = await fixture();
    await job(source);
    const first = await db.claim();
    if (!first) throw new Error('Expected claimed fixture job.');
    const retry = {
      code: 'fixture_retry',
      message: privateMarker,
      retryable: true,
    };
    expect(await db.finishOutcome(first, null, retry)).toBe('retry_wait');
    expect(await db.finishOutcome(first, null, retry)).toBe('fenced');
    expect((await db.taskOutcomes()).entries?.jobs).toEqual(empty);
    await db.pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [
      first.id,
    ]);
    const second = await db.claim();
    if (!second) throw new Error('Expected reclaimed fixture job.');
    const outcomes = await Promise.all([
      db.finishOutcome(second, null, { ...retry, retryable: false }),
      db.finishOutcome(second, null, { ...retry, retryable: false }),
    ]);
    expect(outcomes.sort()).toEqual(['failed', 'fenced']);
    expect((await db.taskOutcomes()).entries?.jobs).toEqual({
      ...empty,
      failed: '1',
      non_cancelled_terminal_entries: '1',
      success_share_ppm: 0,
    });
  });
  it('preserves committed job and chat outcomes after resource erasure without exposing content or identifiers', async () => {
    const source = await fixture();
    const queued = await job(source),
      answer = await turn(source);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE jobs SET state='succeeded' WHERE id=$1`, [
        queued.id,
      ]);
      await tx.query(`UPDATE chat_turns SET state='failed' WHERE id=$1`, [
        answer,
      ]);
      await tx.query(`UPDATE chat_turns SET state='queued' WHERE id=$1`, [
        answer,
      ]);
      await tx.query(
        `UPDATE chat_turns SET state='succeeded',result='{}' WHERE id=$1`,
        [answer],
      );
    });
    const before = await db.taskOutcomes();
    expect(before.entries?.chat).toEqual({
      ...empty,
      succeeded: '1',
      failed: '1',
      non_cancelled_terminal_entries: '2',
      success_share_ppm: 500_000,
    });
    await db.deleteDocument(source.user.user_id, source.document.id);
    await db.pool.query('DELETE FROM jobs WHERE document_id=$1', [
      source.document.id,
    ]);
    expect((await db.operations()).jobs.succeeded).toBe('0');
    const after = await db.taskOutcomes();
    expect(after.entries).toEqual(before.entries);
    expect(after.coverage_since).toBe(before.coverage_since);
    for (const marker of [
      privateMarker,
      source.user.user_id,
      source.user.workspace_id,
      source.document.id,
      queued.id,
      answer,
      scopedUrl,
    ])
      expect(JSON.stringify(after)).not.toContain(marker);
  });
  it('serializes duplicate concurrent transitions without global counters or double counting', async () => {
    const source = await fixture();
    const jobs = await Promise.all(
      Array.from({ length: 6 }, () => job(source)),
    );
    await Promise.all(
      jobs.flatMap((entry) =>
        Array.from({ length: 2 }, () =>
          db.pool.query(`UPDATE jobs SET state='succeeded' WHERE id=$1`, [
            entry.id,
          ]),
        ),
      ),
    );
    expect((await db.taskOutcomes()).entries?.jobs).toEqual({
      ...empty,
      succeeded: '6',
      non_cancelled_terminal_entries: '6',
      success_share_ppm: 1_000_000,
    });
  });
  it('uses a database-clock 24-hour event window, excludes future entries and keeps retention cleanup bounded', async () => {
    const source = await fixture();
    const queued = await job(source);
    await db.pool.query(`UPDATE jobs SET state='succeeded' WHERE id=$1`, [
      queued.id,
    ]);
    await db.pool.query(
      `UPDATE task_outcome_coverage SET observed_since=now()-interval '40 days'`,
    );
    await db.pool.query(
      `INSERT INTO audit_events(action,resource_type,resource_id,source,to_state,created_at)
       VALUES('job_state_changed','job',$1,'system','failed',now()-interval '25 hours'),
         ('job_state_changed','job',$1,'system','failed',now()+interval '1 hour'),
         ('chat_turn_state_changed','chat_turn',$1,'system','cancelled',now()-interval '23 hours'),
         ('live_lease_closed','live_lease',$1,'system','failed',now()),
         ('usage_settled','usage_call',$1,'system','settled',now())`,
      [randomUUID()],
    );
    await db.pool.query(
      `INSERT INTO audit_events(action,resource_type,resource_id,source,to_state,created_at)
       SELECT 'job_state_changed','job',$1,'system','failed',now()-interval '31 days'
       FROM generate_series(1,1001)`,
      [randomUUID()],
    );
    const snapshot = await db.taskOutcomes();
    expect(snapshot.window_complete).toBe(true);
    expect(
      Date.parse(snapshot.observed_at) - Date.parse(snapshot.window_start),
    ).toBe(86_400_000);
    expect(snapshot.entries?.jobs).toEqual({
      ...empty,
      succeeded: '1',
      non_cancelled_terminal_entries: '1',
      success_share_ppm: 1_000_000,
    });
    expect(snapshot.entries?.chat).toEqual({ ...empty, cancelled: '1' });
    await db.transaction((tx) => db.audit.prune(tx));
    expect((await db.audit.page()).expired_rows_pending_cleanup).toBe('1');
    expect((await db.taskOutcomes()).entries).toEqual(snapshot.entries);
    await db.transaction((tx) => db.audit.prune(tx));
    expect((await db.audit.page()).expired_rows_pending_cleanup).toBe('0');
  });
  it.each([false, true])(
    'starts a truthful migration boundary without backfilled outcomes (prior recovery pending: %s)',
    async (pending) => {
      const source = await fixture();
      const queued = await job(source);
      await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
        queued.id,
      ]);
      await db.pool.query(
        'UPDATE deletion_recovery_state SET usage_review_required=$1',
        [pending],
      );
      await db.pool.query(`DROP TABLE task_outcome_coverage;
      DROP INDEX audit_events_terminal_outcomes;
      DELETE FROM schema_migrations WHERE version=16`);
      await expect(db.taskOutcomes()).rejects.toThrow(
        'Apply database migrations',
      );
      await db.migrate();
      const after = await db.taskOutcomes();
      expect(after.status).toBe(pending ? 'recovery_pending' : 'observing');
      expect(after.entries).toEqual(
        pending ? null : { jobs: empty, chat: empty },
      );
      await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
        queued.id,
      ]);
      expect((await db.taskOutcomes()).entries).toEqual(after.entries);
      await db.migrate();
      const restarted = new Database(scopedUrl);
      try {
        expect((await restarted.taskOutcomes()).coverage_since).toBe(
          after.coverage_since,
        );
        expect((await restarted.taskOutcomes()).entries).toEqual(after.entries);
      } finally {
        await restarted.close();
      }
    },
  );
  it('exposes a separate strict deployment CLI and preserves operations v1', async () => {
    const source = await fixture(),
      queued = await job(source);
    await db.pool.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`, [
      queued.id,
    ]);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, DATABASE_URL: scopedUrl },
        encoding: 'utf8',
        timeout: 10_000,
      });
    const result = run('task-outcomes');
    expect(result.status, result.stderr).toBe(0);
    const snapshot = taskOutcomesSnapshotSchema.parse(
      JSON.parse(result.stdout),
    );
    expect(snapshot.entries?.jobs).toEqual({ ...empty, cancelled: '1' });
    expect(result.stdout).not.toContain(privateMarker);
    expect(result.stdout).not.toContain(scopedUrl);
    for (const option of [
      ['--user-id', randomUUID()],
      ['--limit', '10'],
      ['--restored-backup'],
    ]) {
      const invalid = run('task-outcomes', ...option);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('invalid_task_outcomes');
    }
    const operations = run('operations');
    expect(operations.status, operations.stderr).toBe(0);
    expect(
      operationsSnapshotSchema.safeParse(JSON.parse(operations.stdout)).success,
    ).toBe(true);
    expect(operations.stdout).not.toContain('coverage_since');
    await db.pool.query(
      'UPDATE task_outcome_coverage SET recovery_pending=true',
    );
    const pending = run('task-outcomes');
    expect(pending.status, pending.stderr).toBe(0);
    expect(
      taskOutcomesSnapshotSchema.parse(JSON.parse(pending.stdout)),
    ).toMatchObject({
      status: 'recovery_pending',
      entries: null,
    });
  });
  it('fails explicitly for missing coverage or inconsistent database clocks instead of fabricating healthy zeroes', async () => {
    await db.pool.query(
      `UPDATE task_outcome_coverage SET observed_since=now()+interval '1 hour'`,
    );
    await expect(db.taskOutcomes()).rejects.toThrow(
      'observation window is inconsistent',
    );
    await db.pool.query('DELETE FROM task_outcome_coverage');
    await expect(db.taskOutcomes()).rejects.toThrow('did not return a row');
    const failed = spawnSync(process.execPath, [cli, 'task-outcomes'], {
      env: { ...process.env, DATABASE_URL: scopedUrl },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('Database command failed.');
    expect(failed.stderr).not.toContain(scopedUrl);
  });
  it('suspends a declared restore even when independent archive preflight cannot start', async () => {
    const source = await fixture(),
      queued = await job(source);
    await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
      queued.id,
    ]);
    const before = await db.taskOutcomes();
    expect(before.entries?.jobs.failed).toBe('1');
    await expect(
      db.deletions.recover(AbortSignal.timeout(10_000), true),
    ).rejects.toMatchObject({ code: 'deletion_archive_required' });
    const after = await db.taskOutcomes();
    expect(after).toMatchObject({ status: 'recovery_pending', entries: null });
    expect(after.coverage_since).toBe(before.coverage_since);
  });
});
