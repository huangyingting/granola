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
import { operationsSnapshotSchema } from '@windows-ai-notes/contracts/operations';
import { summaryRequestSchema } from '@windows-ai-notes/contracts/server';
import { Database, type Transaction } from './index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const privateMarker = 'private-operations-content-marker';
const zero = { input_tokens: '0', output_tokens: '0', audio_ms: '0' };
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.skipIf(!databaseUrl)('deployment-only PostgreSQL diagnostics', () => {
  let admin: Database;
  let db: Database;
  let scopedUrl: string;
  const schema = `operations_test_${randomUUID().replaceAll('-', '')}`;
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
    await db.pool.query('TRUNCATE workspaces,users CASCADE');
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
    const user = await db.provision('urn:operations:test', randomUUID());
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
  async function job(
    source: Awaited<ReturnType<typeof fixture>>,
    state = 'queued',
  ) {
    const result = await db.enqueueSummary(
      source.user.user_id,
      source.document.id,
      summaryRequestSchema.parse({ note_revision: 1, transcript_revision: 0 }),
      randomUUID(),
    );
    await db.pool.query('UPDATE jobs SET state=$2 WHERE id=$1', [
      result.id,
      state,
    ]);
    return result.id;
  }
  async function turn(
    source: Awaited<ReturnType<typeof fixture>>,
    minutes: number,
    state: 'queued' | 'running' = 'queued',
    expired = false,
  ) {
    const thread = randomUUID();
    const id = randomUUID();
    await db.pool.query(
      'INSERT INTO chat_threads(id,document_id,owner_id,title,last_position) VALUES($1,$2,$3,$4,1)',
      [thread, source.document.id, source.user.user_id, privateMarker],
    );
    await db.pool.query(
      `INSERT INTO chat_turns(id,thread_id,document_id,owner_id,position,idempotency_key,request_hash,
        request,evidence_hash,mode,state,lease_until,created_at,expires_at)
       VALUES($1::uuid,$2,$3,$4,1,$1::text,$5,$6,$5,'full',$7,
         CASE WHEN $7='running' THEN now()-interval '1 second' END,
         now()-($8*interval '1 minute'),now()+($9*interval '1 hour'))`,
      [
        id,
        thread,
        source.document.id,
        source.user.user_id,
        'a'.repeat(64),
        JSON.stringify({ question: privateMarker }),
        state,
        minutes,
        expired ? -1 : 24,
      ],
    );
    return id;
  }
  it('uses a read-only consistent snapshot and distinguishes no work from zero age', async () => {
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
    const snapshot = await db.operations();
    expect(snapshot.jobs).toEqual({
      queued: '0',
      retry_wait: '0',
      running: '0',
      succeeded: '0',
      failed: '0',
      cancelled: '0',
      claimable: '0',
      expired_leases: '0',
      oldest_claimable_age_ms: null,
    });
    expect(snapshot.chat.oldest_claimable_age_ms).toBeNull();
    expect(snapshot.audio.oldest_claimable_deletion_age_ms).toBeNull();
    expect(snapshot.usage.settled).toEqual(zero);
    expect(snapshot.usage.accounts).toBe('0');
    expect(snapshot.scope).toBe('deployment');
    expect(operationsSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      operationsSnapshotSchema.safeParse({ ...snapshot, notes: privateMarker })
        .success,
    ).toBe(false);
    for (const queued of [-1, 1, 1.5, '-1', '1.5', '01', '1e3'])
      expect(
        operationsSnapshotSchema.safeParse({
          ...snapshot,
          jobs: { ...snapshot.jobs, queued },
        }).success,
      ).toBe(false);
  });
  it('reports retained outcomes but excludes future, revoked and deleted work from claimable jobs', async () => {
    const source = await fixture();
    const queued = await job(source);
    await db.pool.query(
      "UPDATE jobs SET created_at=now()-interval '20 minutes' WHERE id=$1",
      [queued],
    );
    const retry = await job(source, 'retry_wait');
    await db.pool.query(
      "UPDATE jobs SET available_at=now()+interval '1 hour' WHERE id=$1",
      [retry],
    );
    const running = await job(source, 'running');
    const expired = await job(source, 'running');
    await db.pool.query(
      "UPDATE jobs SET lease_until=now()+CASE WHEN id=$1 THEN interval '1 hour' ELSE interval '-1 second' END WHERE id=ANY($2::uuid[])",
      [running, [running, expired]],
    );
    for (const state of ['succeeded', 'failed', 'cancelled'])
      await job(source, state);
    const revoked = await fixture();
    await job(revoked);
    await db.pool.query(
      'UPDATE memberships SET active=false WHERE user_id=$1',
      [revoked.user.user_id],
    );
    const deleted = await fixture();
    await job(deleted);
    await db.pool.query('UPDATE documents SET deleted_at=now() WHERE id=$1', [
      deleted.document.id,
    ]);
    const snapshot = await db.operations();
    expect(snapshot.jobs).toMatchObject({
      queued: '3',
      retry_wait: '1',
      running: '2',
      succeeded: '1',
      failed: '1',
      cancelled: '1',
      claimable: '2',
      expired_leases: '1',
    });
    expect(
      BigInt(snapshot.jobs.oldest_claimable_age_ms!),
    ).toBeGreaterThanOrEqual(1_200_000n);
    expect((await db.claim())?.id).toBe(queued);
    expect((await db.operations()).jobs.claimable).toBe('1');
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
    expect(JSON.stringify(snapshot)).not.toContain(source.user.user_id);
    expect(JSON.stringify(snapshot)).not.toContain(source.document.id);
  });
  it('matches chat expiry and job-priority scheduling without treating queued rows as dispatchable', async () => {
    const source = await fixture();
    const queued = await job(source);
    await db.pool.query(
      "UPDATE jobs SET created_at=now()-interval '20 minutes' WHERE id=$1",
      [queued],
    );
    await turn(source, 30);
    await turn(source, 10);
    await turn(source, 25, 'running');
    await turn(source, 40, 'queued', true);
    const otherUser = await db.provision(
      'urn:operations:test',
      randomUUID(),
      source.user.workspace_id,
    );
    await turn({ user: otherUser, document: source.document }, 50);
    const snapshot = await db.operations();
    expect(snapshot.chat).toMatchObject({
      queued: '4',
      running: '1',
      claimable: '2',
      expired_leases: '1',
    });
    expect(
      BigInt(snapshot.chat.oldest_claimable_age_ms!),
    ).toBeGreaterThanOrEqual(1_800_000n);
    await db.pool.query("UPDATE jobs SET state='cancelled' WHERE id=$1", [
      queued,
    ]);
    expect((await db.operations()).chat.claimable).toBe('3');
  });
  it('reports database leases and actual recent closure categories, not inferred socket counts', async () => {
    const source = await fixture();
    async function lease(
      code: 'settled' | 'failed' | 'expired' | 'cancelled' | null,
      closedHours = 0,
      expired = false,
    ) {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO live_sources(id,owner_id,document_id,workspace_id,recording_id,preview_id,track_id,capture_epoch)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          source.user.user_id,
          source.document.id,
          source.user.workspace_id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ],
      );
      await db.pool.query(
        `INSERT INTO live_leases(id,source_id,owner_id,document_id,lease_token,request_key,request_hash,
         locale,provider,configuration_version,membership_epoch,user_epoch,
         access_expires_at,lease_until,deadline,closed_at,close_code)
         VALUES($1,$2,$3,$4,$1,$1,$5,'en-US','fixture',$6,1,1,
           now()+interval '70 seconds',now()+($7*interval '1 second'),now()+interval '70 seconds',
           CASE WHEN $8::text IS NOT NULL THEN now()-($9*interval '1 hour') END,$8)`,
        [
          randomUUID(),
          id,
          source.user.user_id,
          source.document.id,
          'a'.repeat(64),
          privateMarker,
          expired ? -1 : 30,
          code,
          closedHours,
        ],
      );
    }
    await lease(null);
    await lease(null, 0, true);
    for (const code of ['settled', 'failed', 'expired', 'cancelled'] as const)
      await lease(code);
    await lease('expired', 2);
    await lease('failed', -1);
    expect((await db.operations()).live).toEqual({
      open_leases: '2',
      expired_open_leases: '1',
      closed_last_hour: {
        settled: '1',
        failed: '1',
        expired: '1',
        cancelled: '1',
      },
    });
  });
  it('separates pending object erasure, active protection, cleanup failures and deleted-object rechecks', async () => {
    const source = await fixture();
    const recording = randomUUID();
    await db.pool.query(
      `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
       VALUES($1::uuid,$2,$3,$4,now(),'[]',$1::text,$5)`,
      [
        recording,
        source.document.id,
        source.user.workspace_id,
        source.user.user_id,
        privateMarker,
      ],
    );
    async function object(kind = 'staging') {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,protected_until,cleanup_after)
         VALUES($1,$2,$3,$4,now()-interval '5 minutes',now()-interval '4 minutes')`,
        [id, recording, randomUUID(), kind],
      );
      return id;
    }
    const due = await object('verified');
    const protectedObject = await object();
    await db.pool.query(
      "UPDATE recording_objects SET protected_until=now()+interval '1 hour' WHERE id=$1",
      [protectedObject],
    );
    const leased = await object();
    await db.pool.query(
      "UPDATE recording_objects SET cleanup_until=now()+interval '1 minute' WHERE id=$1",
      [leased],
    );
    const failed = await object();
    await db.pool.query(
      'UPDATE recording_objects SET last_error=$2 WHERE id=$1',
      [failed, privateMarker],
    );
    const tombstone = await object('verified');
    await db.pool.query(
      'UPDATE recording_objects SET deleted_at=now() WHERE id=$1',
      [tombstone],
    );
    const retained = await object('verified');
    await db.pool.query(
      `INSERT INTO recording_chunks(id,recording_id,track_id,sequence,sample_start,sample_count,
        descriptor,request_key,request_hash,state,verified_object)
       VALUES($1::uuid,$2,$3,0,0,1,'{}',$1::text,$4,'verified',$5)`,
      [randomUUID(), recording, randomUUID(), privateMarker, retained],
    );
    const expired = randomUUID();
    await db.pool.query(
      `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash,retention_expires_at)
       VALUES($1::uuid,$2,$3,$4,now(),'[]',$1::text,$5,now()-interval '1 second')`,
      [
        expired,
        source.document.id,
        source.user.workspace_id,
        source.user.user_id,
        privateMarker,
      ],
    );
    const snapshot = await db.operations();
    expect(snapshot.audio).toMatchObject({
      expired_recordings_awaiting_revocation: '1',
      pending_object_deletions: '4',
      object_deletions_claimable: '2',
      object_deletion_errors: '1',
      tombstone_rechecks_claimable: '1',
    });
    expect(
      BigInt(snapshot.audio.oldest_claimable_deletion_age_ms!),
    ).toBeGreaterThanOrEqual(240_000n);
    const claimed = await db.recordings.claimCleanup();
    expect(claimed.map((row) => row.id).sort()).toEqual(
      [due, failed, tombstone].sort(),
    );
    expect(
      (await db.operations()).audio.expired_recordings_awaiting_revocation,
    ).toBe('0');
    for (const row of claimed) await db.recordings.finishCleanup(row, true);
    expect((await db.operations()).audio).toMatchObject({
      pending_object_deletions: '2',
      object_deletions_claimable: '0',
      object_deletion_errors: '0',
      tombstone_rechecks_claimable: '0',
      oldest_claimable_deletion_age_ms: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
  });
  it('preserves exact usage, UTC-month boundaries, old uncertain calls and lowered budgets in the real CLI', async () => {
    for (const input of ['9007199254740993', '4']) {
      const source = await fixture();
      await db.usage.setLimits(source.user.user_id, {
        input_tokens: 100,
        output_tokens: 100,
        audio_ms: 100,
      });
      await db.pool.query(
        `INSERT INTO ai_usage_periods(owner_id,period_start,settled,uncertain,settled_requests,uncertain_requests)
         VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$2,$3,9007199254740993,1),
         ($1,(date_trunc('month',now() AT TIME ZONE 'UTC')-interval '1 month')::date,$4,$4,50,50)`,
        [
          source.user.user_id,
          JSON.stringify({ ...zero, input_tokens: input }),
          JSON.stringify({ ...zero, audio_ms: '5' }),
          JSON.stringify({ ...zero, audio_ms: '999' }),
        ],
      );
      await db.pool.query(
        `INSERT INTO ai_usage_calls(id,owner_id,period_start,lease_token,operation,provider,configuration_version,reserved)
         SELECT gen_random_uuid(),owner_id,period_start,1,'summary','fixture',$2,$3
         FROM ai_usage_periods WHERE owner_id=$1`,
        [source.user.user_id, privateMarker, JSON.stringify(zero)],
      );
    }
    const snapshot = await db.operations();
    expect(snapshot.usage).toMatchObject({
      accounts: '2',
      over_budget_accounts: '1',
      settled: { ...zero, input_tokens: '9007199254740997' },
      uncertain: { ...zero, audio_ms: '10' },
      settled_requests: '18014398509481986',
      uncertain_requests: '2',
      unsettled_calls_all_periods: '4',
    });
    expect(snapshot.usage.period_start).toBe(
      `${snapshot.observed_at.slice(0, 7)}-01`,
    );
    const result = spawnSync(process.execPath, [cli, 'operations'], {
      env: { ...process.env, DATABASE_URL: scopedUrl },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      operationsSnapshotSchema.parse(JSON.parse(result.stdout)).usage,
    ).toEqual(snapshot.usage);
    expect(result.stdout).not.toContain(privateMarker);
    expect(result.stdout).not.toContain('postgres');
    const filtered = spawnSync(
      process.execPath,
      [cli, 'operations', '--user-id', randomUUID()],
      {
        env: { ...process.env, DATABASE_URL: scopedUrl },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(filtered.status).toBe(1);
    expect(filtered.stdout).toBe('');
    expect(filtered.stderr).toContain('does not accept filters');
  });
  it('fails explicitly on malformed accounting, then rolls back cleanly instead of returning healthy zeroes', async () => {
    const source = await fixture();
    await db.usage.setLimits(source.user.user_id, {
      input_tokens: 100,
      output_tokens: 100,
      audio_ms: 100,
    });
    await db.pool.query(
      `INSERT INTO ai_usage_periods(owner_id,period_start,settled,uncertain)
       VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$2,$3)`,
      [
        source.user.user_id,
        JSON.stringify({ ...zero, input_tokens: privateMarker }),
        JSON.stringify(zero),
      ],
    );
    await expect(db.operations()).rejects.toThrow(
      'Operational usage accounting is invalid.',
    );
    const result = spawnSync(process.execPath, [cli, 'operations'], {
      env: { ...process.env, DATABASE_URL: scopedUrl },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(privateMarker);
    expect(result.stderr).not.toContain(scopedUrl);
    await db.pool.query('UPDATE ai_usage_periods SET settled=$1', [
      JSON.stringify(zero),
    ]);
    expect((await db.operations()).usage.settled).toEqual(zero);
    vi.spyOn(db.pool, 'query').mockRejectedValueOnce(new Error(privateMarker));
    await expect(db.operations()).rejects.toThrow(privateMarker);
  });
});
