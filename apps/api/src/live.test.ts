import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
import {
  Database,
  LIVE_MEDIA_MS,
  type LiveStart,
  type LiveClaim,
} from '@windows-ai-notes/db';
import { DEFAULT_AI_LIMITS } from '@windows-ai-notes/contracts/server';
import { makeSilentWav } from '@windows-ai-notes/ai/wav';

const url = process.env.TEST_DATABASE_URL;
const source = () => ({
  recording_id: randomUUID(),
  preview_id: randomUUID(),
  track_id: randomUUID(),
  capture_epoch: randomUUID(),
});
const start = (): LiveStart => ({
  source: source(),
  locale: 'en-US',
  provider: 'fixture',
  configurationVersion: 'live-fixture-v1',
  consent: true,
});
const usage = (audio_ms: number) => ({
  audio_ms,
  input_tokens: 0,
  output_tokens: 0,
});
describe.skipIf(!url)(
  'durable live source authorization and shared AI accounting',
  () => {
    const schema = `notes_live_${randomUUID().replaceAll('-', '')}`;
    let admin: Database;
    let db: Database;
    let scoped: string;
    let actor: { user_id: string; workspace_id: string };
    let subject: string;
    let document: string;
    beforeAll(async () => {
      admin = new Database(url!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const target = new URL(url!);
      target.searchParams.set('options', `-c search_path=${schema}`);
      scoped = target.href;
      db = new Database(scoped);
      await db.migrate();
      await db.assertReady();
    });
    beforeEach(async () => {
      subject = randomUUID();
      actor = await db.provision('urn:live-fixture', subject);
      document = (
        await db.createDocument(
          actor.user_id,
          {
            workspace_id: actor.workspace_id,
            title: 'Synthetic live source',
            notes: 'Known evidence.',
          },
          randomUUID(),
        )
      ).id;
    });
    afterEach(async () => {
      await db.pool.query(
        "UPDATE jobs SET state='cancelled',lease_token=lease_token+1,lease_until=NULL WHERE state IN ('queued','running','retry_wait')",
      );
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    const open = (
      input = start(),
      key = randomUUID(),
      expires = Date.now() + 300_000,
      doc = document,
    ) => db.live.open(actor.user_id, doc, input, key, expires);
    const snapshot = () => db.usage.snapshot(actor.user_id);
    async function dispatched(input = start()) {
      const claim = await open(input);
      const call = await db.usage.startLive(claim);
      return { claim, call, input };
    }

    it('binds metadata without requiring or implicitly authorizing a remote audio upload', async () => {
      const input = start();
      const claim = await open(input);
      expect(claim).toMatchObject({
        ownerId: actor.user_id,
        documentId: document,
        source: input.source,
      });
      expect(
        (
          await db.pool.query('SELECT id FROM recordings WHERE owner_id=$1', [
            actor.user_id,
          ])
        ).rows,
      ).toEqual([]);
      expect(await snapshot()).toMatchObject({ uncertain_requests: '0' });
      await expect(
        db.live.accept(claim, {
          sequence: 7,
          sample_start: 16_000,
          frame_count: 1,
        }),
      ).rejects.toMatchObject({ code: 'live_not_reserved' });
      await db.usage.startLive(claim);
      expect(await snapshot()).toMatchObject({
        uncertain: { audio_ms: String(LIVE_MEDIA_MS) },
        uncertain_requests: '1',
      });
      const stored = (
        await db.pool.query(
          'SELECT request_kind,job_id,lease_token,live_lease_id FROM ai_usage_calls WHERE live_lease_id=$1',
          [claim.id],
        )
      ).rows[0];
      expect(stored).toEqual({
        request_kind: 'live',
        job_id: null,
        lease_token: null,
        live_lease_id: claim.id,
      });
    });
    it('requires explicit live consent, valid source identity and a current access expiry before creating metadata', async () => {
      // @ts-expect-error JavaScript callers can submit an invalid consent value.
      await expect(open({ ...start(), consent: false })).rejects.toMatchObject({
        code: 'invalid_live_request',
      });
      await expect(
        open({ ...start(), source: { ...source(), preview_id: 'invalid' } }),
      ).rejects.toMatchObject({ code: 'invalid_live_request' });
      await expect(
        open(start(), randomUUID(), Date.now() - 1),
      ).rejects.toMatchObject({ code: 'live_auth_expired' });
      expect(
        (
          await db.pool.query('SELECT id FROM live_sources WHERE owner_id=$1', [
            actor.user_id,
          ])
        ).rowCount,
      ).toBe(0);
    });
    it('deduplicates concurrent identical opens without extending the original token expiry or changing source scope', async () => {
      const input = start();
      const key = randomUUID();
      const expiry = Date.now() + 120_000;
      const leases = await Promise.all([
        open(input, key, expiry),
        open(input, key, expiry + 60_000),
      ]);
      expect(leases[0]).toEqual(leases[1]);
      const row = (
        await db.pool.query<{ access_expires_at: Date }>(
          'SELECT access_expires_at FROM live_leases WHERE owner_id=$1',
          [actor.user_id],
        )
      ).rows[0]!;
      expect([expiry, expiry + 60_000]).toContain(
        row.access_expires_at.getTime(),
      );
      const original = row.access_expires_at.getTime();
      await open(input, key, expiry + 120_000);
      expect(
        (
          await db.pool.query<{ access_expires_at: Date }>(
            'SELECT access_expires_at FROM live_leases WHERE id=$1',
            [leases[0]!.id],
          )
        ).rows[0]!.access_expires_at.getTime(),
      ).toBe(original);
      await expect(
        open({ ...input, locale: 'zh-CN' }, key),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await db.live.close(leases[0]!);
      await expect(open(input, key)).rejects.toMatchObject({
        code: 'live_lease_lost',
      });
    });
    it('rejects another owner, forged lease token and every changed native source field before reservation', async () => {
      const { claim } = await dispatched();
      const other = await db.provision(
        'urn:live-fixture',
        randomUUID(),
        actor.workspace_id,
      );
      await expect(
        db.live.open(
          other.user_id,
          document,
          start(),
          randomUUID(),
          Date.now() + 60_000,
        ),
      ).rejects.toMatchObject({ code: 'document_not_found' });
      for (const key of [
        'recording_id',
        'preview_id',
        'track_id',
        'capture_epoch',
      ] as const) {
        await expect(
          db.usage.startLive({
            ...claim,
            source: { ...claim.source, [key]: randomUUID() },
          }),
        ).rejects.toMatchObject({ code: 'live_lease_lost' });
      }
      for (const changed of [
        { ...claim, leaseToken: randomUUID() },
        { ...claim, id: randomUUID() },
        { ...claim, ownerId: other.user_id },
      ])
        await expect(db.usage.startLive(changed)).rejects.toHaveProperty(
          'code',
        );
      expect(
        await db.live.close({ ...claim, leaseToken: randomUUID() }),
      ).toEqual({ state: 'unavailable' });
      await expect(db.live.authorize(claim)).resolves.toMatchObject({
        id: claim.id,
      });
      expect((await snapshot()).uncertain_requests).toBe('1');
    });
    it('keeps a source bound to one document and permits only one active attempt for it', async () => {
      const input = start();
      const first = await open(input);
      await expect(open(input)).rejects.toMatchObject({
        code: 'live_source_busy',
      });
      await db.live.close(first);
      const other = await db.createDocument(
        actor.user_id,
        { workspace_id: actor.workspace_id, title: 'Other document' },
        randomUUID(),
      );
      for (const source of [
        input.source,
        { ...input.source, track_id: randomUUID() },
        { ...input.source, preview_id: randomUUID() },
        { ...input.source, capture_epoch: randomUUID() },
      ])
        await expect(
          open(
            { ...input, source },
            randomUUID(),
            Date.now() + 60_000,
            other.id,
          ),
        ).rejects.toMatchObject({ code: 'live_source_conflict' });
      const forged: LiveClaim = { ...first, documentId: other.id };
      await expect(db.usage.startLive(forged)).rejects.toMatchObject({
        code: 'live_lease_lost',
      });
    });
    it('serializes owner-wide opens at two sources, without confusing membership epochs across workspaces', async () => {
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
        [actor.workspace_id, actor.user_id],
      );
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',
        [actor.workspace_id, actor.user_id],
      );
      const first = await open();
      const extra = await db.provision('urn:live-fixture', subject);
      const extraDoc = await db.createDocument(
        actor.user_id,
        { workspace_id: extra.workspace_id, title: 'Other workspace' },
        randomUUID(),
      );
      const second = await open(
        start(),
        randomUUID(),
        Date.now() + 60_000,
        extraDoc.id,
      );
      await expect(db.live.authorize(first)).resolves.toMatchObject({
        id: first.id,
      });
      await expect(open()).rejects.toMatchObject({ code: 'live_sources_busy' });
      await db.live.close(second);
      await db.live.close(first);
      const decisions = await Promise.allSettled([
        open(),
        open(),
        open(),
        open(),
      ]);
      expect(
        decisions.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(2);
      expect(
        decisions.filter((result) => result.status === 'rejected'),
      ).toHaveLength(2);
    });
    it('reserves the fixed full minute once and refuses concurrent duplicate provider dispatch', async () => {
      const claim = await open();
      const overridden = { ...claim, budget: usage(1) };
      await expect(db.usage.startLive(overridden)).rejects.toMatchObject({
        code: 'invalid_live_request',
      });
      const decisions = await Promise.allSettled([
        db.usage.startLive(claim),
        db.usage.startLive(claim),
      ]);
      expect(
        decisions.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        decisions.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'provider_request_already_started' } });
      expect((await snapshot()).uncertain.audio_ms).toBe('60000');
    });
    it('does not create any call when the full conservative live budget is unavailable', async () => {
      await db.usage.setLimits(actor.user_id, {
        ...DEFAULT_AI_LIMITS,
        audio_ms: LIVE_MEDIA_MS - 1,
      });
      const claim = await open();
      await expect(db.usage.startLive(claim)).rejects.toMatchObject({
        code: 'quota_exceeded',
      });
      await expect(
        db.live.accept(claim, { sequence: 0, sample_start: 0, frame_count: 1 }),
      ).rejects.toMatchObject({ code: 'live_not_reserved' });
      expect(await snapshot()).toMatchObject({
        uncertain_requests: '0',
        uncertain: { audio_ms: '0' },
      });
    });
    it('shares atomic account allowances with real batch transcription jobs and preserves job lease guards', async () => {
      const claim = await open();
      const queued = await db.enqueueTranscription(
        actor.user_id,
        document,
        0,
        'en-US',
        1000,
        makeSilentWav(),
        randomUUID(),
      );
      const job = await db.claim();
      if (!job || job.id !== queued.id)
        throw new Error('Expected a claimed synthetic batch job.');
      const reservation = {
        operation: 'speech',
        provider: 'fixture' as const,
        configurationVersion: 'batch-fixture-v1',
        budget: usage(60_000),
      };
      await db.usage.setLimits(actor.user_id, {
        ...DEFAULT_AI_LIMITS,
        audio_ms: LIVE_MEDIA_MS,
      });
      const decisions = await Promise.allSettled([
        db.usage.startLive(claim),
        db.usage.start(job, reservation),
      ]);
      expect(
        decisions.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        decisions.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'quota_exceeded' } });
      await expect(
        db.usage.start({ ...job, id: claim.id }, reservation),
      ).rejects.toMatchObject({ code: 'job_lease_lost' });
      expect((await snapshot()).uncertain_requests).toBe('1');
    });
    it('durably advances exact preview-local sample/sequence cursors before forwarding, rejects replays and reports reconnect gaps', async () => {
      const first = await dispatched();
      expect(
        await db.live.accept(first.claim, {
          sequence: 7,
          sample_start: 16_000,
          frame_count: 2,
        }),
      ).toEqual({ accepted_samples: 1600, gap: null });
      for (const cursor of [
        { sequence: 7, sample_start: 16_000, frame_count: 2 },
        { sequence: 10, sample_start: 17_600, frame_count: 1 },
        { sequence: 10, sample_start: 18_400, frame_count: 1 },
      ])
        await expect(db.live.accept(first.claim, cursor)).rejects.toMatchObject(
          { code: 'live_frame_discontinuity' },
        );
      await db.live.close(first.claim, 'failed');
      const second = await dispatched(first.input);
      await expect(
        db.live.accept(second.claim, {
          sequence: 7,
          sample_start: 16_000,
          frame_count: 1,
        }),
      ).rejects.toMatchObject({ code: 'live_frame_discontinuity' });
      expect(
        await db.live.accept(second.claim, {
          sequence: 12,
          sample_start: 20_000,
          frame_count: 1,
        }),
      ).toEqual({
        accepted_samples: 800,
        gap: { sample_start: 17_600, sample_end: 20_000 },
      });
      const replacement = new Database(scoped);
      try {
        expect(
          await replacement.live.accept(second.claim, {
            sequence: 13,
            sample_start: 20_800,
            frame_count: 1,
          }),
        ).toEqual({ accepted_samples: 1600, gap: null });
      } finally {
        await replacement.close();
      }
      expect((await snapshot()).uncertain.audio_ms).toBe('120000');
    });
    it('bounds cursor metadata and media units to the reserved minute without advancing on invalid input', async () => {
      const { claim, call } = await dispatched();
      await expect(
        db.live.accept(claim, {
          sequence: 0,
          sample_start: 0,
          frame_count: 11,
        }),
      ).rejects.toMatchObject({ code: 'invalid_live_request' });
      for (let sequence = 0; sequence < 1200; sequence += 10)
        await db.live.accept(claim, {
          sequence,
          sample_start: sequence * 800,
          frame_count: 10,
        });
      await expect(
        db.live.accept(claim, {
          sequence: 1200,
          sample_start: 960_000,
          frame_count: 1,
        }),
      ).rejects.toMatchObject({ code: 'live_media_limit' });
      await db.usage.settle(call, usage(60_000));
      expect(await snapshot()).toMatchObject({
        settled: { audio_ms: '60000' },
        uncertain_requests: '0',
      });
      await expect(
        db.live.accept(claim, {
          sequence: 1200,
          sample_start: 960_000,
          frame_count: 1,
        }),
      ).rejects.toMatchObject({ code: 'live_lease_lost' });
    }, 15_000);
    it.each(['lease', 'token', 'wall'] as const)(
      'fences an expired %s and retains uncertain usage on replacement',
      async (kind) => {
        const first = await dispatched();
        const statement =
          kind === 'token'
            ? "access_expires_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '2 seconds'"
            : kind === 'wall'
              ? "deadline=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '2 seconds'"
              : "lease_until=clock_timestamp()-interval '1 second'";
        await db.pool.query(`UPDATE live_leases SET ${statement} WHERE id=$1`, [
          first.claim.id,
        ]);
        await expect(db.live.authorize(first.claim)).rejects.toMatchObject({
          code: 'live_lease_lost',
        });
        await expect(db.usage.startLive(first.claim)).rejects.toMatchObject({
          code: 'live_lease_lost',
        });
        await dispatched(first.input);
        expect((await snapshot()).uncertain.audio_ms).toBe('120000');
      },
    );
    it('rechecks actual expiry after a blocked lease lock rather than using a stale transaction snapshot', async () => {
      const { claim } = await dispatched();
      await db.pool.query(
        "UPDATE live_leases SET lease_until=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",
        [claim.id],
      );
      const holder = await db.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT id FROM live_leases WHERE id=$1 FOR UPDATE',
          [claim.id],
        );
        const blocked = expect(db.live.authorize(claim)).rejects.toMatchObject({
          code: 'live_lease_lost',
        });
        await delay(300);
        await holder.query('COMMIT');
        await blocked;
      } finally {
        holder.release();
      }
    });
    it.each(['membership', 'user'] as const)(
      'does not revive an old live lease after %s revocation and restoration',
      async (kind) => {
        const { claim, call } = await dispatched();
        const deactivate =
          kind === 'user'
            ? 'UPDATE users SET active=false WHERE id=$1'
            : 'UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2';
        const reactivate = deactivate.replace('active=false', 'active=true');
        const values =
          kind === 'user'
            ? [actor.user_id]
            : [actor.user_id, actor.workspace_id];
        await db.pool.query(deactivate, values);
        await expect(db.live.authorize(claim)).rejects.toMatchObject({
          code: 'document_not_found',
        });
        await db.pool.query(reactivate, values);
        await expect(db.live.authorize(claim)).rejects.toMatchObject({
          code: 'live_lease_lost',
        });
        await expect(db.usage.startLive(claim)).rejects.toMatchObject({
          code: 'live_lease_lost',
        });
        await db.usage.settle(call, usage(150));
        expect((await snapshot()).settled.audio_ms).toBe('150');
      },
    );
    it.each(['cancel', 'delete'] as const)(
      'accepts a late known receipt after %s, closes media acceptance and settles idempotently',
      async (action) => {
        const { claim, call } = await dispatched();
        await db.live.accept(claim, {
          sequence: 0,
          sample_start: 0,
          frame_count: 4,
        });
        if (action === 'cancel')
          expect(await db.live.close(claim)).toEqual({ state: 'closed' });
        else await db.deleteDocument(actor.user_id, document);
        expect((await snapshot()).uncertain.audio_ms).toBe('60000');
        await Promise.all([
          db.usage.settle(call, usage(200)),
          db.usage.settle(call, usage(200)),
        ]);
        expect(await snapshot()).toMatchObject({
          settled: { audio_ms: '200' },
          settled_requests: '1',
          uncertain_requests: '0',
        });
        await expect(
          db.live.accept(claim, {
            sequence: 4,
            sample_start: 3200,
            frame_count: 1,
          }),
        ).rejects.toHaveProperty('code');
        await expect(db.usage.settle(call, usage(201))).rejects.toMatchObject({
          code: 'usage_settlement_conflict',
        });
        if (action === 'delete') {
          expect(
            (
              await db.pool.query(
                'SELECT live_lease_id,request_kind FROM ai_usage_calls WHERE id=$1',
                [call],
              )
            ).rows[0],
          ).toEqual({ live_lease_id: null, request_kind: 'live' });
          expect(await db.live.close(claim)).toEqual({ state: 'unavailable' });
        }
      },
    );
    it('retains ledger holds and late settlement in the original UTC month after metadata pruning', async () => {
      const { claim, call } = await dispatched();
      await db.live.close(claim, 'failed');
      await db.pool.query(
        "UPDATE ai_usage_periods SET period_start=(period_start-interval '1 month')::date WHERE owner_id=$1",
        [actor.user_id],
      );
      await db.pool.query(
        "UPDATE live_leases SET created_at=created_at-interval '8 days',deadline=deadline-interval '8 days',lease_until=lease_until-interval '8 days' WHERE id=$1",
        [claim.id],
      );
      await db.pool.query(
        "UPDATE live_sources SET updated_at=updated_at-interval '8 days' WHERE owner_id=$1",
        [actor.user_id],
      );
      await vi.waitFor(
        async () => {
          await db.cleanup();
          expect(
            (
              await db.pool.query('SELECT id FROM live_leases WHERE id=$1', [
                claim.id,
              ])
            ).rowCount,
          ).toBe(0);
        },
        { timeout: 5000, interval: 25 },
      );
      const stored = (
        await db.pool.query(
          'SELECT live_lease_id,actual FROM ai_usage_calls WHERE id=$1',
          [call],
        )
      ).rows[0];
      expect(stored).toEqual({ live_lease_id: null, actual: null });
      await db.usage.settle(call, usage(100));
      expect(await snapshot()).toMatchObject({
        settled: { audio_ms: '0' },
        uncertain_requests: '0',
      });
      expect(
        (
          await db.pool.query(
            'SELECT settled FROM ai_usage_periods WHERE owner_id=$1 ORDER BY period_start',
            [actor.user_id],
          )
        ).rows[0].settled.audio_ms,
      ).toBe('100');
    });
    it('bounds zero-media open/close churn without charging a provider reservation', async () => {
      for (let attempt = 0; attempt < 12; attempt++)
        await db.live.close(await open());
      await expect(open()).rejects.toMatchObject({ code: 'live_rate_limited' });
      expect((await snapshot()).uncertain_requests).toBe('0');
    });
    it('limits retained source metadata independently of uploads or token allowances', async () => {
      await db.pool.query(
        `INSERT INTO live_sources(id,owner_id,document_id,workspace_id,recording_id,preview_id,track_id,capture_epoch)
      SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()
      FROM generate_series(1,5000)`,
        [actor.user_id, document, actor.workspace_id],
      );
      await expect(open()).rejects.toMatchObject({ code: 'live_source_limit' });
      expect((await snapshot()).uncertain_requests).toBe('0');
    });
    it('upgrades an existing six-migration accounting database without losing its job reservations', async () => {
      const legacySchema = `live_upgrade_${randomUUID().replaceAll('-', '')}`;
      await admin.pool.query(`CREATE SCHEMA "${legacySchema}"`);
      const target = new URL(url!);
      target.searchParams.set('options', `-c search_path=${legacySchema}`);
      const legacy = new Database(target.href);
      try {
        await legacy.pool.query(
          'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL)',
        );
        const files = [
          '001_initial.sql',
          '002_editing_sync.sql',
          '003_recordings.sql',
          '004_transcript_pages.sql',
          '005_recording_transcription.sql',
          '006_ai_usage.sql',
        ];
        for (const [index, file] of files.entries()) {
          const sql = await readFile(
            new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
            'utf8',
          );
          await legacy.pool.query(sql);
          await legacy.pool.query(
            'INSERT INTO schema_migrations VALUES ($1,$2)',
            [index + 1, createHash('sha256').update(sql).digest('hex')],
          );
        }
        const user = await legacy.provision(
          'urn:upgrade-fixture',
          randomUUID(),
        );
        const call = randomUUID();
        await legacy.pool.query(
          'INSERT INTO ai_usage_accounts VALUES ($1,$2)',
          [user.user_id, JSON.stringify(DEFAULT_AI_LIMITS)],
        );
        const zero = { audio_ms: '0', input_tokens: '0', output_tokens: '0' };
        await legacy.pool.query(
          `INSERT INTO ai_usage_periods(owner_id,period_start,settled,uncertain,uncertain_requests)
        VALUES ($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$2,$3,1)`,
          [
            user.user_id,
            JSON.stringify(zero),
            JSON.stringify({ ...zero, audio_ms: '1000' }),
          ],
        );
        await legacy.pool.query(
          `INSERT INTO ai_usage_calls(id,owner_id,period_start,lease_token,operation,provider,configuration_version,reserved)
        SELECT $1,$2,period_start,1,'speech','fixture','legacy-v1',$3 FROM ai_usage_periods WHERE owner_id=$2`,
          [call, user.user_id, JSON.stringify({ ...zero, audio_ms: '1000' })],
        );
        await legacy.migrate();
        await legacy.assertReady();
        expect(
          (
            await legacy.pool.query(
              'SELECT request_kind,lease_token,live_lease_id FROM ai_usage_calls WHERE id=$1',
              [call],
            )
          ).rows[0],
        ).toEqual({
          request_kind: 'job',
          lease_token: '1',
          live_lease_id: null,
        });
        await legacy.usage.settle(call, usage(1000));
        expect(await legacy.usage.snapshot(user.user_id)).toMatchObject({
          settled: { audio_ms: '1000' },
          uncertain_requests: '0',
        });
      } finally {
        await legacy.close();
        await admin.pool.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
      }
    });
  },
);
