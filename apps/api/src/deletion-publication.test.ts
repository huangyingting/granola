import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
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
import { Database, digest } from '@windows-ai-notes/db';
import {
  deletionOriginSchema,
  deletionIntentSchema,
  type DeletionIntent,
  type DeletionArchiveHead,
} from '@windows-ai-notes/contracts/deletion';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { DeletionArchive } from '@windows-ai-notes/storage/deletion';
import {
  RecordingBlobs,
  objectKey,
  type StorageConfig,
} from '@windows-ai-notes/storage';
import { cleanupRecordingObjects } from './recordings.js';
import { createServer } from './server.js';
import { canonicalJson } from '@windows-ai-notes/contracts/content';

const url = process.env.TEST_DATABASE_URL,
  endpoint = process.env.TEST_S3_ENDPOINT;
const privateText = 'private-source-notes-identity-and-configuration';
const signal = () => AbortSignal.timeout(30_000);
function gate() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

describe.skipIf(!url || !endpoint)(
  'transaction-scoped independent deletion publication',
  () => {
    let bucket = `deletion-publication-${randomUUID()}`;
    const config: StorageConfig = {
      endpoint: endpoint ?? 'http://127.0.0.1:59000',
      region: 'us-east-1',
      bucket,
      encryption: 'none',
      credentials: {
        accessKeyId: 'storage-test-only',
        secretAccessKey: 'storage-test-only-secret',
      },
    };
    const s3 = new S3Client({
      ...config,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    const open = (name = bucket) =>
      new DeletionArchive({
        ...config,
        bucket: name,
        mode: 'development',
        retentionDays: 37,
      });
    let admin: Database, db: Database, archive: DeletionArchive;
    let schema: string, scopedUrl: string;
    beforeAll(async () => {
      admin = new Database(url!);
    });
    async function createBucket() {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ObjectLockEnabledForBucket: true,
        }),
      );
      await s3.send(
        new PutObjectLockConfigurationCommand({
          Bucket: bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: 'Enabled',
            Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 37 } },
          },
        }),
      );
    }
    beforeEach(async () => {
      bucket = `deletion-publication-${randomUUID()}`;
      await createBucket();
      schema = `deletion_publish_${randomUUID().replaceAll('-', '')}`;
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(url!);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      scopedUrl = scoped.href;
      archive = open();
      db = new Database(scopedUrl, archive);
      await db.migrate();
    }, 30_000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close();
      archive?.close();
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      for (let page = 0; page < 100; page++) {
        const listed = await s3.send(
          new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
        );
        const versions = [
          ...(listed.Versions ?? []),
          ...(listed.DeleteMarkers ?? []),
        ];
        if (!versions.length) break;
        for (const version of versions) {
          if (!version.Key || !version.VersionId)
            throw new Error('Incomplete synthetic archive version.');
          await s3.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: version.Key,
              VersionId: version.VersionId,
              BypassGovernanceRetention: true,
            }),
          );
        }
        if (page === 99)
          throw new Error('Synthetic archive cleanup exceeded its bound.');
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }, 60_000);
    afterAll(async () => {
      try {
        s3.destroy();
      } finally {
        await admin?.close();
      }
    }, 60_000);

    async function actor() {
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
    async function origin() {
      const row = (
        await db.pool.query<{
          deployment_id: string;
          initialized_at: Date;
        }>('SELECT deployment_id,initialized_at FROM deletion_recovery_origin')
      ).rows[0]!;
      return deletionOriginSchema.parse({
        deployment_id: row.deployment_id,
        initialized_at: row.initialized_at.toISOString(),
      });
    }
    async function archived() {
      const entries: DeletionIntent[] = [];
      const head = await archive.verify(
        await origin(),
        async (batch) => {
          entries.push(...batch.entries);
        },
        signal(),
      );
      return { head, entries };
    }
    async function retained(document: string) {
      return (
        await db.pool.query<{ deleted_at: Date | null }>(
          'SELECT deleted_at FROM documents WHERE id=$1',
          [document],
        )
      ).rows[0]!.deleted_at;
    }
    function recoveryIntent(
      event: DeletionIntent['event'],
      resource: string,
      workspace?: string,
    ) {
      return deletionIntentSchema.parse({
        id: randomUUID(),
        transaction_id: '42',
        recorded_at: new Date().toISOString(),
        event,
        resource_id: resource,
        workspace_id: event === 'membership_revoked' ? workspace : null,
        expires_at:
          event === 'recording_expiry_bound'
            ? new Date(Date.now() + 3600_000).toISOString()
            : null,
        retention_days: event === 'workspace_retention_bound' ? 1 : null,
        processing_days: event === 'workspace_retention_bound' ? 1 : null,
        reason: event === 'recording_erased' ? 'user' : null,
      });
    }
    async function publish(entries: DeletionIntent[]) {
      return archive.append(
        { version: 1, id: randomUUID(), origin: await origin(), entries },
        signal(),
      );
    }
    async function putProtected(Key: string, value: unknown) {
      const bytes = Buffer.from(canonicalJson(value));
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key,
          Body: bytes,
          ObjectLockMode: 'GOVERNANCE',
          ObjectLockRetainUntilDate: new Date(Date.now() + 38 * 86400_000),
          ChecksumAlgorithm: 'SHA256',
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        }),
      );
    }
    const unavailable = () =>
      new ServiceError(
        'deletion_archive_unavailable',
        'Synthetic archive transport failure.',
        503,
        true,
      );

    it.each([
      'document_erased',
      'recording_erased',
      'recording_expiry_bound',
      'chat_thread_erased',
      'chat_turn_erased',
      'account_revoked',
      'membership_revoked',
      'workspace_erased',
      'workspace_retention_bound',
      'job_erased',
      'job_audio_erased',
      'staging_object_erased',
      'verified_object_erased',
    ] as const)(
      'replays %s completely before exposure and retains exact receipt identity',
      async (event) => {
        const source = await actor();
        let resource = source.document.id;
        let recording: string | undefined,
          object: string | undefined,
          thread: string | undefined,
          turn: string | undefined,
          job: string | undefined;
        if (['account_revoked', 'membership_revoked'].includes(event))
          resource = source.owner.user_id;
        if (['workspace_erased', 'workspace_retention_bound'].includes(event))
          resource = source.owner.workspace_id;
        if (
          event.startsWith('recording_') ||
          event.endsWith('_object_erased')
        ) {
          recording = randomUUID();
          await db.pool.query(
            `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
          VALUES($1::uuid,$2,$3,$4,now(),'[]',$1::text,$5)`,
            [
              recording,
              source.document.id,
              source.owner.workspace_id,
              source.owner.user_id,
              privateText,
            ],
          );
          resource = recording;
        }
        if (event.endsWith('_object_erased')) {
          object = randomUUID();
          const chunk = randomUUID();
          await db.pool.query(
            `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,protected_until,cleanup_after,request_key)
          VALUES($1,$2,$3,$4,now()+interval '1 hour',now()+interval '2 hours',$5)`,
            [
              object,
              recording,
              chunk,
              event === 'staging_object_erased' ? 'staging' : 'verified',
              privateText,
            ],
          );
          if (event === 'verified_object_erased')
            await db.pool.query(
              `INSERT INTO recording_chunks(id,recording_id,track_id,sequence,sample_start,sample_count,descriptor,request_key,request_hash,state,verified_object)
            VALUES($1::uuid,$2,$3,0,0,1,'{}',$1::text,$4,'verified',$5)`,
              [chunk, recording, randomUUID(), privateText, object],
            );
          resource = object;
        }
        if (event.startsWith('chat_')) {
          thread = randomUUID();
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
          resource = event === 'chat_thread_erased' ? thread : turn;
        }
        if (event.startsWith('job_')) {
          job = randomUUID();
          await db.pool.query(
            `INSERT INTO jobs(id,document_id,workspace_id,owner_id,kind,idempotency_key,request_hash,input,audio)
          VALUES($1::uuid,$2,$3,$4,'transcription',$1::text,$5,'{}',$6)`,
            [
              job,
              source.document.id,
              source.owner.workspace_id,
              source.owner.user_id,
              privateText,
              Buffer.from(privateText),
            ],
          );
          resource = job;
        }
        await db.deletions.initialize(signal());
        const entry = recoveryIntent(
          event,
          resource,
          source.owner.workspace_id,
        );
        await publish([entry]);
        await expect(db.assertReady()).rejects.toMatchObject({
          code: 'deletion_usage_review_required',
        });
        expect(
          (
            await db.pool.query(
              'SELECT sha256 FROM deletion_receipts WHERE intent_id=$1',
              [entry.id],
            )
          ).rows,
        ).toEqual([{ sha256: digest(entry, true) }]);
        if (event === 'document_erased' || event === 'workspace_erased')
          expect(await retained(source.document.id)).toBeInstanceOf(Date);
        if (event === 'recording_erased')
          expect(
            (
              await db.pool.query(
                'SELECT deleted_at FROM recordings WHERE id=$1',
                [recording],
              )
            ).rows[0].deleted_at,
          ).toBeInstanceOf(Date);
        if (event === 'recording_expiry_bound')
          expect(
            (
              await db.pool.query<{ retention_expires_at: Date }>(
                'SELECT retention_expires_at FROM recordings WHERE id=$1',
                [recording],
              )
            ).rows[0]!.retention_expires_at.toISOString(),
          ).toBe(entry.expires_at);
        if (event === 'workspace_retention_bound')
          expect(
            (
              await db.pool.query(
                'SELECT audio_retention_days,audio_processing_days FROM workspaces WHERE id=$1',
                [resource],
              )
            ).rows[0],
          ).toEqual({ audio_retention_days: 1, audio_processing_days: 1 });
        if (event === 'account_revoked')
          expect(
            (
              await db.pool.query('SELECT active FROM users WHERE id=$1', [
                resource,
              ])
            ).rows[0],
          ).toEqual({ active: false });
        if (event === 'membership_revoked' || event === 'workspace_erased')
          expect(
            (
              await db.pool.query(
                'SELECT active FROM memberships WHERE user_id=$1 AND workspace_id=$2',
                [source.owner.user_id, source.owner.workspace_id],
              )
            ).rows[0],
          ).toEqual({ active: false });
        if (event.startsWith('chat_'))
          expect(
            (
              await db.pool.query(
                `SELECT 1 FROM ${event === 'chat_thread_erased' ? 'chat_threads' : 'chat_turns'} WHERE id=$1`,
                [resource],
              )
            ).rows,
          ).toHaveLength(0);
        if (event === 'job_erased')
          expect(
            (await db.pool.query('SELECT 1 FROM jobs WHERE id=$1', [job])).rows,
          ).toHaveLength(0);
        if (event === 'job_audio_erased')
          expect(
            (
              await db.pool.query('SELECT audio,state FROM jobs WHERE id=$1', [
                job,
              ])
            ).rows[0],
          ).toEqual({ audio: null, state: 'cancelled' });
        if (object) {
          const row = (
            await db.pool.query<{
              cleanup_token: number;
              protected_until: Date;
              deleted_at: Date | null;
            }>(
              'SELECT cleanup_token,protected_until,deleted_at FROM recording_objects WHERE id=$1',
              [object],
            )
          ).rows[0]!;
          expect(row.cleanup_token).toBeGreaterThan(0);
          expect(row.protected_until.getTime()).toBeGreaterThan(Date.now());
          expect(row.deleted_at).toBeNull();
          if (event === 'verified_object_erased')
            expect(
              (
                await db.pool.query(
                  'SELECT 1 FROM recording_chunks WHERE verified_object=$1',
                  [object],
                )
              ).rows,
            ).toHaveLength(0);
        }
        await db.deletions.reviewUsage(
          digest({ fixture: event, usage: 'no provider requests' }, true),
          signal(),
        );
        await db.assertReady();
        const references = (await archived()).entries.filter(
          (value) => value.id === entry.id,
        );
        expect(references.length).toBeGreaterThanOrEqual(2);
        expect(new Set(references.map((value) => digest(value, true)))).toEqual(
          new Set([digest(entry, true)]),
        );
      },
      30_000,
    );

    it('preserves a legitimate later grant across a fresh process recovery instead of reapplying its old revocation', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      await publish([recoveryIntent('account_revoked', source.owner.user_id)]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      await db.deletions.reviewUsage(
        digest({ fixture: 'grant', usage: 'none' }, true),
        signal(),
      );
      await db.transaction(async (tx) => {
        await tx.query('UPDATE users SET active=true WHERE id=$1', [
          source.owner.user_id,
        ]);
      });
      const other = open(),
        restarted = new Database(scopedUrl, other);
      try {
        await restarted.assertReady();
        expect(
          (
            await restarted.pool.query('SELECT active FROM users WHERE id=$1', [
              source.owner.user_id,
            ])
          ).rows[0],
        ).toEqual({ active: true });
      } finally {
        await restarted.close();
        other.close();
      }
    });

    it('keeps interrupted verified replay offline and resumes committed restrictions without duplicating their receipts', async () => {
      const first = await actor(),
        second = await actor();
      await db.deletions.initialize(signal());
      await publish([
        recoveryIntent('document_erased', first.document.id),
        recoveryIntent('document_erased', second.document.id),
      ]);
      const abort = new AbortController(),
        failure = new Error('synthetic-replay-interrupted');
      const append = archive.append.bind(archive);
      vi.spyOn(archive, 'append').mockImplementationOnce(async (...args) => {
        const result = await append(...args);
        abort.abort(failure);
        return result;
      });
      await expect(db.deletions.recover(abort.signal)).rejects.toBe(failure);
      const partial = [
        await retained(first.document.id),
        await retained(second.document.id),
      ];
      expect(partial.filter((value) => value !== null)).toHaveLength(1);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      expect(await retained(first.document.id)).toBeInstanceOf(Date);
      expect(await retained(second.document.id)).toBeInstanceOf(Date);
      const before = (await db.pool.query('SELECT 1 FROM deletion_receipts'))
        .rowCount;
      await db.deletions.reviewUsage(
        digest({ fixture: 'interrupted', usage: 'none' }, true),
        signal(),
      );
      expect(
        (await db.pool.query('SELECT 1 FROM deletion_receipts')).rowCount,
      ).toBe(before);
    });

    it('blocks new provider reservations and the server factory during usage quarantine while allowing known settlement', async () => {
      const source = await actor();
      await db.enqueueSummary(
        source.owner.user_id,
        source.document.id,
        { note_revision: 1, transcript_revision: 0, language: 'en' },
        randomUUID(),
      );
      const claim = await db.claim();
      if (!claim) throw new Error('Expected a synthetic leased job.');
      await db.deletions.initialize(signal());
      await publish([
        recoveryIntent('workspace_retention_bound', source.owner.workspace_id),
      ]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      await expect(
        db.usage.start(claim, {
          operation: 'summary',
          provider: 'fixture',
          configurationVersion: privateText,
          budget: { input_tokens: 1, output_tokens: 1, audio_ms: 0 },
        }),
      ).rejects.toMatchObject({ code: 'deletion_usage_review_required' });
      expect(
        (await db.pool.query('SELECT 1 FROM ai_usage_calls')).rows,
      ).toHaveLength(0);
      const app = await createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
      });
      try {
        await expect(app.ready()).rejects.toMatchObject({
          code: 'deletion_usage_review_required',
        });
      } finally {
        await app.close();
      }
    });

    it('does not apply a valid staged prefix until the entire chain is verified, then resumes after exact marker repair', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      const value = await origin();
      const root = digest(
        {
          version: 1,
          kind: 'genesis',
          origin: value,
          generation: '0',
          entry_references: '0',
          previous: null,
        },
        true,
      );
      await publish([recoveryIntent('document_erased', source.document.id)]);
      const Key = `deletion/v1/${value.deployment_id}/links/${root}.json`;
      const removed = await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key }),
      );
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_archive_invalid',
      });
      expect(await retained(source.document.id)).toBeNull();
      expect(removed.VersionId).toBeDefined();
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key,
          VersionId: removed.VersionId,
          BypassGovernanceRetention: true,
        }),
      );
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      expect(await retained(source.document.id)).toBeInstanceOf(Date);
    });

    it('rejects conflicting intent identity across independently valid batches before touching restored content', async () => {
      const first = await actor(),
        second = await actor();
      await db.deletions.initialize(signal());
      const entry = recoveryIntent('document_erased', first.document.id);
      await publish([entry]);
      await publish([{ ...entry, resource_id: second.document.id }]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_recovery_invalid',
      });
      expect(await retained(first.document.id)).toBeNull();
      expect(await retained(second.document.id)).toBeNull();
    });

    it('keeps usage quarantined when the independent archive fails during reconciliation review', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      await publish([recoveryIntent('document_erased', source.document.id)]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      const value = await origin();
      const Key = `deletion/v1/${value.deployment_id}/genesis.json`;
      const removed = await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key }),
      );
      try {
        await expect(
          db.deletions.reviewUsage(
            digest({ fixture: 'review-before-outage' }, true),
            signal(),
          ),
        ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
        await expect(db.deletions.assertUsageReady()).rejects.toMatchObject({
          code: 'deletion_usage_review_required',
        });
        expect(
          (
            await db.pool.query(
              'SELECT usage_proof_sha256 FROM deletion_recovery_state',
            )
          ).rows[0]!.usage_proof_sha256,
        ).toBeNull();
      } finally {
        if (!removed.VersionId)
          throw new Error('Synthetic archive delete marker unavailable.');
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key,
            VersionId: removed.VersionId,
            BypassGovernanceRetention: true,
          }),
        );
      }
      await db.deletions.reviewUsage(
        digest({ fixture: 'review-after-repair' }, true),
        signal(),
      );
      await db.assertReady();
    });

    it('requires renewed reconciliation if verified history advances after the operator reviewed it', async () => {
      const first = await actor(),
        second = await actor();
      await db.deletions.initialize(signal());
      await publish([recoveryIntent('document_erased', first.document.id)]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      await publish([recoveryIntent('document_erased', second.document.id)]);
      await expect(
        db.deletions.reviewUsage(
          digest({ fixture: 'outdated-review' }, true),
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'invalid_usage_review' });
      expect(await retained(second.document.id)).toBeInstanceOf(Date);
      await expect(db.deletions.assertUsageReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      await db.deletions.reviewUsage(
        digest({ fixture: 'renewed-review' }, true),
        signal(),
      );
      await db.assertReady();
    });

    it('persists a verified duplicate-only suffix as a rollback witness across fresh processes', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      await db.deleteDocument(source.owner.user_id, source.document.id);
      const before = await archived(),
        entry = before.entries[0];
      if (!entry)
        throw new Error('Synthetic acknowledged deletion unavailable.');
      for (let count = 0; count < 11; count++) await publish([entry]);
      const other = open(),
        verified = new Database(scopedUrl, other);
      try {
        await verified.assertReady();
        const state = (
          await verified.pool.query<{ verified_generation: string }>(
            'SELECT verified_generation::text FROM deletion_recovery_state',
          )
        ).rows[0]!;
        expect(BigInt(state.verified_generation)).toBeGreaterThan(10n);
      } finally {
        await verified.close();
        other.close();
      }
      await putProtected(
        `deletion/v1/${(await origin()).deployment_id}/head.json`,
        before.head,
      );
      const fresh = open(),
        restarted = new Database(scopedUrl, fresh);
      try {
        await expect(restarted.assertReady()).rejects.toMatchObject({
          code: 'deletion_archive_invalid',
        });
      } finally {
        await restarted.close();
        fresh.close();
      }
    });

    it('chooses the highest primary acknowledgement numerically rather than lexicographically after generation nine', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      let rollback: DeletionArchiveHead | undefined;
      for (let index = 0; index < 12; index++) {
        const document =
          index === 0
            ? source.document
            : await db.createDocument(
                source.owner.user_id,
                {
                  workspace_id: source.owner.workspace_id,
                  title: privateText,
                  notes: privateText,
                },
                randomUUID(),
              );
        await db.deleteDocument(source.owner.user_id, document.id);
        if (index === 9) rollback = (await archived()).head;
      }
      if (!rollback) throw new Error('Synthetic rollback head unavailable.');
      await putProtected(
        `deletion/v1/${(await origin()).deployment_id}/head.json`,
        rollback,
      );
      const other = open(),
        restarted = new Database(scopedUrl, other);
      try {
        await expect(restarted.assertReady()).rejects.toMatchObject({
          code: 'deletion_archive_invalid',
        });
      } finally {
        await restarted.close();
        other.close();
      }
    });

    it('rejects a valid archive rollback behind primary acknowledgements without relying on an in-process cache', async () => {
      const source = await actor();
      const baseline = await db.deletions.initialize(signal());
      await db.deleteDocument(source.owner.user_id, source.document.id);
      await putProtected(
        `deletion/v1/${(await origin()).deployment_id}/head.json`,
        baseline,
      );
      const other = open(),
        restarted = new Database(scopedUrl, other);
      try {
        await expect(restarted.assertReady()).rejects.toMatchObject({
          code: 'deletion_archive_invalid',
        });
      } finally {
        await restarted.close();
        other.close();
      }
    });

    it('does not silently turn a pre-origin restore into a new eligible deployment in the old archive bucket', async () => {
      await db.deletions.initialize(signal());
      const name = `pre_origin_${randomUUID().replaceAll('-', '')}`;
      await admin.pool.query(`CREATE SCHEMA "${name}"`);
      const value = new URL(url!);
      value.searchParams.set('options', `-c search_path=${name}`);
      const other = open(),
        old = new Database(value.href, other);
      try {
        await old.migrate();
        await expect(old.deletions.initialize(signal())).rejects.toMatchObject({
          code: 'deletion_archive_exists',
        });
        await expect(old.assertReady()).rejects.toMatchObject({
          code: 'deletion_archive_uninitialized',
        });
      } finally {
        await old.close();
        other.close();
        await admin.pool.query(`DROP SCHEMA "${name}" CASCADE`);
      }
    });

    it('keeps outcomes unavailable after failed declared recovery, then resets coverage only after verified replay and preserves it on restart', async () => {
      const source = await actor();
      const job = await db.enqueueSummary(
        source.owner.user_id,
        source.document.id,
        { note_revision: 1, transcript_revision: 0, language: 'en' },
        randomUUID(),
      );
      await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
        job.id,
      ]);
      await db.deletions.initialize(signal());
      const before = await db.taskOutcomes();
      expect(before.entries?.jobs.failed).toBe('1');
      expect((await db.taskOutcomeKinds()).entries?.jobs.summary.failed).toBe(
        '1',
      );
      const verify = vi
        .spyOn(archive, 'verify')
        .mockRejectedValueOnce(
          new ServiceError(
            'deletion_archive_invalid',
            'Synthetic verification failure.',
            503,
          ),
        );
      await expect(db.deletions.recover(signal(), true)).rejects.toMatchObject({
        code: 'deletion_archive_invalid',
      });
      expect(await db.taskOutcomes()).toMatchObject({
        status: 'recovery_pending',
        entries: null,
        coverage_since: before.coverage_since,
      });
      expect((await db.operations()).jobs.failed).toBe('1');
      expect(await db.taskOutcomeKinds()).toMatchObject({
        status: 'recovery_pending',
        entries: null,
        coverage_since: before.coverage_since,
      });
      verify.mockRestore();
      await expect(db.deletions.recover(signal())).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      const recovered = await db.taskOutcomes();
      expect(recovered).toMatchObject({
        status: 'observing',
        window_complete: false,
        entries: {
          jobs: {
            failed: '0',
            non_cancelled_terminal_entries: '0',
            success_share_ppm: null,
          },
        },
      });
      expect(recovered.coverage_since > before.coverage_since).toBe(true);
      expect(await db.taskOutcomeKinds()).toMatchObject({
        status: 'observing',
        coverage_since: recovered.coverage_since,
        entries: {
          jobs: { summary: { failed: '0' }, unclassified: { failed: '0' } },
        },
      });
      await db.deletions.reviewUsage(
        digest({ fixture: 'outcome-restart-reviewed' }, true),
        signal(),
      );
      const other = open(),
        restarted = new Database(scopedUrl, other);
      try {
        await restarted.assertReady();
        expect((await restarted.taskOutcomes()).coverage_since).toBe(
          recovered.coverage_since,
        );
        await restarted.pool.query(
          `UPDATE jobs SET state='queued' WHERE id=$1`,
          [job.id],
        );
        await restarted.pool.query(
          `UPDATE jobs SET state='succeeded' WHERE id=$1`,
          [job.id],
        );
        expect((await restarted.taskOutcomes()).entries?.jobs).toEqual({
          succeeded: '1',
          failed: '0',
          cancelled: '0',
          non_cancelled_terminal_entries: '1',
          success_share_ppm: 1_000_000,
        });
      } finally {
        await restarted.close();
        other.close();
      }
    });

    it('excludes replay-induced cancellations when missing independent history is detected without an explicit restore flag', async () => {
      const source = await actor();
      await db.enqueueSummary(
        source.owner.user_id,
        source.document.id,
        { note_revision: 1, transcript_revision: 0, language: 'en' },
        randomUUID(),
      );
      await db.deletions.initialize(signal());
      const before = await db.taskOutcomes();
      await publish([recoveryIntent('document_erased', source.document.id)]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      const after = await db.taskOutcomes();
      expect(after.coverage_since > before.coverage_since).toBe(true);
      expect(after.status).toBe('observing');
      expect(after.entries?.jobs.cancelled).toBe('0');
      expect(
        (await db.taskOutcomeKinds()).entries?.jobs.summary.cancelled,
      ).toBe('0');
      expect(
        (
          await db.pool.query(`SELECT count(*)::text n FROM audit_events
        WHERE action='job_state_changed' AND to_state='cancelled'`)
        ).rows[0],
      ).toEqual({ n: '1' });
      expect((await db.operations()).jobs.cancelled).toBe('1');
    });

    it('rolls back the final recovery acknowledgement if outcome coverage cannot resume', async () => {
      await db.deletions.initialize(signal());
      await db.pool
        .query(`CREATE FUNCTION reject_outcome_resume() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic_outcome_resume_failure'; END; $$;
        CREATE TRIGGER reject_outcome_resume BEFORE UPDATE ON task_outcome_coverage
          FOR EACH ROW WHEN(OLD.recovery_pending AND NOT NEW.recovery_pending)
          EXECUTE FUNCTION reject_outcome_resume()`);
      await expect(db.deletions.recover(signal(), true)).rejects.toThrow(
        'synthetic_outcome_resume_failure',
      );
      expect(await db.taskOutcomes()).toMatchObject({
        status: 'recovery_pending',
        entries: null,
      });
      expect(
        (
          await db.pool.query(
            `SELECT completed_at,usage_review_required FROM deletion_recovery_state`,
          )
        ).rows[0],
      ).toEqual({ completed_at: null, usage_review_required: true });
      await db.pool.query(
        'DROP TRIGGER reject_outcome_resume ON task_outcome_coverage',
      );
      await expect(db.deletions.recover(signal())).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      expect((await db.taskOutcomes()).status).toBe('observing');
    });

    it('applies permanent missing-resource fences and preserved bounds before a late offline creation can resurrect them', async () => {
      const source = await actor(),
        erased = randomUUID(),
        bounded = randomUUID();
      await db.deletions.initialize(signal());
      const expiry = recoveryIntent('recording_expiry_bound', bounded);
      await publish([recoveryIntent('recording_erased', erased), expiry]);
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      const insert = async (id: string) =>
        db.transaction(async (tx) => {
          await tx.query(
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
        });
      await expect(insert(erased)).rejects.toMatchObject({
        code: 'resource_gone',
      });
      await insert(bounded);
      expect(
        (
          await db.pool.query<{ retention_expires_at: Date }>(
            'SELECT retention_expires_at FROM recordings WHERE id=$1',
            [bounded],
          )
        ).rows[0]!.retention_expires_at.toISOString(),
      ).toBe(expiry.expires_at);
    });

    it.skipIf(!process.env.TEST_POSTGRES_CONTAINER)(
      'replays a real pg_dump/pg_restore and separately restored private media without rolling back its authority or inventing missing usage',
      async () => {
        const container = process.env.TEST_POSTGRES_CONTAINER!;
        const source = await actor(),
          recording = randomUUID(),
          object = { id: randomUUID(), kind: 'verified' as const };
        const media = `restore-media-${randomUUID()}`,
          Key = objectKey(object);
        const name = `restore_${randomUUID().replaceAll('-', '')}`;
        const parsed = new URL(url!),
          user = decodeURIComponent(parsed.username);
        const blobs = new RecordingBlobs({ ...config, bucket: media });
        let restored: Database | undefined, other: DeletionArchive | undefined;
        let dump: Buffer | undefined,
          mediaBackup: Buffer | undefined,
          created = false;
        await s3.send(new CreateBucketCommand({ Bucket: media }));
        try {
          await db.pool.query(
            `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
          VALUES($1::uuid,$2,$3,$4,now(),'[]',$1::text,$5)`,
            [
              recording,
              source.document.id,
              source.owner.workspace_id,
              source.owner.user_id,
              privateText,
            ],
          );
          await db.pool.query(
            `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,protected_until,cleanup_after,request_key)
          VALUES($1,$2,$3,'verified',now()-interval '1 hour',now()+interval '1 hour',$4)`,
            [object.id, recording, randomUUID(), privateText],
          );
          await s3.send(
            new PutObjectCommand({
              Bucket: media,
              Key,
              Body: Buffer.from('synthetic restored private media'),
            }),
          );
          const stored = await s3.send(
            new GetObjectCommand({ Bucket: media, Key }),
          );
          if (!stored.Body)
            throw new Error('Missing synthetic private media body.');
          mediaBackup = Buffer.from(await stored.Body.transformToByteArray());
          await db.enqueueSummary(
            source.owner.user_id,
            source.document.id,
            { note_revision: 1, transcript_revision: 0, language: 'en' },
            randomUUID(),
          );
          const claim = await db.claim();
          if (!claim) throw new Error('Expected a synthetic reserved job.');
          const call = await db.usage.start(claim, {
            operation: 'summary',
            provider: 'fixture',
            configurationVersion: privateText,
            budget: { input_tokens: 10, output_tokens: 10, audio_ms: 0 },
          });
          const historical = await db.enqueueSummary(
            source.owner.user_id,
            source.document.id,
            { note_revision: 1, transcript_revision: 0, language: 'en' },
            randomUUID(),
          );
          await db.pool.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [
            historical.id,
          ]);
          const beforeDump = await db.taskOutcomes();
          expect(beforeDump.entries?.jobs.failed).toBe('1');
          await db.deletions.initialize(signal());
          const dumped = await promisify(execFile)(
            'docker',
            [
              'exec',
              container,
              'pg_dump',
              '-U',
              user,
              '-d',
              decodeURIComponent(parsed.pathname.slice(1)),
              '--format=custom',
              '--schema',
              schema,
              '--no-owner',
              '--no-acl',
            ],
            {
              encoding: 'buffer',
              maxBuffer: 16 * 1024 * 1024,
              timeout: 30_000,
            },
          );
          dump = dumped.stdout;
          await db.deleteDocument(source.owner.user_id, source.document.id);
          const actual = { input_tokens: 2, output_tokens: 3, audio_ms: 0 };
          await db.usage.settle(call, actual);
          await cleanupRecordingObjects(db, blobs, signal());
          await expect(
            s3.send(new HeadObjectCommand({ Bucket: media, Key })),
          ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
          await admin.pool.query(`CREATE DATABASE "${name}"`);
          created = true;
          const bytes = dump;
          await new Promise<void>((resolve, reject) => {
            const child = execFile(
              'docker',
              [
                'exec',
                '-i',
                container,
                'pg_restore',
                '-U',
                user,
                '-d',
                name,
                '--exit-on-error',
                '--no-owner',
                '--no-acl',
              ],
              { timeout: 30_000, maxBuffer: 1024 * 1024 },
              (error) => (error ? reject(error) : resolve()),
            );
            if (!child.stdin) {
              child.kill('SIGTERM');
              reject(new Error('Synthetic restore stdin unavailable.'));
              return;
            }
            child.stdin.on('error', reject);
            child.stdin.end(bytes);
          });
          const restoredUrl = new URL(scopedUrl);
          restoredUrl.pathname = `/${name}`;
          other = open();
          restored = new Database(restoredUrl.href, other);
          await s3.send(
            new PutObjectCommand({ Bucket: media, Key, Body: mediaBackup }),
          );
          expect(
            (
              await restored.pool.query(
                'SELECT deleted_at FROM documents WHERE id=$1',
                [source.document.id],
              )
            ).rows[0],
          ).toEqual({ deleted_at: null });
          await expect(
            restored.deletions.recover(AbortSignal.timeout(60_000), true),
          ).rejects.toMatchObject({ code: 'deletion_usage_review_required' });
          const restoredOutcomes = await restored.taskOutcomes();
          expect(await restored.taskOutcomeKinds()).toMatchObject({
            status: 'observing',
            coverage_since: restoredOutcomes.coverage_since,
            entries: {
              jobs: {
                summary: { failed: '0', cancelled: '0' },
                unclassified: { failed: '0', cancelled: '0' },
              },
            },
          });
          expect(
            restoredOutcomes.coverage_since > beforeDump.coverage_since,
          ).toBe(true);
          expect(restoredOutcomes).toMatchObject({
            status: 'observing',
            window_complete: false,
            entries: {
              jobs: {
                failed: '0',
                cancelled: '0',
                non_cancelled_terminal_entries: '0',
                success_share_ppm: null,
              },
            },
          });
          expect(
            (
              await restored.pool.query(
                'SELECT deleted_at FROM documents WHERE id=$1',
                [source.document.id],
              )
            ).rows[0].deleted_at,
          ).toBeInstanceOf(Date);
          expect(
            (
              await restored.pool.query(
                'SELECT 1 FROM note_versions WHERE document_id=$1',
                [source.document.id],
              )
            ).rows,
          ).toHaveLength(0);
          expect(
            (
              await restored.pool.query(
                'SELECT deleted_at FROM recordings WHERE id=$1',
                [recording],
              )
            ).rows[0].deleted_at,
          ).toBeInstanceOf(Date);
          expect(
            await restored.usage.snapshot(source.owner.user_id),
          ).toMatchObject({
            settled: { input_tokens: '0', output_tokens: '0', audio_ms: '0' },
            uncertain: {
              input_tokens: '10',
              output_tokens: '10',
              audio_ms: '0',
            },
            uncertain_requests: '1',
          });
          await expect(
            restored.deletions.assertUsageReady(),
          ).rejects.toMatchObject({ code: 'deletion_usage_review_required' });
          await restored.usage.settle(call, actual);
          await restored.deletions.reviewUsage(
            digest(
              { fixture: 'authoritative-known-usage', call, actual },
              true,
            ),
            signal(),
          );
          await restored.assertReady();
          expect(
            await restored.usage.snapshot(source.owner.user_id),
          ).toMatchObject({
            settled: { input_tokens: '2', output_tokens: '3', audio_ms: '0' },
            settled_requests: '1',
            uncertain_requests: '0',
          });
          await cleanupRecordingObjects(restored, blobs, signal());
          await expect(
            s3.send(new HeadObjectCommand({ Bucket: media, Key })),
          ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
          const restoredOrigin = (
            await restored.pool.query<{ deployment_id: string }>(
              'SELECT deployment_id FROM deletion_recovery_origin',
            )
          ).rows[0]!;
          expect(restoredOrigin.deployment_id).toBe(
            (await origin()).deployment_id,
          );
        } finally {
          await restored?.close();
          other?.close();
          blobs.close();
          dump?.fill(0);
          mediaBackup?.fill(0);
          await s3.send(new DeleteObjectCommand({ Bucket: media, Key }));
          await s3.send(new DeleteBucketCommand({ Bucket: media }));
          if (created) await admin.pool.query(`DROP DATABASE "${name}"`);
        }
      },
      90_000,
    );

    it('initializes through the real deployment CLI and opens the public server factory only after verification', async () => {
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: 'development',
        DATABASE_URL: scopedUrl,
        DELETION_ARCHIVE_ENDPOINT: config.endpoint,
        DELETION_ARCHIVE_REGION: config.region,
        DELETION_ARCHIVE_BUCKET: bucket,
        DELETION_ARCHIVE_ENCRYPTION: 'none',
        DELETION_ARCHIVE_ACCESS_KEY_ID: config.credentials!.accessKeyId,
        DELETION_ARCHIVE_SECRET_ACCESS_KEY: config.credentials!.secretAccessKey,
        DELETION_ARCHIVE_RETENTION_DAYS: '37',
      };
      const cli = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../../packages/db/dist/cli.js', import.meta.url),
            ),
            ...args,
          ],
          { env: environment, timeout: 30_000 },
        );
      const result = await cli('deletion-init');
      expect(JSON.parse(result.stdout)).toMatchObject({
        generation: '0',
        entry_references: '0',
      });
      await expect(
        cli('deletion-recover', '--restored-backup'),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('deletion_usage_review_required'),
      });
      await expect(db.deletions.assertUsageReady()).rejects.toMatchObject({
        code: 'deletion_usage_review_required',
      });
      await cli(
        'deletion-usage-reviewed',
        '--proof-sha256',
        digest({ fixture: 'empty-authoritative-usage' }, true),
      );
      const app = await createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
      });
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const response = await fetch(`${address}/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'ok' });
      } finally {
        await app.close();
      }
    });
    it('binds an explicit fresh empty baseline and keeps configured or bound services quarantined', async () => {
      await expect(db.assertReady()).rejects.toMatchObject({
        code: 'deletion_archive_uninitialized',
      });
      const baseline = await db.deletions.initialize(signal());
      expect(baseline).toMatchObject({
        generation: '0',
        entry_references: '0',
      });
      expect(
        (await db.pool.query('SELECT * FROM deletion_receipts')).rows,
      ).toHaveLength(0);
      expect(
        (await db.pool.query('SELECT * FROM deletion_archive_binding')).rows[0],
      ).toMatchObject({
        archive_identity: archive.identity,
        baseline_tip: baseline.tip,
        baseline_generation: '0',
      });
      await db.assertReady();
      const unconfigured = new Database(scopedUrl);
      try {
        await expect(unconfigured.assertReady()).rejects.toMatchObject({
          code: 'deletion_archive_required',
        });
      } finally {
        await unconfigured.close();
      }
      await expect(db.deletions.initialize(signal())).rejects.toMatchObject({
        code: 'deletion_archive_already_bound',
      });
    });

    it.each(['api', 'worker'] as const)(
      'keeps the actual %s entrypoint offline for a bound database',
      async (entry) => {
        await db.deletions.initialize(signal());
        await expect(
          promisify(execFile)(
            process.execPath,
            [
              fileURLToPath(
                new URL(`../../${entry}/dist/main.js`, import.meta.url),
              ),
            ],
            {
              timeout: 10_000,
              env: {
                NODE_ENV: 'development',
                DATABASE_URL: scopedUrl,
                AUTH_MODE: 'development',
                HOST: '127.0.0.1',
                AZURE_OPENAI_ENDPOINT: 'https://synthetic.openai.azure.com/',
                AZURE_OPENAI_API_KEY: 'synthetic-azure-key-not-a-secret',
                AZURE_OPENAI_API_VERSION: '2024-10-21',
                AZURE_OPENAI_DEPLOYMENT: 'synthetic',
                AZURE_SPEECH_KEY: 'synthetic-speech-key-not-a-secret',
                AZURE_SPEECH_REGION: 'eastus',
              },
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stdout: expect.not.stringContaining(`${entry}_ready`),
          stderr: expect.stringContaining('deletion_archive_required'),
        });
      },
    );

    it('archives the complete locked baseline in bounded batches, with exact immutable metadata receipts', async () => {
      await actor();
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO workspaces(id,name)
           SELECT gen_random_uuid(),$1 FROM generate_series(1,120)`,
          [privateText],
        );
      });
      const baseline = await db.deletions.initialize(signal());
      expect(baseline).toMatchObject({
        generation: '2',
        entry_references: '121',
      });
      const result = await archived();
      expect(result.entries).toHaveLength(121);
      expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(121);
      const receipts = (
        await db.pool.query<{ intent_id: string; sha256: string }>(
          'SELECT intent_id,sha256 FROM deletion_receipts',
        )
      ).rows;
      expect(receipts).toHaveLength(121);
      for (const entry of result.entries)
        expect(
          receipts.find((receipt) => receipt.intent_id === entry.id),
        ).toMatchObject({ sha256: digest(entry, true) });
      expect(
        (await db.pool.query('SELECT scope FROM deletion_publications')).rows,
      ).toEqual([{ scope: null }, { scope: null }]);
      expect(JSON.stringify(result)).not.toContain(privateText);
    });

    it('never binds a restored or partially initialized namespace, even when its existing head is a valid empty genesis', async () => {
      await archive.assertReady(signal());
      const before = await archive.initialize(await origin(), signal());
      await expect(db.deletions.initialize(signal())).rejects.toMatchObject({
        code: 'deletion_archive_exists',
      });
      expect((await archived()).head).toEqual(before);
      expect(
        (await db.pool.query('SELECT * FROM deletion_archive_binding')).rows,
      ).toHaveLength(0);
    });

    it('does not acknowledge source deletion until independent storage accepts it and the primary transaction commits', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      const entered = gate(),
        release = gate();
      const append = archive.append.bind(archive);
      vi.spyOn(archive, 'append').mockImplementation(async (...args) => {
        const result = await append(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
      let acknowledged = false;
      const pending = db
        .deleteDocument(source.owner.user_id, source.document.id)
        .then(() => {
          acknowledged = true;
        });
      try {
        await Promise.race([entered.promise, pending]);
        expect(acknowledged).toBe(false);
        expect(await retained(source.document.id)).toBeNull();
        expect((await archived()).entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: 'document_erased',
              resource_id: source.document.id,
            }),
          ]),
        );
      } finally {
        release.resolve();
        await pending;
      }
      expect(acknowledged).toBe(true);
      expect(await retained(source.document.id)).toBeInstanceOf(Date);
    });

    it('rolls back source data, capture and primary receipts when independent publication is unavailable', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      const before = await archived();
      const failure = unavailable();
      vi.spyOn(archive, 'append').mockRejectedValue(failure);
      await expect(
        db.deleteDocument(source.owner.user_id, source.document.id),
      ).rejects.toBe(failure);
      expect(await retained(source.document.id)).toBeNull();
      expect(await archived()).toEqual(before);
      expect(
        (
          await db.pool.query(
            "SELECT 1 FROM deletion_journal WHERE event='document_erased'",
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.pool.query('SELECT 1 FROM deletion_receipts')).rows,
      ).toHaveLength(before.entries.length);
    });

    it('preserves independently accepted intent when a real deferred primary COMMIT constraint fails, without claiming source success', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      await db.pool.query(`
        CREATE FUNCTION reject_source_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic_source_commit_failed'; END IF;
          RETURN NULL;
        END; $$;
        CREATE CONSTRAINT TRIGGER reject_source_commit AFTER UPDATE ON documents
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_source_commit()`);
      await expect(
        db.deleteDocument(source.owner.user_id, source.document.id),
      ).rejects.toThrow('synthetic_source_commit_failed');
      expect(await retained(source.document.id)).toBeNull();
      const result = await archived();
      expect(
        result.entries.filter((entry) => entry.event === 'document_erased'),
      ).toHaveLength(1);
      expect(result.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resource_id: source.document.id }),
        ]),
      );
      expect(
        (
          await db.pool.query(
            "SELECT 1 FROM deletion_journal WHERE event='document_erased'",
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.pool.query('SELECT 1 FROM deletion_publications')).rows,
      ).toHaveLength(1);
    });

    it('leaves failed baseline COMMITs unbound and refuses to silently repair them from an existing archive', async () => {
      await actor();
      await db.pool.query(`
        CREATE FUNCTION reject_binding_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic_binding_commit_failed'; END; $$;
        CREATE CONSTRAINT TRIGGER reject_binding_commit AFTER INSERT ON deletion_archive_binding
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_binding_commit()`);
      await expect(db.deletions.initialize(signal())).rejects.toThrow(
        'synthetic_binding_commit_failed',
      );
      expect((await archived()).entries).toHaveLength(1);
      expect(
        (await db.pool.query('SELECT * FROM deletion_archive_binding')).rows,
      ).toHaveLength(0);
      expect(
        (await db.pool.query('SELECT * FROM deletion_receipts')).rows,
      ).toHaveLength(0);
      await expect(db.deletions.initialize(signal())).rejects.toMatchObject({
        code: 'deletion_archive_exists',
      });
    });

    it('rejects raw SQL and unconfigured transactions that bypass independent publication', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      await expect(
        db.pool.query('UPDATE users SET active=false WHERE id=$1', [
          source.owner.user_id,
        ]),
      ).rejects.toThrow('deletion_archive_receipt_required');
      const unconfigured = new Database(scopedUrl);
      try {
        await expect(
          unconfigured.deleteDocument(source.owner.user_id, source.document.id),
        ).rejects.toThrow('deletion_archive_receipt_required');
      } finally {
        await unconfigured.close();
      }
      expect(await retained(source.document.id)).toBeNull();
      expect(
        (
          await db.pool.query('SELECT active FROM users WHERE id=$1', [
            source.owner.user_id,
          ])
        ).rows[0],
      ).toEqual({ active: true });
    });

    it('rejects late deferred source mutations that appear after the pre-COMMIT publication hook', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      const before = await archived();
      await db.pool.query(`
        CREATE FUNCTION mutate_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE users SET active=false WHERE id='${source.owner.user_id}';
          RETURN NULL;
        END; $$;
        CREATE CONSTRAINT TRIGGER mutate_at_commit AFTER UPDATE ON workspaces
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mutate_at_commit()`);
      await expect(
        db.transaction(async (tx) => {
          await tx.query('UPDATE workspaces SET name=name WHERE id=$1', [
            source.owner.workspace_id,
          ]);
        }),
      ).rejects.toThrow('deletion_archive_receipt_required');
      expect(await archived()).toEqual(before);
      expect(
        (
          await db.pool.query('SELECT active FROM users WHERE id=$1', [
            source.owner.user_id,
          ])
        ).rows[0],
      ).toEqual({ active: true });
    });

    it('uses fresh row provenance rather than restored historical xid8 coincidence as its export scope', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      const historical = randomUUID();
      await db.transaction(async (tx) => {
        await tx.query(
          'ALTER TABLE deletion_journal DISABLE TRIGGER deletion_publication_required',
        );
        await tx.query(
          `INSERT INTO deletion_journal(id,transaction_id,event,resource_id,publication_scope)
           VALUES($1,pg_current_xact_id(),'document_erased',$2,NULL)`,
          [historical, randomUUID()],
        );
        await tx.query(
          'ALTER TABLE deletion_journal ENABLE TRIGGER deletion_publication_required',
        );
        await tx.query('UPDATE users SET active=false WHERE id=$1', [
          source.owner.user_id,
        ]);
      });
      const matching = (
        await db.pool.query<{
          id: string;
          transaction_id: string;
          publication_scope: string | null;
        }>(
          `SELECT id,transaction_id::text,publication_scope FROM deletion_journal
           WHERE id=$1 OR event='account_revoked'`,
          [historical],
        )
      ).rows;
      expect(matching).toHaveLength(2);
      expect(new Set(matching.map((row) => row.transaction_id)).size).toBe(1);
      expect(
        matching.find((row) => row.id === historical)?.publication_scope,
      ).toBeNull();
      const result = await archived();
      expect(result.entries.some((entry) => entry.id === historical)).toBe(
        false,
      );
      expect(
        result.entries.some((entry) => entry.event === 'account_revoked'),
      ).toBe(true);
    });

    it('retains read-only repeatable-read diagnostics without assigning an xid or contacting unavailable archival storage', async () => {
      await actor();
      await db.deletions.initialize(signal());
      const append = vi
        .spyOn(archive, 'append')
        .mockRejectedValue(unavailable());
      expect(
        await db.transaction(async (tx) => {
          await tx.query(
            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
          );
          return (
            await tx.query('SELECT pg_current_xact_id_if_assigned()::text xid')
          ).rows[0];
        }),
      ).toEqual({ xid: null });
      expect(await db.operations()).toBeDefined();
      expect(await db.taskOutcomes()).toMatchObject({ status: 'observing' });
      expect((await db.audit.page()).events.length).toBeGreaterThan(0);
      expect(append).not.toHaveBeenCalled();
    });

    it('preserves late known provider usage after deletion even while independent archival storage is unavailable', async () => {
      const source = await actor();
      await db.enqueueSummary(
        source.owner.user_id,
        source.document.id,
        { note_revision: 1, transcript_revision: 0, language: 'en' },
        randomUUID(),
      );
      const claim = await db.claim();
      if (!claim) throw new Error('Expected a synthetic leased job.');
      const reserved = await db.usage.start(claim, {
        operation: 'summary',
        provider: 'fixture',
        configurationVersion: privateText,
        budget: { input_tokens: 10, output_tokens: 10, audio_ms: 0 },
      });
      await db.deletions.initialize(signal());
      await db.deleteDocument(source.owner.user_id, source.document.id);
      const append = vi
        .spyOn(archive, 'append')
        .mockRejectedValue(unavailable());
      await db.usage.settle(reserved, {
        input_tokens: 2,
        output_tokens: 3,
        audio_ms: 0,
      });
      expect(await db.usage.snapshot(source.owner.user_id)).toMatchObject({
        settled: { input_tokens: '2', output_tokens: '3', audio_ms: '0' },
        settled_requests: '1',
        uncertain_requests: '0',
      });
      expect(append).not.toHaveBeenCalled();
    });

    it('rejects a different archive target before publishing or committing source deletion', async () => {
      const source = await actor();
      await db.deletions.initialize(signal());
      const other = open(`other-archive-${randomUUID()}`);
      const wrong = new Database(scopedUrl, other);
      const append = vi.spyOn(other, 'append');
      try {
        await expect(
          wrong.deleteDocument(source.owner.user_id, source.document.id),
        ).rejects.toMatchObject({
          code: 'deletion_archive_binding_mismatch',
        });
        expect(append).not.toHaveBeenCalled();
        expect(await retained(source.document.id)).toBeNull();
      } finally {
        await wrong.close();
        other.close();
      }
    });

    it('preserves concurrent primary commits across separate publishers and receipts only their own source scopes', async () => {
      const sources = [await actor(), await actor()];
      await db.deletions.initialize(signal());
      const other = open(),
        second = new Database(scopedUrl, other);
      try {
        await other.assertReady(signal());
        await Promise.all(
          sources.map((source, index) =>
            (index === 0 ? db : second).deleteDocument(
              source.owner.user_id,
              source.document.id,
            ),
          ),
        );
        const result = await archived();
        expect(
          result.entries.filter((entry) => entry.event === 'document_erased'),
        ).toHaveLength(2);
        const scopes = (
          await db.pool.query<{ scope: string }>(
            'SELECT scope FROM deletion_publications WHERE scope IS NOT NULL',
          )
        ).rows;
        expect(new Set(scopes.map((row) => row.scope)).size).toBe(2);
        expect(
          (await db.pool.query('SELECT 1 FROM deletion_receipts')).rowCount,
        ).toBe(4);
      } finally {
        await second.close();
        other.close();
      }
    });

    it('archives object-disposal intent before actual private media removal and does not append it again on completion', async () => {
      const source = await actor(),
        recording = randomUUID(),
        object = { id: randomUUID(), kind: 'staging' as const };
      await db.pool.query(
        `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
         VALUES($1::uuid,$2,$3,$4,now(),'[]',$1::text,$5)`,
        [
          recording,
          source.document.id,
          source.owner.workspace_id,
          source.owner.user_id,
          privateText,
        ],
      );
      await db.pool.query(
        `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,protected_until,cleanup_after,request_key)
         VALUES($1,$2,$3,'staging',now()-interval '1 hour',now()-interval '1 hour',$4)`,
        [object.id, recording, randomUUID(), privateText],
      );
      const media = `deletion-media-${randomUUID()}`,
        Key = objectKey(object);
      await s3.send(new CreateBucketCommand({ Bucket: media }));
      const blobs = new RecordingBlobs({ ...config, bucket: media });
      const entered = gate(),
        release = gate();
      let pending: Promise<void> | undefined;
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: media,
            Key,
            Body: Buffer.from('synthetic temporary audio'),
          }),
        );
        await db.deletions.initialize(signal());
        const append = archive.append.bind(archive);
        vi.spyOn(archive, 'append').mockImplementation(async (...args) => {
          const result = await append(...args);
          entered.resolve();
          await release.promise;
          return result;
        });
        const remove = vi.spyOn(blobs, 'remove');
        pending = cleanupRecordingObjects(db, blobs, signal());
        await Promise.race([entered.promise, pending]);
        expect(remove).not.toHaveBeenCalled();
        expect(
          await s3.send(new HeadObjectCommand({ Bucket: media, Key })),
        ).toMatchObject({ ContentLength: 25 });
        expect(
          (await archived()).entries.filter(
            (entry) =>
              entry.event === 'staging_object_erased' &&
              entry.resource_id === object.id,
          ),
        ).toHaveLength(1);
        release.resolve();
        await pending;
        expect(remove).toHaveBeenCalledTimes(1);
        await expect(
          s3.send(new HeadObjectCommand({ Bucket: media, Key })),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
        expect(
          (await archived()).entries.filter(
            (entry) => entry.event === 'staging_object_erased',
          ),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await pending;
        blobs.close();
        await s3.send(new DeleteObjectCommand({ Bucket: media, Key }));
        await s3.send(new DeleteBucketCommand({ Bucket: media }));
      }
    });

    it.each([
      'UPDATE deletion_archive_binding SET archive_identity=archive_identity',
      'DELETE FROM deletion_archive_binding',
      'TRUNCATE deletion_archive_binding',
      'UPDATE deletion_publications SET tip=tip',
      'DELETE FROM deletion_publications',
      'TRUNCATE deletion_publications CASCADE',
      'UPDATE deletion_receipts SET sha256=sha256',
      'DELETE FROM deletion_receipts',
      'TRUNCATE deletion_receipts',
    ])(
      'rejects ordinary mutation of binding or receipt evidence: %s',
      async (sql) => {
        await actor();
        await db.deletions.initialize(signal());
        await expect(db.pool.query(sql)).rejects.toThrow(
          'deletion_journal_immutable',
        );
      },
    );
  },
);
