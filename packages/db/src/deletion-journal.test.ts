import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './index.js';
import { deletionIntentSchema } from '@windows-ai-notes/contracts/deletion';

const url = process.env.TEST_DATABASE_URL;
const privateText = 'private-deletion-recovery-meeting-and-identity';
interface Intent {
  id: string;
  transaction_id: string;
  recorded_at: Date;
  event: string;
  resource_id: string;
  workspace_id: string | null;
  expires_at: Date | null;
  retention_days: number | null;
  processing_days: number | null;
  reason: string | null;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(db: Database) {
  const owner = await db.provision(privateText, randomUUID());
  const document = await db.createDocument(
    owner.user_id,
    {
      workspace_id: owner.workspace_id,
      title: privateText,
      notes: privateText,
    },
    randomUUID(),
  );
  return { owner, document };
}
async function recording(db: Database, source: Fixture) {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
    VALUES($1::uuid,$2,$3,$4,now(),'[]',$1::text,$5)`,
    [
      id,
      source.document.id,
      source.owner.workspace_id,
      source.owner.user_id,
      privateText,
    ],
  );
  return id;
}
async function object(
  db: Database,
  source: string,
  kind: 'staging' | 'verified' = 'staging',
) {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,protected_until,cleanup_after,request_key)
    VALUES($1,$2,$3,$4,now()-interval '1 hour',now()-interval '1 hour',$5)`,
    [id, source, randomUUID(), kind, privateText],
  );
  return id;
}
async function conversation(db: Database, source: Fixture) {
  const thread = randomUUID(),
    turn = randomUUID();
  await db.pool.query(
    'INSERT INTO chat_threads(id,document_id,owner_id,title,last_position) VALUES($1,$2,$3,$4,1)',
    [thread, source.document.id, source.owner.user_id, privateText],
  );
  await db.pool.query(
    `INSERT INTO chat_turns(id,thread_id,document_id,owner_id,position,idempotency_key,request_hash,request,evidence_hash,mode)
    VALUES($1::uuid,$2,$3,$4,1,$1::text,$5,$6,$5,'full')`,
    [
      turn,
      thread,
      source.document.id,
      source.owner.user_id,
      'a'.repeat(64),
      JSON.stringify({ question: privateText }),
    ],
  );
  return { thread, turn };
}
async function clip(db: Database, source: Fixture) {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO jobs(id,document_id,workspace_id,owner_id,kind,idempotency_key,request_hash,input,audio)
    VALUES($1::uuid,$2,$3,$4,'transcription',$1::text,$5,$6,$7)`,
    [
      id,
      source.document.id,
      source.owner.workspace_id,
      source.owner.user_id,
      privateText,
      JSON.stringify({
        kind: 'transcription',
        locale: 'en-US',
        base_transcript_revision: 0,
        duration_ms: 1,
      }),
      Buffer.from(privateText),
    ],
  );
  return id;
}

describe.skipIf(!url)('transactional deletion recovery intent capture', () => {
  const schema = `deletion_journal_${randomUUID().replaceAll('-', '')}`;
  let admin: Database, db: Database;
  function scoped(name: string) {
    const value = new URL(url!);
    value.searchParams.set('options', `-c search_path=${name}`);
    return new Database(value.href);
  }
  beforeAll(async () => {
    admin = new Database(url!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    db = scoped(schema);
    await db.migrate();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE users,workspaces,audit_events CASCADE');
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  });
  async function intents(ids: string[], source = db) {
    const rows = (
      await source.pool.query<Intent>(
        `SELECT id,transaction_id::text,recorded_at,event,resource_id,workspace_id,
      expires_at,retention_days,processing_days,reason FROM deletion_journal WHERE resource_id=ANY($1::uuid[])
      ORDER BY recorded_at,id`,
        [ids],
      )
    ).rows;
    for (const row of rows) {
      const encoded = {
        ...row,
        recorded_at: row.recorded_at.toISOString(),
        expires_at: row.expires_at?.toISOString() ?? null,
      };
      expect(deletionIntentSchema.parse(encoded)).toEqual(encoded);
    }
    return rows;
  }

  it('captures document/audio/chat cascades and staged-audio removal in the source deletion transaction without retaining content', async () => {
    const source = await fixture(db),
      audio = await recording(db, source);
    const chat = await conversation(db, source),
      job = await clip(db, source);
    await db.deleteDocument(source.owner.user_id, source.document.id);
    const rows = (
      await intents([source.document.id, audio, chat.thread, chat.turn, job])
    ).filter((row) => row.event !== 'recording_expiry_bound');
    expect(rows.map((row) => row.event).sort()).toEqual([
      'chat_thread_erased',
      'chat_turn_erased',
      'document_erased',
      'job_audio_erased',
      'recording_erased',
    ]);
    expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(1);
    expect(rows.find((row) => row.event === 'recording_erased')).toMatchObject({
      reason: 'document',
    });
    expect(JSON.stringify(rows)).not.toContain(privateText);
    expect(JSON.stringify(rows)).not.toContain(source.owner.user_id);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'event',
      'expires_at',
      'id',
      'processing_days',
      'reason',
      'recorded_at',
      'resource_id',
      'retention_days',
      'transaction_id',
      'workspace_id',
    ]);
    await expect(
      db.document(source.owner.user_id, source.document.id),
    ).rejects.toThrow();
  });

  it('records separately erased audio without removing the retained notes', async () => {
    const source = await fixture(db),
      audio = await recording(db, source);
    await db.recordings.remove(source.owner.user_id, audio);
    await db.recordings.remove(source.owner.user_id, audio);
    expect((await intents([audio])).map((row) => row.event).sort()).toEqual([
      'recording_erased',
      'recording_expiry_bound',
    ]);
    expect(
      (await intents([audio])).find((row) => row.event === 'recording_erased'),
    ).toMatchObject({ reason: 'user' });
    expect(
      (await db.document(source.owner.user_id, source.document.id)).notes,
    ).toBe(privateText);
  });

  it('captures tombstones created before the recording is registered', async () => {
    const source = await fixture(db),
      audio = randomUUID();
    await db.recordings.removeExpected(
      source.owner.user_id,
      source.document.id,
      audio,
    );
    await db.recordings.removeExpected(
      source.owner.user_id,
      source.document.id,
      audio,
    );
    expect(await intents([audio])).toMatchObject([
      { event: 'recording_erased', reason: 'user' },
    ]);
    await expect(
      db.recordings.get(source.owner.user_id, audio),
    ).rejects.toThrow();
  });

  it('captures hard-deleted jobs, individual objects, recordings and unreferenced document rows', async () => {
    const source = await fixture(db),
      audio = await recording(db, source);
    const staging = await object(db, audio),
      verified = await object(db, audio, 'verified');
    const job = await clip(db, source),
      bareDocument = randomUUID();
    await db.pool.query(
      `INSERT INTO documents(id,workspace_id,owner_id,title,create_key,create_hash)
      VALUES($1::uuid,$2,$3,$4,$1::text,$4)`,
      [
        bareDocument,
        source.owner.workspace_id,
        source.owner.user_id,
        privateText,
      ],
    );
    await db.pool.query('DELETE FROM jobs WHERE id=$1', [job]);
    await db.pool.query('DELETE FROM recording_objects WHERE recording_id=$1', [
      audio,
    ]);
    await db.pool.query('DELETE FROM recordings WHERE id=$1', [audio]);
    await db.pool.query('DELETE FROM documents WHERE id=$1', [bareDocument]);
    expect(
      (await intents([job, audio, staging, verified, bareDocument]))
        .map((row) => row.event)
        .sort(),
    ).toEqual([
      'document_erased',
      'job_erased',
      'recording_erased',
      'recording_expiry_bound',
      'staging_object_erased',
      'verified_object_erased',
    ]);
    expect(
      (await intents([audio])).find((row) => row.event === 'recording_erased')
        ?.reason,
    ).toBeNull();
  });

  it('rolls back both permission changes and their intents on a failed transaction', async () => {
    const source = await fixture(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.query('UPDATE users SET active=false WHERE id=$1', [
          source.owner.user_id,
        ]);
        await tx.query('UPDATE memberships SET active=false WHERE user_id=$1', [
          source.owner.user_id,
        ]);
        expect(
          (
            await tx.query(
              'SELECT count(*)::int count FROM deletion_journal WHERE transaction_id=pg_current_xact_id()',
            )
          ).rows[0].count,
        ).toBe(2);
        throw new Error('synthetic-rollback');
      }),
    ).rejects.toThrow('synthetic-rollback');
    expect(await intents([source.owner.user_id])).toEqual([]);
    expect(
      (
        await db.pool.query('SELECT active FROM users WHERE id=$1', [
          source.owner.user_id,
        ])
      ).rows[0].active,
    ).toBe(true);
  });

  it('rejects the source deletion and rolls back earlier cascade intents when capture fails', async () => {
    const source = await fixture(db),
      audio = await recording(db, source);
    await db.pool
      .query(`CREATE FUNCTION reject_test_deletion_capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='document_erased' THEN RAISE EXCEPTION 'synthetic-capture-failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_test_deletion_capture BEFORE INSERT ON deletion_journal
      FOR EACH ROW EXECUTE FUNCTION reject_test_deletion_capture()`);
    try {
      await expect(
        db.deleteDocument(source.owner.user_id, source.document.id),
      ).rejects.toThrow('synthetic-capture-failure');
      expect(
        (await db.document(source.owner.user_id, source.document.id)).notes,
      ).toBe(privateText);
      expect(
        (
          await db.pool.query('SELECT deleted_at FROM recordings WHERE id=$1', [
            audio,
          ])
        ).rows[0].deleted_at,
      ).toBeNull();
      expect(
        (await intents([source.document.id, audio])).map((row) => row.event),
      ).toEqual(['recording_expiry_bound']);
    } finally {
      await db.pool.query(
        'DROP TRIGGER reject_test_deletion_capture ON deletion_journal; DROP FUNCTION reject_test_deletion_capture()',
      );
    }
  });

  it('captures object disposal before external deletion, protects retained/in-flight objects and avoids retry/recheck duplicates', async () => {
    const source = await fixture(db),
      audio = await recording(db, source);
    const staging = await object(db, audio),
      verified = await object(db, audio, 'verified');
    const protectedObject = await object(db, audio);
    await db.pool.query(
      "UPDATE recording_objects SET protected_until=now()+interval '1 hour' WHERE id=$1",
      [protectedObject],
    );
    const retained = await object(db, audio, 'verified');
    await db.pool.query(
      `INSERT INTO recording_chunks(id,recording_id,track_id,sequence,sample_start,sample_count,descriptor,request_key,request_hash,state,verified_object)
      VALUES($1::uuid,$2,$3,0,0,1,'{}',$1::text,$4,'verified',$5)`,
      [randomUUID(), audio, randomUUID(), privateText, retained],
    );
    const first = await db.recordings.claimCleanup();
    expect(first.map((row) => row.id).sort()).toEqual(
      [staging, verified].sort(),
    );
    expect(
      (await intents([staging, verified, protectedObject, retained]))
        .map((row) => row.event)
        .sort(),
    ).toEqual(['staging_object_erased', 'verified_object_erased']);
    expect(
      (
        await db.pool.query(
          'SELECT deleted_at FROM recording_objects WHERE id=ANY($1::uuid[])',
          [[staging, verified]],
        )
      ).rows,
    ).toEqual([{ deleted_at: null }, { deleted_at: null }]);
    for (const claimed of first)
      await db.recordings.finishCleanup(claimed, false);
    await db.pool.query(
      "UPDATE recording_objects SET cleanup_after=now()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [[staging, verified]],
    );
    for (const claimed of await db.recordings.claimCleanup())
      await db.recordings.finishCleanup(claimed, true);
    await db.pool.query(
      "UPDATE recording_objects SET cleanup_after=now()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [[staging, verified]],
    );
    expect(await db.recordings.claimCleanup()).toHaveLength(2);
    expect(
      await intents([staging, verified, protectedObject, retained]),
    ).toHaveLength(2);
  });

  it('preserves initial and shortened recording deadlines and workspace policy restrictions without treating later relaxation as erasure', async () => {
    const source = await fixture(db),
      audio = await recording(db, source);
    await db.recordings.setRetentionPolicy(source.owner.workspace_id, {
      retention_days: 1,
      processing_days: 2,
    });
    const rows = await intents([audio, source.owner.workspace_id]);
    const cutoff = (
      await db.pool.query(
        'SELECT retention_expires_at FROM recordings WHERE id=$1',
        [audio],
      )
    ).rows[0].retention_expires_at;
    expect(
      rows.filter((row) => row.event === 'recording_expiry_bound'),
    ).toHaveLength(2);
    expect(
      rows.find((row) => row.expires_at?.getTime() === cutoff.getTime()),
    ).toMatchObject({ resource_id: audio });
    expect(
      rows.filter((row) => row.event === 'workspace_retention_bound'),
    ).toMatchObject([
      { retention_days: 7, processing_days: 30 },
      { retention_days: 1, processing_days: 2 },
    ]);
    await db.recordings.setRetentionPolicy(source.owner.workspace_id, {
      retention_days: 1,
      processing_days: 2,
    });
    await db.recordings.setRetentionPolicy(source.owner.workspace_id, {
      retention_days: 7,
      processing_days: 30,
    });
    expect(await intents([audio, source.owner.workspace_id])).toHaveLength(
      rows.length,
    );
  });

  it('records revocation once per transition but not ordinary edits or subsequent grants', async () => {
    const source = await fixture(db);
    await db.pool.query('UPDATE documents SET title=$2 WHERE id=$1', [
      source.document.id,
      privateText,
    ]);
    expect(await intents([source.document.id, source.owner.user_id])).toEqual(
      [],
    );
    await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
      source.owner.user_id,
    ]);
    await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
      source.owner.user_id,
    ]);
    await db.pool.query(
      'UPDATE memberships SET active=false WHERE user_id=$1',
      [source.owner.user_id],
    );
    await db.pool.query(
      'UPDATE memberships SET active=false WHERE user_id=$1',
      [source.owner.user_id],
    );
    await db.provision(
      privateText,
      (
        await db.pool.query('SELECT subject FROM users WHERE id=$1', [
          source.owner.user_id,
        ])
      ).rows[0].subject,
      source.owner.workspace_id,
    );
    expect(await intents([source.owner.user_id])).toMatchObject([
      { event: 'account_revoked', workspace_id: null },
      { event: 'membership_revoked', workspace_id: source.owner.workspace_id },
    ]);
    expect(
      (await db.document(source.owner.user_id, source.document.id)).notes,
    ).toBe(privateText);
  });

  it('captures hard account/membership/workspace removal and initially inactive accounts', async () => {
    const account = randomUUID(),
      workspace = randomUUID();
    await db.pool.query(
      'INSERT INTO users(id,issuer,subject,active) VALUES($1::uuid,$2,$1::text,false)',
      [account, privateText],
    );
    await db.pool.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      workspace,
      privateText,
    ]);
    await db.pool.query(
      'INSERT INTO memberships(workspace_id,user_id,active) VALUES($1,$2,false)',
      [workspace, account],
    );
    await db.pool.query('DELETE FROM memberships WHERE user_id=$1', [account]);
    await db.pool.query('DELETE FROM users WHERE id=$1', [account]);
    await db.pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
    expect(
      (await intents([account, workspace])).map((row) => row.event).sort(),
    ).toEqual([
      'account_revoked',
      'account_revoked',
      'membership_revoked',
      'membership_revoked',
      'workspace_erased',
      'workspace_retention_bound',
    ]);
  });

  it.each([
    'UPDATE deletion_journal SET id=id',
    'DELETE FROM deletion_journal',
    'TRUNCATE deletion_journal',
    'UPDATE deletion_recovery_origin SET deployment_id=gen_random_uuid()',
    'DELETE FROM deletion_recovery_origin',
    'TRUNCATE deletion_recovery_origin CASCADE',
  ])('rejects destructive journal/origin mutation: %s', async (sql) => {
    const source = await fixture(db);
    const origin = (
      await db.pool.query('SELECT * FROM deletion_recovery_origin')
    ).rows;
    const before = await intents([source.owner.workspace_id]);
    await expect(db.pool.query(sql)).rejects.toThrow(
      'deletion_journal_immutable',
    );
    expect(await intents([source.owner.workspace_id])).toEqual(before);
    expect(
      (await db.pool.query('SELECT * FROM deletion_recovery_origin')).rows,
    ).toEqual(origin);
  });

  it('does not inherit audit retention or foreign-key deletion and refuses invalid event payloads', async () => {
    const id = randomUUID();
    await db.pool.query(
      "INSERT INTO deletion_journal(event,resource_id,recorded_at) VALUES('document_erased',$1,now()-interval '365 days')",
      [id],
    );
    await db.cleanup();
    expect(await intents([id])).toHaveLength(1);
    await expect(
      db.pool.query(
        "INSERT INTO deletion_journal(event,resource_id) VALUES('private-invalid-event',$1)",
        [randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        "INSERT INTO deletion_journal(event,resource_id) VALUES('recording_expiry_bound',$1)",
        [randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        "INSERT INTO deletion_journal(event,resource_id,expires_at) VALUES('document_erased',$1,now())",
        [randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        "INSERT INTO deletion_journal(event,resource_id,retention_days) VALUES('workspace_retention_bound',$1,1)",
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('bootstraps observable restrictions from version12 once, while explicitly retaining a new recovery origin rather than inventing erased history', async () => {
    const name = `deletion_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE SCHEMA "${name}"`);
    const previous = scoped(name);
    try {
      await previous.pool.query(
        'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL)',
      );
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory))
        .filter((file) => /^(00[1-9]|01[0-2])_/.test(file))
        .sort()) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await previous.pool.query(sql);
        await previous.pool.query(
          'INSERT INTO schema_migrations VALUES($1,$2)',
          [
            Number(file.slice(0, 3)),
            createHash('sha256').update(sql).digest('hex'),
          ],
        );
      }
      const erased = await fixture(previous),
        live = await fixture(previous);
      const removedAudio = await recording(previous, erased),
        retainedAudio = await recording(previous, live);
      const chat = await conversation(previous, erased),
        job = await clip(previous, erased);
      const disposed = await object(previous, removedAudio);
      await previous.pool.query(
        'UPDATE recording_objects SET cleanup_token=1 WHERE id=$1',
        [disposed],
      );
      await previous.deleteDocument(erased.owner.user_id, erased.document.id);
      await previous.pool.query('UPDATE users SET active=false WHERE id=$1', [
        erased.owner.user_id,
      ]);
      await previous.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1',
        [erased.owner.user_id],
      );
      await previous.migrate();
      expect(
        (
          await previous.pool.query(
            'SELECT 1 FROM deletion_journal WHERE publication_scope IS NOT NULL',
          )
        ).rows,
      ).toHaveLength(0);
      const rows = await intents(
        [
          erased.document.id,
          removedAudio,
          retainedAudio,
          erased.owner.user_id,
          live.owner.workspace_id,
          erased.owner.workspace_id,
          job,
          disposed,
          chat.thread,
          chat.turn,
        ],
        previous,
      );
      expect(rows.map((row) => row.event).sort()).toEqual([
        'account_revoked',
        'document_erased',
        'job_audio_erased',
        'membership_revoked',
        'recording_erased',
        'recording_expiry_bound',
        'staging_object_erased',
        'workspace_retention_bound',
        'workspace_retention_bound',
      ]);
      expect(
        rows.some(
          (row) =>
            row.resource_id === chat.thread || row.resource_id === chat.turn,
        ),
      ).toBe(false);
      const origin = (
        await previous.pool.query('SELECT * FROM deletion_recovery_origin')
      ).rows;
      expect(origin).toMatchObject([
        {
          singleton: true,
          deployment_id: expect.any(String),
          initialized_at: expect.any(Date),
        },
      ]);
      await previous.migrate();
      expect(
        await intents(
          rows.map((row) => row.resource_id),
          previous,
        ),
      ).toEqual(rows);
      expect(
        (await previous.pool.query('SELECT * FROM deletion_recovery_origin'))
          .rows,
      ).toEqual(origin);
      expect(JSON.stringify(rows)).not.toContain(privateText);
    } finally {
      await previous.close();
      await admin.pool.query(`DROP SCHEMA "${name}" CASCADE`);
    }
  });
});
