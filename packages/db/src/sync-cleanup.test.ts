import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'bounded transactional synchronization retention',
  () => {
    let admin: Database, db: Database, owner: string, scopedUrl: string;
    const schema = `sync_cleanup_${randomUUID().replaceAll('-', '')}`;
    const workspaceId = (ordinal: number) =>
      `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
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
      await db.pool.query(`TRUNCATE workspaces,users CASCADE;
      INSERT INTO sync_cleanup_cursor VALUES(true,NULL)
      ON CONFLICT(singleton) DO UPDATE SET workspace_id=NULL`);
      owner = randomUUID();
      await db.pool.query(
        'INSERT INTO users(id,issuer,subject) VALUES($1::uuid,$2,$1::text)',
        [owner, 'urn:sync-cleanup:test'],
      );
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
    async function workspace(
      id: string = randomUUID(),
      seq = '0',
      floor = '0',
    ) {
      await db.pool.query(
        'INSERT INTO workspaces(id,name,sync_seq,sync_floor) VALUES($1,$2,$3,$4)',
        [id, 'Synthetic synchronization retention', seq, floor],
      );
      await db.pool.query(
        'INSERT INTO memberships(workspace_id,user_id) VALUES($1,$2)',
        [id, owner],
      );
      return id;
    }
    async function history(id: string, count: number) {
      await db.pool.query(
        `INSERT INTO sync_changes(workspace_id,seq,owner_id,document_id,kind,revision,transcript_revision,created_at)
       SELECT $1,n,$2,$3,'document',1,0,now()-interval '8 days' FROM generate_series(1,$4::int) n`,
        [id, owner, randomUUID(), count],
      );
      await db.pool.query('UPDATE workspaces SET sync_seq=$2 WHERE id=$1', [
        id,
        String(count),
      ]);
    }
    async function state(id: string) {
      return (
        await db.pool.query<{ sync_floor: string; remaining: number }>(
          `SELECT sync_floor,(SELECT count(*)::int FROM sync_changes WHERE workspace_id=$1) remaining
       FROM workspaces WHERE id=$1`,
          [id],
        )
      ).rows[0];
    }
    async function checkpoint() {
      return (
        await db.pool.query<{ workspace_id: string | null }>(
          'SELECT workspace_id FROM sync_cleanup_cursor WHERE singleton',
        )
      ).rows[0]?.workspace_id;
    }
    // Other isolated-schema suites share the database-wide housekeeping leader.
    const prune = () => db.transaction((tx) => db.sync.prune(tx));
    it('removes at most1000 changes per workspace visit and preserves exact reset cursors', async () => {
      const id = await workspace();
      const before = await db.sync.snapshot(owner, id);
      await history(id, 1005);
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '1000', remaining: 5 });
      await expect(
        db.sync.changes(owner, id, before.cursor),
      ).rejects.toMatchObject({
        code: 'sync_cursor_expired',
        status: 410,
        details: { reset_required: true },
      });
      const current = await db.sync.snapshot(owner, id);
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '1005', remaining: 0 });
      expect(await db.sync.changes(owner, id, current.cursor)).toMatchObject({
        changes: [],
      });
    });
    it('visits at most100 workspaces, advances past them and wraps to newly inserted lower UUIDs', async () => {
      for (let ordinal = 1; ordinal <= 101; ordinal++) {
        const id = await workspace(workspaceId(ordinal));
        await history(id, 1);
      }
      await prune();
      expect(await checkpoint()).toBe(workspaceId(100));
      expect(
        (
          await db.pool.query(
            'SELECT count(*)::int count FROM workspaces WHERE sync_floor=1',
          )
        ).rows[0].count,
      ).toBe(100);
      const lower = await workspace(workspaceId(0));
      await history(lower, 1);
      const restarted = new Database(scopedUrl);
      try {
        await restarted.transaction((tx) => restarted.sync.prune(tx));
      } finally {
        await restarted.close();
      }
      expect(await checkpoint()).toBe(workspaceId(98));
      expect(await state(workspaceId(101))).toEqual({
        sync_floor: '1',
        remaining: 0,
      });
      expect(await state(lower)).toEqual({ sync_floor: '1', remaining: 0 });
    });
    it('skips an actually locked workspace without blocking unrelated retention and revisits it later', async () => {
      const first = await workspace(workspaceId(1)),
        second = await workspace(workspaceId(2));
      await history(first, 2);
      await history(second, 2);
      const lock = await db.pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
          first,
        ]);
        await db.transaction(async (tx) => {
          await tx.query("SET LOCAL statement_timeout='500ms'");
          await db.sync.prune(tx);
        });
        expect(await state(first)).toEqual({ sync_floor: '0', remaining: 2 });
        expect(await state(second)).toEqual({ sync_floor: '2', remaining: 0 });
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
      await prune();
      expect(await state(first)).toEqual({ sync_floor: '2', remaining: 0 });
    });
    it('rolls back the shared cursor, logical floors and physical deletion together', async () => {
      const id = await workspace();
      await history(id, 3);
      const failure = new Error('Synthetic transaction rollback');
      await expect(
        db.transaction(async (tx) => {
          await db.sync.prune(tx);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await state(id)).toEqual({ sync_floor: '0', remaining: 3 });
      expect(await checkpoint()).toBeNull();
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '3', remaining: 0 });
      expect(await checkpoint()).toBe(id);
    });
    it('never advances a floor past the first retained change, even when a later change has an old timestamp', async () => {
      const id = await workspace();
      await history(id, 4);
      await db.pool.query(
        'UPDATE sync_changes SET created_at=now() WHERE workspace_id=$1 AND seq IN (2,4)',
        [id],
      );
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '1', remaining: 3 });
      await db.pool.query(
        "UPDATE sync_changes SET created_at=now()-interval '8 days' WHERE workspace_id=$1 AND seq=2",
        [id],
      );
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '3', remaining: 1 });
    });
    it('retains the exact seven-day boundary using the transaction clock', async () => {
      const id = await workspace(undefined, '2');
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO sync_changes(workspace_id,seq,owner_id,document_id,kind,revision,transcript_revision,created_at)
         VALUES($1,1,$2,$3,'document',1,0,now()-interval '7 days 1 millisecond'),
               ($1,2,$2,$3,'document',1,0,now()-interval '7 days')`,
          [id, owner, randomUUID()],
        );
        await db.sync.prune(tx);
      });
      expect(await state(id)).toEqual({ sync_floor: '1', remaining: 1 });
    });
    it('does not delete more than one batch when the previously recorded floor is already ahead of physical history', async () => {
      const id = await workspace();
      await history(id, 1005);
      await db.pool.query(
        'UPDATE workspaces SET sync_floor=sync_seq WHERE id=$1',
        [id],
      );
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '1005', remaining: 5 });
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '1005', remaining: 0 });
    });
    it('deletes only the selected batch when older metadata appears after the head was read', async () => {
      const id = await workspace(undefined, '2000');
      await db.pool.query(
        `INSERT INTO sync_changes(workspace_id,seq,owner_id,document_id,kind,revision,transcript_revision,created_at)
         SELECT $1,n,$2,$3,'document',1,0,now()-interval '8 days'
         FROM generate_series(2,2000,2) n`,
        [id, owner, randomUUID()],
      );
      await db.pool
        .query(`CREATE FUNCTION insert_during_sync_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO sync_changes(workspace_id,seq,owner_id,document_id,kind,revision,transcript_revision,created_at)
          SELECT NEW.id,n,m.user_id,NEW.id,'document',1,0,now()-interval '8 days'
          FROM generate_series(1,1999,2) n JOIN memberships m ON m.workspace_id=NEW.id;
          RETURN NEW;
        END;
      $$;
      CREATE TRIGGER insert_during_sync_cleanup AFTER UPDATE OF sync_floor ON workspaces
      FOR EACH ROW WHEN(OLD.sync_floor=0 AND NEW.sync_floor>0) EXECUTE FUNCTION insert_during_sync_cleanup()`);
      try {
        await prune();
        expect(await state(id)).toEqual({
          sync_floor: '2000',
          remaining: 1000,
        });
        await prune();
        expect(await state(id)).toEqual({ sync_floor: '2000', remaining: 0 });
      } finally {
        await db.pool
          .query(`DROP TRIGGER insert_during_sync_cleanup ON workspaces;
          DROP FUNCTION insert_during_sync_cleanup()`);
      }
    });
    it('keeps bigint sequence arithmetic exact beyond the JavaScript safe-integer range', async () => {
      const id = await workspace(undefined, '9007199254740000');
      const before = await db.sync.snapshot(owner, id);
      await db.pool.query('UPDATE workspaces SET sync_seq=$2 WHERE id=$1', [
        id,
        '9007199254741005',
      ]);
      await db.pool.query(
        `INSERT INTO sync_changes(workspace_id,seq,owner_id,document_id,kind,revision,transcript_revision,created_at)
       VALUES($1,9007199254740992,$2,$3,'document',1,0,now()-interval '8 days'),
             ($1,9007199254740993,$2,$3,'document',1,0,now())`,
        [id, owner, randomUUID()],
      );
      await prune();
      expect(await state(id)).toEqual({
        sync_floor: '9007199254740992',
        remaining: 1,
      });
      await expect(
        db.sync.changes(owner, id, before.cursor),
      ).rejects.toMatchObject({ code: 'sync_cursor_expired' });
    });
    it('wraps a durable cursor whose original workspace no longer exists', async () => {
      const id = await workspace(workspaceId(1));
      await history(id, 1);
      await db.pool.query(
        'UPDATE sync_cleanup_cursor SET workspace_id=$1 WHERE singleton',
        [workspaceId(999)],
      );
      await prune();
      expect(await state(id)).toEqual({ sync_floor: '1', remaining: 0 });
    });
    it('fails explicitly when cleanup state is missing instead of silently restarting or claiming completion', async () => {
      await db.pool.query('DELETE FROM sync_cleanup_cursor');
      await expect(prune()).rejects.toThrow(
        'synchronization cleanup cursor is missing',
      );
    });
  },
);
