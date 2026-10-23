import { createHash, randomUUID } from 'node:crypto';
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
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Database, type Transaction } from '@windows-ai-notes/db';
import {
  RecordingBlobs,
  objectKey,
  type StorageConfig,
} from '@windows-ai-notes/storage';
import { recordingMediaVerificationSchema } from '@windows-ai-notes/contracts/operations';
import type { UploadChunk } from '@windows-ai-notes/contracts';
import { canonicalJson } from '@windows-ai-notes/contracts/content';

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_S3_ENDPOINT;
const privateMarker = 'private-media-verification-marker';
const wav = Buffer.from(
  '524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000',
  'hex',
);

describe.skipIf(!databaseUrl || !endpoint)(
  'deployment verification of real private recording media',
  () => {
    const schema = `media_verify_${randomUUID().replaceAll('-', '')}`;
    const bucket = `notes-media-check-${randomUUID()}`;
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
    let admin: Database,
      db: Database,
      storage: RecordingBlobs,
      scopedUrl: string;
    let bucketCreated = false,
      schemaCreated = false;
    const signal = () => AbortSignal.timeout(30_000);
    const verify = () => db.verifyRecordingMedia(storage, signal());
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../../packages/db/dist/cli.js', import.meta.url),
          ),
          'audio-verify',
          ...args,
        ],
        {
          env: {
            NODE_ENV: 'test',
            DATABASE_URL: scopedUrl,
            S3_ENDPOINT: config.endpoint,
            S3_REGION: config.region,
            S3_BUCKET: bucket,
            S3_ENCRYPTION: 'none',
            S3_ACCESS_KEY_ID: config.credentials!.accessKeyId,
            S3_SECRET_ACCESS_KEY: config.credentials!.secretAccessKey,
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
    beforeAll(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }), {
        abortSignal: signal(),
      });
      bucketCreated = true;
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      scopedUrl = url.href;
      db = new Database(scopedUrl);
      await db.migrate();
      storage = new RecordingBlobs(config);
    }, 30_000);
    beforeEach(async () => {
      await db.pool.query(`TRUNCATE users,workspaces,audit_events CASCADE;
      UPDATE deletion_recovery_state SET usage_review_required=false;
      UPDATE task_outcome_coverage SET recovery_pending=false`);
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      try {
        await db?.close();
      } finally {
        try {
          if (schemaCreated)
            await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin?.close();
          storage?.close();
          try {
            if (bucketCreated) {
              for (let page = 0; page < 32; page++) {
                const listed = await s3.send(
                  new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }),
                  { abortSignal: signal() },
                );
                if (!listed.Contents?.length) break;
                for (const object of listed.Contents) {
                  if (!object.Key)
                    throw new Error(
                      'An owned synthetic media object has no key.',
                    );
                  await s3.send(
                    new DeleteObjectCommand({
                      Bucket: bucket,
                      Key: object.Key,
                    }),
                    { abortSignal: signal() },
                  );
                }
              }
              await s3.send(new DeleteBucketCommand({ Bucket: bucket }), {
                abortSignal: signal(),
              });
            }
          } finally {
            s3.destroy();
          }
        }
      }
    });
    async function fixture(uppercase = false, trackId: string = randomUUID()) {
      const actor = await db.provision(privateMarker, randomUUID());
      const document = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: privateMarker,
          notes: privateMarker,
        },
        randomUUID(),
      );
      const id = uppercase ? randomUUID().toUpperCase() : randomUUID(),
        track = uppercase ? trackId.toUpperCase() : trackId;
      await db.recordings.create(
        actor.user_id,
        document.id,
        {
          id,
          created_at: new Date().toISOString(),
          tracks: [
            {
              spec: {
                track_id: track,
                kind: 'microphone',
                capture_scope: 'endpoint',
                device_selection_policy: 'explicit',
                device_id: 'synthetic-microphone',
              },
              actual_device_id: 'synthetic-microphone',
            },
          ],
        },
        randomUUID(),
      );
      async function add(
        sequence = 0,
        chunkId: string = uppercase ? randomUUID().toUpperCase() : randomUUID(),
      ) {
        const upload: UploadChunk = {
          chunk: {
            format_version: 1,
            recording_id: id,
            track_id: track,
            chunk_id: chunkId,
            capture_epoch: randomUUID(),
            sequence,
            sample_start: sequence,
            sample_count: 1,
            sample_rate: 16000,
            channels: 1,
            bits_per_sample: 16,
            clock_start_ms: sequence / 16,
            clock_end_ms: (sequence + 1) / 16,
            pcm_sha256: createHash('sha256')
              .update(wav.subarray(44))
              .digest('hex'),
          },
          size_bytes: wav.length,
          sha256: createHash('sha256').update(wav).digest('hex'),
        };
        await db.recordings.register(actor.user_id, id, upload, randomUUID());
        const authorized = await db.recordings.authorizeUpload(
          actor.user_id,
          chunkId,
          randomUUID(),
        );
        if (!authorized)
          throw new Error('Synthetic media staging authorization is missing.');
        const lease = await db.recordings.beginVerification(
          actor.user_id,
          chunkId,
          authorized.object.id,
          randomUUID(),
        );
        if (!lease)
          throw new Error(
            'Synthetic immutable media verification lease is missing.',
          );
        await storage.promote(lease.candidate, wav, signal());
        await db.recordings.finishVerification(actor.user_id, lease);
        return { upload, object: lease.candidate };
      }
      return { actor, document, id, track, add };
    }
    it.each([
      { uppercase: true, track: randomUUID() },
      { uppercase: false, track: '00000000-0000-5000-8000-000000000001' },
    ])(
      'accepts supported UUID identity representations %j',
      async ({ uppercase, track }) => {
        const source = await fixture(uppercase, track);
        await source.add();
        expect(await verify()).toMatchObject({
          verified_chunks: '1',
          verified_bytes: String(wav.length),
        });
      },
    );
    it('validates real restored bytes, never changes recovery authority, and emits no identifying metadata', async () => {
      const source = await fixture(),
        object = await source.add();
      const backup = await storage.read(object.object, wav.length, signal());
      try {
        await storage.remove(object.object, signal());
        await expect(verify()).rejects.toMatchObject({
          code: 'recording_media_integrity_failed',
        });
        await storage.promote(object.object, backup, signal());
        const before = (
          await db.pool.query('SELECT * FROM deletion_recovery_state')
        ).rows;
        const report = recordingMediaVerificationSchema.parse(await verify());
        expect(report).toMatchObject({
          verified_chunks: '1',
          verified_bytes: String(wav.length),
        });
        expect(
          (await db.pool.query('SELECT * FROM deletion_recovery_state')).rows,
        ).toEqual(before);
        const output = JSON.stringify(report);
        for (const value of [
          privateMarker,
          source.actor.user_id,
          source.document.id,
          source.id,
          object.object.id,
          object.upload.sha256,
          bucket,
          config.endpoint,
        ])
          expect(output).not.toContain(value);
      } finally {
        backup.fill(0);
      }
    });
    it('uses one read-only repeatable-read snapshot across bounded keyset pages', async () => {
      const source = await fixture();
      for (let sequence = 0; sequence < 129; sequence++)
        await source.add(
          sequence,
          `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`,
        );
      const original = db.transaction.bind(db);
      vi.spyOn(db, 'transaction').mockImplementation(
        async <T>(operation: (tx: Transaction) => Promise<T>): Promise<T> =>
          original(async (tx) => {
            const value = await operation(tx);
            if (
              value &&
              typeof value === 'object' &&
              'verified_chunks' in value
            ) {
              expect(
                (await tx.query('SHOW transaction_read_only')).rows[0],
              ).toEqual({ transaction_read_only: 'on' });
              expect(
                (await tx.query('SHOW transaction_isolation')).rows[0],
              ).toEqual({ transaction_isolation: 'repeatable read' });
            }
            return value;
          }),
      );
      const read = storage.read.bind(storage);
      let inserted = false;
      vi.spyOn(storage, 'read').mockImplementation(async (...args) => {
        if (!inserted) {
          inserted = true;
          await source.add(129, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
        }
        return read(...args);
      });
      expect(await verify()).toMatchObject({
        verified_chunks: '129',
        verified_bytes: String(129 * wav.length),
      });
      expect(await verify()).toMatchObject({
        verified_chunks: '130',
        verified_bytes: String(130 * wav.length),
      });
    }, 30_000);
    it.each(['changed', 'truncated', 'oversized'] as const)(
      'fails explicitly for %s private media and clears every returned body',
      async (damage) => {
        const source = await fixture(),
          object = await source.add();
        const damaged =
          damage === 'truncated'
            ? wav.subarray(0, wav.length - 1)
            : damage === 'oversized'
              ? Buffer.concat([wav, Buffer.from([0])])
              : Buffer.from(wav);
        if (damage === 'changed') damaged[damaged.length - 1] = 1;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey(object.object),
            Body: damaged,
          }),
          { abortSignal: signal() },
        );
        const read = storage.read.bind(storage),
          bodies: Buffer[] = [];
        vi.spyOn(storage, 'read').mockImplementation(async (...args) => {
          const body = await read(...args);
          bodies.push(body);
          return body;
        });
        await expect(verify()).rejects.toMatchObject({
          code: 'recording_media_integrity_failed',
        });
        expect(bodies).toHaveLength(damage === 'oversized' ? 0 : 1);
        for (const body of bodies)
          expect(body.every((byte) => byte === 0)).toBe(true);
      },
    );
    it('clears verified buffers after successful hashing and after cancellation', async () => {
      const source = await fixture();
      await source.add();
      const read = storage.read.bind(storage),
        bodies: Buffer[] = [];
      const controller = new AbortController();
      vi.spyOn(storage, 'read').mockImplementation(async (...args) => {
        const body = await read(...args);
        bodies.push(body);
        return body;
      });
      await verify();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.every((byte) => byte === 0)).toBe(true);
      vi.mocked(storage.read).mockImplementation(async (...args) => {
        const body = await read(...args);
        bodies.push(body);
        controller.abort(new Error('Synthetic cancellation.'));
        return body;
      });
      await expect(
        db.verifyRecordingMedia(storage, controller.signal),
      ).rejects.toThrow('Synthetic cancellation.');
      expect(bodies).toHaveLength(2);
      expect(bodies[1]!.every((byte) => byte === 0)).toBe(true);
    });
    it.each(['usage', 'deletion'] as const)(
      'refuses known %s quarantine before accessing storage',
      async (hold) => {
        const ready = vi.spyOn(storage, 'assertReady'),
          read = vi.spyOn(storage, 'read');
        if (hold === 'usage')
          await db.pool.query(
            'UPDATE deletion_recovery_state SET usage_review_required=true',
          );
        else
          await db.pool.query(
            'UPDATE task_outcome_coverage SET recovery_pending=true',
          );
        await expect(verify()).rejects.toMatchObject({
          code:
            hold === 'usage'
              ? 'deletion_usage_review_required'
              : 'deletion_recovery_required',
        });
        expect(ready).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        const rejected = run();
        expect(rejected.status).toBe(1);
        expect(rejected.stdout).toBe('');
        expect(rejected.stderr).toContain(
          hold === 'usage'
            ? 'deletion_usage_review_required'
            : 'deletion_recovery_required',
        );
      },
    );
    it('does not access the database or storage after an already-aborted request', async () => {
      const controller = new AbortController();
      controller.abort(new Error('Synthetic preflight cancellation.'));
      const schema = vi.spyOn(db, 'assertSchemaReady');
      const ready = vi.spyOn(storage, 'assertReady');
      await expect(
        db.verifyRecordingMedia(storage, controller.signal),
      ).rejects.toThrow('Synthetic preflight cancellation.');
      expect(schema).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
    });
    it('cancels an in-flight object read through its composed bounded signal', async () => {
      const source = await fixture();
      await source.add();
      const controller = new AbortController();
      let markOpened!: (signal: AbortSignal) => void;
      const opened = new Promise<AbortSignal>((resolve) => {
        markOpened = resolve;
      });
      vi.spyOn(storage, 'read').mockImplementation(
        (_object, _size, signal) =>
          new Promise<Buffer>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
            markOpened(signal);
          }),
      );
      const pending = db.verifyRecordingMedia(storage, controller.signal);
      const outcome = expect(pending).rejects.toThrow(
        'Synthetic in-flight cancellation.',
      );
      const readSignal = await opened;
      expect(readSignal).not.toBe(controller.signal);
      controller.abort(new Error('Synthetic in-flight cancellation.'));
      await outcome;
      expect(readSignal.aborted).toBe(true);
    });
    it('does not substitute an empty report for failed storage preflight', async () => {
      const failure = new Error('Synthetic private-storage preflight failure.');
      vi.spyOn(storage, 'assertReady').mockRejectedValue(failure);
      const read = vi.spyOn(storage, 'read');
      await expect(verify()).rejects.toBe(failure);
      expect(read).not.toHaveBeenCalled();
    });
    it('does not report success when cancellation arrives during transaction completion', async () => {
      const source = await fixture();
      await source.add();
      const controller = new AbortController();
      const original = db.transaction.bind(db);
      vi.spyOn(db, 'transaction').mockImplementation(
        async <T>(operation: (tx: Transaction) => Promise<T>): Promise<T> => {
          const value = await original(operation);
          controller.abort(new Error('Synthetic commit cancellation.'));
          return value;
        },
      );
      await expect(
        db.verifyRecordingMedia(storage, controller.signal),
      ).rejects.toThrow('Synthetic commit cancellation.');
    });
    it.each([
      'recording',
      'track',
      'undeclared_track',
      'sequence',
      'samples',
      'object_chunk',
      'object_kind',
      'object_deleted',
      'descriptor',
      'binding_hash',
    ] as const)(
      'refuses inconsistent %s metadata before fetching its object',
      async (damage) => {
        const source = await fixture(),
          object = await source.add();
        const read = vi.spyOn(storage, 'read');
        if (damage === 'object_chunk')
          await db.pool.query(
            'UPDATE recording_objects SET chunk_id=$2 WHERE id=$1',
            [object.object.id, randomUUID()],
          );
        else if (damage === 'undeclared_track')
          await db.pool.query(
            `UPDATE recordings SET tracks=jsonb_set(tracks,'{0,spec,track_id}',to_jsonb($2::text)) WHERE id=$1`,
            [source.id, randomUUID()],
          );
        else if (damage === 'object_kind')
          await db.pool.query(
            "UPDATE recording_objects SET kind='staging' WHERE id=$1",
            [object.object.id],
          );
        else if (damage === 'object_deleted')
          await db.pool.query(
            'UPDATE recording_objects SET deleted_at=now() WHERE id=$1',
            [object.object.id],
          );
        else if (damage === 'samples')
          await db.pool.query(
            'UPDATE recording_chunks SET sample_count=2 WHERE id=$1',
            [object.upload.chunk.chunk_id],
          );
        else if (damage === 'binding_hash')
          await db.pool.query(
            'UPDATE recording_chunks SET request_hash=$2 WHERE id=$1',
            [object.upload.chunk.chunk_id, '0'.repeat(64)],
          );
        else {
          const descriptor = structuredClone(object.upload);
          if (damage === 'recording')
            descriptor.chunk.recording_id = randomUUID();
          else if (damage === 'track') descriptor.chunk.track_id = randomUUID();
          else if (damage === 'sequence') descriptor.chunk.sequence = 1;
          const value =
            damage === 'descriptor'
              ? { ...descriptor, privateMarker }
              : descriptor;
          await db.pool.query(
            'UPDATE recording_chunks SET descriptor=$2,request_hash=$3 WHERE id=$1',
            [
              object.upload.chunk.chunk_id,
              JSON.stringify(value),
              createHash('sha256').update(canonicalJson(value)).digest('hex'),
            ],
          );
        }
        await expect(verify()).rejects.toMatchObject({
          code: 'recording_media_metadata_invalid',
        });
        expect(read).not.toHaveBeenCalled();
      },
    );
    it.each(['expired', 'revoked', 'deleted', 'pending'] as const)(
      'does not fetch %s audio or claim that it was verified',
      async (state) => {
        const source = await fixture(),
          object = await source.add();
        if (state === 'expired')
          await db.pool.query(
            "UPDATE recordings SET retention_expires_at=now()-interval '1 second' WHERE id=$1",
            [source.id],
          );
        else if (state === 'revoked')
          await db.pool.query(
            'UPDATE memberships SET active=false WHERE user_id=$1',
            [source.actor.user_id],
          );
        else if (state === 'deleted')
          await db.deleteDocument(source.actor.user_id, source.document.id);
        else
          await db.pool.query(
            "UPDATE recording_chunks SET state='pending',verified_object=NULL WHERE id=$1",
            [object.upload.chunk.chunk_id],
          );
        const read = vi.spyOn(storage, 'read');
        expect(await verify()).toMatchObject({
          verified_chunks: '0',
          verified_bytes: '0',
        });
        expect(read).not.toHaveBeenCalled();
      },
    );
    it('runs the actual deployment CLI and reports missing media as failure, never an empty success', async () => {
      const source = await fixture(),
        object = await source.add();
      const accepted = run();
      expect(accepted.error).toBeUndefined();
      expect(accepted.status).toBe(0);
      expect(
        recordingMediaVerificationSchema.parse(JSON.parse(accepted.stdout)),
      ).toMatchObject({
        verified_chunks: '1',
        verified_bytes: String(wav.length),
      });
      await storage.remove(object.object, signal());
      const missing = run();
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('recording_media_integrity_failed');
      for (const value of [
        privateMarker,
        source.id,
        object.object.id,
        bucket,
        config.endpoint,
      ])
        expect(missing.stderr).not.toContain(value);
    });
    it('requires configured recording storage even when the database inventory is empty', () => {
      const rejected = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../../packages/db/dist/cli.js', import.meta.url),
          ),
          'audio-verify',
        ],
        {
          env: { NODE_ENV: 'test', DATABASE_URL: scopedUrl },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('recording_storage_required');
    });
    it.each([
      ['--limit', '1'],
      ['--user-id', '00000000-0000-4000-8000-000000000001'],
      ['--by-kind'],
      ['--restored-backup'],
    ])('refuses inappropriate CLI options %j', (...args) => {
      const rejected = run(...args);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr.length).toBeGreaterThan(0);
    });
  },
);
