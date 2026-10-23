import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  Database,
  withAuditContext,
  setAuditActor,
  bindAuditContext,
} from '@windows-ai-notes/db';
import {
  auditActionSchema,
  auditCursorSchema,
  auditEventSchema,
  auditPageSchema,
} from '@windows-ai-notes/contracts/audit';
import type { AiProviders } from '@windows-ai-notes/ai';
import { runOnce } from '@windows-ai-notes/worker';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = 'private-audit-body-configuration-marker';
const issuer = 'urn:windows-ai-notes:development';
const usage = { input_tokens: 1, output_tokens: 1, audio_ms: 0 };

describe.skipIf(!databaseUrl)(
  'transactional body-free lifecycle audits',
  () => {
    let admin: Database;
    let db: Database;
    let scopedUrl: string;
    let app: Awaited<ReturnType<typeof createServer>>;
    const schema = `audit_test_${randomUUID().replaceAll('-', '')}`;
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      scopedUrl = url.href;
      db = new Database(scopedUrl);
      await db.migrate();
      await db.migrate();
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    });
    beforeEach(async () => {
      await db.pool.query('TRUNCATE workspaces,users,audit_events CASCADE');
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
    async function owner() {
      const subject = randomUUID();
      const user = await db.provision(issuer, subject);
      return { ...user, subject, headers: { 'x-dev-subject': subject } };
    }
    async function document(
      user: Awaited<ReturnType<typeof owner>>,
      key = randomUUID(),
    ) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/documents',
        headers: {
          ...user.headers,
          'idempotency-key': key,
          'x-request-id': secret,
        },
        payload: {
          workspace_id: user.workspace_id,
          title: secret,
          notes: secret,
        },
      });
      expect(response.statusCode).toBe(201);
      return {
        id: String(response.json().id),
        requestId: response.headers['x-request-id'],
      };
    }
    async function events() {
      return (await db.audit.page({ limit: 100 })).events;
    }

    it('commits metadata atomically, rolls it back with failed changes and rejects invalid attribution', async () => {
      const user = await owner();
      const before = (await events()).length;
      await expect(
        withAuditContext(
          {
            source: 'api',
            actor_id: user.user_id,
            request_id: randomUUID(),
          },
          () =>
            db.transaction(async (tx) => {
              await tx.query(
                'UPDATE memberships SET active=false WHERE user_id=$1',
                [user.user_id],
              );
              throw new Error(secret);
            }),
        ),
      ).rejects.toThrow(secret);
      expect((await events()).length).toBe(before);
      expect(() =>
        withAuditContext(
          {
            source: 'api',
            actor_id: secret,
          },
          () => undefined,
        ),
      ).toThrow();
      expect(() => setAuditActor(user.user_id)).toThrow(
        'audit context is missing',
      );
      const created = await document(user);
      const row = (await events()).find(
        (event) => event.resource_id === created.id,
      );
      expect(row).toMatchObject({
        action: 'document_created',
        source: 'api',
        actor_id: user.user_id,
        subject_owner_id: user.user_id,
        request_id: created.requestId,
        revision: 1,
      });
      expect(JSON.stringify(await events())).not.toContain(secret);
    });
    it('keeps concurrent authenticated requests and pooled session reuse isolated', async () => {
      const users = await Promise.all([owner(), owner()]);
      const responses = await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const user = users[index % 2]!;
          return { user, created: await document(user) };
        }),
      );
      const rows = await events();
      for (const { user, created } of responses)
        expect(
          rows.find((event) => event.resource_id === created.id),
        ).toMatchObject({
          source: 'api',
          actor_id: user.user_id,
          subject_owner_id: user.user_id,
          request_id: created.requestId,
        });
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        users[0]!.user_id,
      ]);
      expect((await events())[0]).toMatchObject({
        action: 'account_access_changed',
        source: 'system',
        actor_id: null,
        request_id: null,
        active: false,
      });
      expect(
        new Set(responses.map(({ created }) => created.requestId)).size,
      ).toBe(8);
    });
    it('does not duplicate idempotent mutations and records transcript publication without source text', async () => {
      const user = await owner();
      const key = randomUUID();
      const first = await document(user, key);
      expect((await document(user, key)).id).toBe(first.id);
      expect(
        (await events()).filter((event) => event.action === 'document_created'),
      ).toHaveLength(1);
      const request = randomUUID();
      await withAuditContext(
        {
          source: 'api',
          actor_id: user.user_id,
          request_id: request,
        },
        () =>
          db.editTranscript(user.user_id, first.id, 0, [
            { id: randomUUID(), start_ms: 0, end_ms: 1000, text: secret },
          ]),
      );
      expect(
        (await events()).find(
          (event) => event.action === 'transcript_published',
        ),
      ).toMatchObject({
        resource_id: first.id,
        revision: 1,
        request_id: request,
        actor_id: user.user_id,
      });
      expect(JSON.stringify(await events())).not.toContain(secret);
    });
    async function workerScenario(remove: boolean) {
      const user = await owner();
      const created = await document(user);
      const queued = await app.inject({
        method: 'POST',
        url: `/v1/documents/${created.id}/summary-runs`,
        headers: { ...user.headers, 'idempotency-key': randomUUID() },
        payload: { note_revision: 1, transcript_revision: 0 },
      });
      expect(queued.statusCode).toBe(202);
      const job = String(queued.json().id);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let outsideReport: (() => Promise<void>) | undefined;
      const providers: AiProviders = {
        provider: 'fixture',
        configurationVersion: secret,
        transcribe: async () => {
          throw new Error('No transcription was requested.');
        },
        summarize: async (snapshot, _signal, report) => {
          if (!report) throw new Error('The usage reporter is missing.');
          outsideReport = () => report(usage);
          await gate;
          return {
            summary: {
              overview: {
                text: secret,
                citations: [
                  {
                    source: 'note',
                    id: snapshot.document_id,
                    revision: snapshot.note_revision,
                  },
                ],
              },
              topics: [],
              decisions: [],
              action_items: [],
              open_questions: [],
            },
            usage,
          };
        },
      };
      const running = runOnce(db, providers);
      try {
        await vi.waitFor(() => expect(outsideReport).toBeDefined(), {
          timeout: 5000,
        });
        if (remove) {
          const deleted = await app.inject({
            method: 'DELETE',
            url: `/v1/documents/${created.id}`,
            headers: user.headers,
          });
          expect(deleted.statusCode).toBe(204);
        }
        await outsideReport!();
      } finally {
        release();
        await running;
      }
      const rows = await events();
      expect(
        rows.find((event) => event.action === 'job_created'),
      ).toMatchObject({
        source: 'api',
        actor_id: user.user_id,
        job_id: job,
        request_id: queued.headers['x-request-id'],
      });
      expect(
        rows.filter((event) => event.action === 'usage_settled'),
      ).toHaveLength(1);
      expect(
        rows.find((event) => event.action === 'usage_settled'),
      ).toMatchObject({
        source: 'worker',
        actor_id: null,
        job_id: job,
        request_id: null,
      });
      expect(
        rows.find(
          (event) =>
            event.action === 'job_state_changed' &&
            event.to_state === (remove ? 'cancelled' : 'succeeded'),
        ),
      ).toMatchObject({ source: remove ? 'api' : 'worker', job_id: job });
      expect(JSON.stringify(rows)).not.toContain(secret);
      if (remove) {
        await expect(db.document(user.user_id, created.id)).rejects.toThrow();
        expect(
          rows.find((event) => event.action === 'document_deleted'),
        ).toMatchObject({
          source: 'api',
          actor_id: user.user_id,
          document_id: created.id,
        });
      }
    }
    it('correlates API acceptance, worker completion and callbacks invoked outside worker context', () =>
      workerScenario(false));
    it('retains body-free deletion and late-usage evidence without resurrecting a deleted result', () =>
      workerScenario(true));
    it('preserves explicitly bound callbacks without contaminating their external caller', async () => {
      const user = await owner();
      const callback = withAuditContext(
        {
          source: 'deployment',
          actor_id: user.user_id,
        },
        () =>
          bindAuditContext(() =>
            db.transaction((tx) =>
              tx.query('UPDATE users SET active=false WHERE id=$1', [
                user.user_id,
              ]),
            ),
          ),
      );
      await callback();
      expect((await events())[0]).toMatchObject({
        action: 'account_access_changed',
        source: 'deployment',
        actor_id: user.user_id,
        active: false,
      });
      await db.transaction((tx) =>
        tx.query('UPDATE users SET active=true WHERE id=$1', [user.user_id]),
      );
      expect((await events())[0]).toMatchObject({
        source: 'system',
        actor_id: null,
        request_id: null,
        active: true,
      });
    });
    it('records fenced job replacement but does not turn ordinary lease renewals into audit traffic', async () => {
      const user = await owner();
      const created = await document(user);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/documents/${created.id}/summary-runs`,
        headers: { ...user.headers, 'idempotency-key': randomUUID() },
        payload: { note_revision: 1, transcript_revision: 0 },
      });
      expect(response.statusCode).toBe(202);
      const first = await withAuditContext({ source: 'worker' }, () =>
        db.claim(),
      );
      expect(first).not.toBeNull();
      await db.pool.query(
        "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [first!.id],
      );
      const replacement = await withAuditContext({ source: 'worker' }, () =>
        db.claim(),
      );
      expect(replacement?.id).toBe(first!.id);
      const rows = await events();
      expect(
        rows.find((event) => event.action === 'job_lease_replaced'),
      ).toMatchObject({
        source: 'worker',
        job_id: first!.id,
        from_state: 'running',
        to_state: 'running',
      });
      await withAuditContext({ source: 'worker' }, () =>
        db.renew(replacement!),
      );
      expect((await events()).length).toBe(rows.length);
    });
    it('audits deletion immediately but confirms object cleanup only once, not on every tombstone recheck', async () => {
      const user = await owner();
      const created = await document(user);
      const recording = randomUUID();
      const object = randomUUID();
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO recordings
        (id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
        VALUES($1,$2,$3,$4,now(),'[]',$5,$5)`,
          [recording, created.id, user.workspace_id, user.user_id, secret],
        );
        await tx.query(
          `INSERT INTO recording_objects
        (id,recording_id,chunk_id,kind,protected_until,cleanup_after,cleanup_token,cleanup_until)
        VALUES($1,$2,$3,'verified',now(),now(),1,now()+interval '1 hour')`,
          [object, recording, randomUUID()],
        );
        await tx.query(
          'UPDATE recordings SET seal=$2,seal_hash=$3,seal_key=$4 WHERE id=$1',
          [
            recording,
            JSON.stringify({ text: secret }),
            'a'.repeat(64),
            randomUUID(),
          ],
        );
      });
      expect(
        (await events()).find((event) => event.action === 'recording_sealed'),
      ).toMatchObject({
        resource_id: recording,
        document_id: created.id,
      });
      await withAuditContext({ source: 'api', actor_id: user.user_id }, () =>
        db.recordings.remove(user.user_id, recording),
      );
      expect(
        (await events()).find(
          (event) => event.action === 'recording_access_revoked',
        ),
      ).toMatchObject({
        resource_id: recording,
        source: 'api',
        actor_id: user.user_id,
        reason: 'user',
      });
      expect(
        (await events()).filter(
          (event) => event.action === 'object_cleanup_confirmed',
        ),
      ).toHaveLength(0);
      await withAuditContext({ source: 'worker' }, () =>
        db.recordings.finishCleanup(
          { id: object, kind: 'verified', token: 1 },
          true,
        ),
      );
      await db.pool.query(
        "UPDATE recording_objects SET cleanup_until=now()+interval '1 hour' WHERE id=$1",
        [object],
      );
      await db.recordings.finishCleanup(
        { id: object, kind: 'verified', token: 1 },
        true,
      );
      const confirmed = (await events()).filter(
        (event) => event.action === 'object_cleanup_confirmed',
      );
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({
        source: 'worker',
        resource_id: object,
        document_id: created.id,
      });
      expect(JSON.stringify(await events())).not.toContain(secret);
    });
    it('records chat dispatch, cascading deletion, permission changes and retention policy without request/error content', async () => {
      const user = await owner();
      const created = await document(user);
      const thread = randomUUID();
      const turn = randomUUID();
      const liveSource = randomUUID();
      const liveLease = randomUUID();
      await withAuditContext({ source: 'worker' }, () =>
        db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO chat_threads(id,document_id,owner_id,title,last_position) VALUES($1,$2,$3,$4,1)',
            [thread, created.id, user.user_id, secret],
          );
          await tx.query(
            `INSERT INTO chat_turns
        (id,thread_id,document_id,owner_id,position,idempotency_key,request_hash,request,evidence_hash,mode)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$6,'full')`,
            [
              turn,
              thread,
              created.id,
              user.user_id,
              randomUUID(),
              'a'.repeat(64),
              JSON.stringify({ question: secret }),
            ],
          );
          await tx.query(
            "UPDATE chat_turns SET state='running',lease_until=now()+interval '1 hour' WHERE id=$1",
            [turn],
          );
          await tx.query(
            "UPDATE chat_turns SET dispatch='sending' WHERE id=$1",
            [turn],
          );
          await tx.query(
            "UPDATE chat_turns SET state='failed',lease_until=NULL,error=$2 WHERE id=$1",
            [turn, JSON.stringify({ message: secret })],
          );
          await tx.query(
            `INSERT INTO live_sources
        (id,owner_id,document_id,workspace_id,recording_id,preview_id,track_id,capture_epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              liveSource,
              user.user_id,
              created.id,
              user.workspace_id,
              randomUUID(),
              randomUUID(),
              randomUUID(),
              randomUUID(),
            ],
          );
          await tx.query(
            `INSERT INTO live_leases
        (id,source_id,owner_id,document_id,lease_token,request_key,request_hash,locale,provider,
         configuration_version,membership_epoch,user_epoch,access_expires_at,lease_until,deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,'en-US','fixture',$8,1,1,
          now()+interval '60 seconds',now()+interval '15 seconds',now()+interval '60 seconds')`,
            [
              liveLease,
              liveSource,
              user.user_id,
              created.id,
              randomUUID(),
              randomUUID(),
              'a'.repeat(64),
              secret,
            ],
          );
        }),
      );
      expect(
        (await events()).find(
          (event) => event.action === 'chat_dispatch_started',
        ),
      ).toMatchObject({
        resource_id: turn,
        turn_id: turn,
        source: 'worker',
        from_state: 'pending',
        to_state: 'sending',
      });
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/documents/${created.id}`,
            headers: user.headers,
          })
        ).statusCode,
      ).toBe(204);
      const rows = await events();
      for (const action of [
        'chat_thread_deleted',
        'chat_turn_deleted',
        'live_lease_deleted',
      ])
        expect(rows.find((event) => event.action === action)).toMatchObject({
          source: 'api',
          actor_id: user.user_id,
          document_id: created.id,
        });
      await withAuditContext({ source: 'deployment' }, async () => {
        await db.recordings.setRetentionPolicy(user.workspace_id, {
          retention_days: 1,
          processing_days: 7,
        });
        await db.transaction(async (tx) => {
          await tx.query(
            'UPDATE memberships SET active=false WHERE user_id=$1',
            [user.user_id],
          );
          await tx.query('UPDATE users SET active=false WHERE id=$1', [
            user.user_id,
          ]);
        });
      });
      const final = await events();
      expect(
        final.find((event) => event.action === 'retention_policy_changed'),
      ).toMatchObject({
        source: 'deployment',
        resource_id: user.workspace_id,
      });
      expect(
        final.find(
          (event) =>
            event.action === 'membership_access_changed' && !event.active,
        ),
      ).toMatchObject({
        source: 'deployment',
        subject_owner_id: user.user_id,
        active: false,
      });
      expect(JSON.stringify(final)).not.toContain(secret);
    });
    it('enforces a 720-hour read cutoff, exposes cleanup backlog and bounds each purge batch', async () => {
      const user = await owner();
      await db.pool.query('TRUNCATE audit_events');
      await db.pool.query(
        `INSERT INTO audit_events
      (created_at,action,resource_type,resource_id,source)
      SELECT now()-interval '721 hours','account_created','account',$1,'system'
      FROM generate_series(1,1005)`,
        [user.user_id],
      );
      const before = await db.audit.page();
      expect(before.events).toEqual([]);
      expect(before.expired_rows_pending_cleanup).toBe('1005');
      await db.cleanup();
      expect((await db.audit.page()).expired_rows_pending_cleanup).toBe('5');
      await db.cleanup();
      expect((await db.audit.page()).expired_rows_pending_cleanup).toBe('0');
      expect(
        (await db.pool.query('SELECT count(*)::int count FROM audit_events'))
          .rows[0].count,
      ).toBe(0);
    });
    it('orders numeric cursors exactly across digit boundaries and beyond JavaScript safe integers', async () => {
      const user = await owner();
      await db.pool.query('TRUNCATE audit_events');
      await db.pool.query(
        `INSERT INTO audit_events(id,action,resource_type,resource_id,source)
        SELECT n,'account_created','account',$1,'system'
        FROM unnest(ARRAY[9,10,100,9007199254740993]::bigint[]) n`,
        [user.user_id],
      );
      const first = await db.audit.page({ limit: 2 });
      expect(first.events.map((event) => event.id)).toEqual([
        '9007199254740993',
        '100',
      ]);
      const second = await db.audit.page({
        before: first.next_before!,
        limit: 2,
      });
      expect(second.events.map((event) => event.id)).toEqual(['10', '9']);
      expect(second.next_before).toBeNull();
    });
    it('offers bounded descending CLI inspection without accepting bodies, filters or HTTP admin access', async () => {
      await owner();
      const first = await db.audit.page({ limit: 1 });
      expect(first.events).toHaveLength(1);
      expect(first.next_before).not.toBeNull();
      const next = await db.audit.page({
        limit: 1,
        before: first.next_before!,
      });
      expect(BigInt(next.events[0]!.id)).toBeLessThan(
        BigInt(first.events[0]!.id),
      );
      const result = spawnSync(
        process.execPath,
        ['packages/db/dist/cli.js', 'audit', '--limit', '1'],
        {
          env: { ...process.env, DATABASE_URL: scopedUrl },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(
        auditPageSchema.parse(JSON.parse(result.stdout)).events,
      ).toHaveLength(1);
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).not.toContain('postgres');
      const invalid = spawnSync(
        process.execPath,
        ['packages/db/dist/cli.js', 'audit', '--limit', '101'],
        {
          env: { ...process.env, DATABASE_URL: scopedUrl },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe('');
      expect(auditCursorSchema.safeParse('9223372036854775808').success).toBe(
        false,
      );
      expect(auditCursorSchema.safeParse(secret).success).toBe(false);
      const user = await owner();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/audit',
            headers: user.headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        auditPageSchema.safeParse({ ...first, notes: secret }).success,
      ).toBe(false);
    });
    it('keeps SQL allowlists and internal classification body-free without changing audit v1', async () => {
      const user = await owner();
      const columns = await db.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='audit_events'`,
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
        [...auditEventSchema.keyof().options, 'job_kind'].sort(),
      );
      await db.pool.query(
        `INSERT INTO audit_events(action,resource_type,resource_id,source)
        SELECT action,'account',$1,'system' FROM unnest($2::text[]) action`,
        [user.user_id, [...auditActionSchema.options]],
      );
      const rows = await events();
      expect(rows.every((row) => !('job_kind' in row))).toBe(true);
      for (const action of auditActionSchema.options)
        expect(rows.some((row) => row.action === action)).toBe(true);
      await expect(
        db.pool.query(
          `INSERT INTO audit_events(action,resource_type,resource_id,source)
        VALUES($1,'account',$2,'system')`,
          [secret, user.user_id],
        ),
      ).rejects.toThrow();
      await expect(
        db.pool.query(
          `INSERT INTO audit_events(action,resource_type,resource_id,source,job_kind)
        VALUES('job_created','job',$1,'system',$2)`,
          [randomUUID(), secret],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
    it('fails audit writes atomically rather than committing unaudited mutations', async () => {
      const user = await owner();
      await db.pool.query(
        'ALTER TABLE audit_events ADD CONSTRAINT audit_test_unavailable CHECK(false) NOT VALID',
      );
      try {
        await expect(
          db.transaction((tx) =>
            tx.query('UPDATE users SET active=false WHERE id=$1', [
              user.user_id,
            ]),
          ),
        ).rejects.toThrow();
      } finally {
        await db.pool.query(
          'ALTER TABLE audit_events DROP CONSTRAINT audit_test_unavailable',
        );
      }
      expect(
        (
          await db.pool.query('SELECT active FROM users WHERE id=$1', [
            user.user_id,
          ])
        ).rows[0].active,
      ).toBe(true);
    });
  },
);
