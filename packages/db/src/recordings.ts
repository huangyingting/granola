import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import {
  createRecordingSchema,
  recordingSealSchema,
  registerChunkSchema,
  remoteChunkSchema,
  remoteRecordingSchema,
  MAX_RECORDING_CHUNKS,
  type CreateRecording,
  type RecordingSeal,
  type RemoteRecording,
  type RemoteChunk,
} from '@windows-ai-notes/contracts/uploads';
import type { UploadChunk } from '@windows-ai-notes/contracts';
import type { Database, Transaction } from './index.js';

export const UPLOAD_LIFETIME_MS = 300_000;
export interface RecordingObject {
  id: string;
  kind: 'staging' | 'verified';
}
interface Row {
  id: string;
  document_id: string;
  owner_id: string;
  tracks: unknown;
  source_created_at: Date;
  create_hash: string;
  create_key: string;
  seal: unknown | null;
  seal_hash: string | null;
  seal_key: string | null;
  deleted_at: Date | null;
}
interface ChunkRow {
  id: string;
  recording_id: string;
  descriptor: unknown;
  request_hash: string;
  state: RemoteChunk['state'];
  verified_object: string | null;
  verification_token: number;
  verification_until: Date | null;
}
export interface Verification {
  chunkId: string;
  recordingId: string;
  token: number;
  upload: UploadChunk;
  staging: RecordingObject;
  candidate: RecordingObject;
}
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const unavailable = () =>
  new ServiceError(
    'recording_not_found',
    'The recording is unavailable or not accessible.',
    404,
  );
const immutable = () =>
  new ServiceError(
    'recording_sealed',
    'This recording structure is frozen and cannot be changed.',
    409,
  );
const conflict = () =>
  new ServiceError(
    'idempotency_conflict',
    'This key or immutable identifier is bound to different input.',
    409,
  );

export class RecordingStore {
  constructor(private readonly database: Database) {}

  private async access(
    user: string,
    id: string,
    tx: Transaction,
  ): Promise<Row> {
    const source = (
      await tx.query<{ document_id: string }>(
        'SELECT document_id FROM recordings WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',
        [id, user],
      )
    ).rows[0];
    if (!source) throw unavailable();
    await this.database.document(user, source.document_id, tx);
    const row = (
      await tx.query<Row>(
        'SELECT * FROM recordings WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [id, user],
      )
    ).rows[0];
    if (!row) throw unavailable();
    return row;
  }
  private async chunkAccess(user: string, id: string, tx: Transaction) {
    const source = (
      await tx.query<{ recording_id: string }>(
        'SELECT recording_id FROM recording_chunks WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!source) throw unavailable();
    const recording = await this.access(user, source.recording_id, tx);
    const chunk = (
      await tx.query<ChunkRow>(
        'SELECT * FROM recording_chunks WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!chunk) throw unavailable();
    return { recording, chunk };
  }
  private async snapshot(row: Row, tx: Transaction): Promise<RemoteRecording> {
    const count = (
      await tx.query<{ total: number; verified: number }>(
        `SELECT count(*)::int total,count(*) FILTER (WHERE state='verified')::int verified
       FROM recording_chunks WHERE recording_id=$1`,
        [row.id],
      )
    ).rows[0]!;
    const seal = row.seal === null ? null : recordingSealSchema.parse(row.seal);
    return remoteRecordingSchema.parse({
      id: row.id,
      document_id: row.document_id,
      created_at: row.source_created_at.toISOString(),
      tracks: row.tracks,
      state: seal
        ? count.total === count.verified
          ? 'ready'
          : 'sealed_pending'
        : 'uploading',
      partial: seal?.accept_incomplete ?? false,
      seal_sha256: row.seal_hash,
      chunk_count: count.total,
      verified_chunks: count.verified,
    });
  }
  async create(
    user: string,
    document: string,
    value: CreateRecording,
    key: string,
  ) {
    const input = createRecordingSchema.parse(value);
    return this.database.transaction(async (tx) => {
      const doc = await this.database.document(user, document, tx);
      const digest = hash(input);
      const existing = (
        await tx.query<Row>(
          'SELECT * FROM recordings WHERE document_id=$1 AND create_key=$2',
          [document, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.create_hash !== digest) throw conflict();
        if (existing.deleted_at) throw unavailable();
        return this.snapshot(existing, tx);
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `recording-budget:${user}`,
      ]);
      const count = (
        await tx.query<{ count: number }>(
          'SELECT count(*)::int count FROM recordings WHERE owner_id=$1 AND deleted_at IS NULL',
          [user],
        )
      ).rows[0]!.count;
      if (count >= 100)
        throw new ServiceError(
          'quota_exceeded',
          'At most 100 retained remote recordings are allowed per user.',
          429,
        );
      const inserted = (
        await tx.query<Row>(
          `INSERT INTO recordings(id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *`,
          [
            input.id,
            document,
            doc.workspace_id,
            user,
            input.created_at,
            JSON.stringify(input.tracks),
            key,
            digest,
          ],
        )
      ).rows[0];
      if (!inserted) throw conflict();
      return this.snapshot(inserted, tx);
    });
  }
  async get(user: string, id: string) {
    return this.database.transaction(async (tx) =>
      this.snapshot(await this.access(user, id, tx), tx),
    );
  }
  async list(user: string, document: string, offset: number) {
    return this.database.transaction(async (tx) => {
      await this.database.document(user, document, tx);
      const rows = (
        await tx.query<Row>(
          'SELECT * FROM recordings WHERE document_id=$1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 51 OFFSET $2',
          [document, offset],
        )
      ).rows;
      return {
        recordings: await Promise.all(
          rows.slice(0, 50).map((row) => this.snapshot(row, tx)),
        ),
        has_more: rows.length > 50,
      };
    });
  }
  async register(
    user: string,
    id: string,
    value: UploadChunk,
    key: string,
  ): Promise<RemoteChunk> {
    const upload = registerChunkSchema.parse(value);
    return this.database.transaction(async (tx) => {
      const recording = await this.access(user, id, tx);
      const source = createRecordingSchema.parse({
        id,
        created_at: recording.source_created_at.toISOString(),
        tracks: recording.tracks,
      });
      if (
        upload.chunk.recording_id !== id ||
        !source.tracks.some((t) => t.spec.track_id === upload.chunk.track_id)
      )
        throw new ServiceError(
          'invalid_track',
          'The chunk does not belong to a declared recording track.',
          400,
        );
      const digest = hash(upload);
      const existing = (
        await tx.query<ChunkRow>(
          'SELECT * FROM recording_chunks WHERE recording_id=$1 AND (id=$2 OR request_key=$3)',
          [id, upload.chunk.chunk_id, key],
        )
      ).rows;
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0]!.id !== upload.chunk.chunk_id ||
          existing[0]!.request_hash !== digest
        )
          throw conflict();
        return remoteChunkSchema.parse({
          upload: existing[0]!.descriptor,
          state: existing[0]!.state,
        });
      }
      if (recording.seal !== null) throw immutable();
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `recording-budget:${user}`,
      ]);
      const budget = (
        await tx.query<{ count: number; bytes: string }>(
          `SELECT count(*)::int count,coalesce(sum(c.sample_count::bigint*2+44),0)::text bytes
           FROM recording_chunks c JOIN recordings r ON r.id=c.recording_id
           WHERE r.owner_id=$1 AND r.deleted_at IS NULL`,
          [user],
        )
      ).rows[0]!;
      if (
        budget.count >= MAX_RECORDING_CHUNKS ||
        Number(budget.bytes) + upload.size_bytes > 5 * 1024 * 1024 * 1024
      )
        throw new ServiceError(
          'quota_exceeded',
          'Retained remote audio is limited to 5 GiB and 10,000 chunks per user. Delete unneeded remote audio before uploading more.',
          429,
        );
      const count = (
        await tx.query<{ count: number }>(
          'SELECT count(*)::int count FROM recording_chunks WHERE recording_id=$1',
          [id],
        )
      ).rows[0]!.count;
      if (count >= MAX_RECORDING_CHUNKS)
        throw new ServiceError(
          'quota_exceeded',
          'The recording reached its supported chunk count.',
          429,
        );
      const c = upload.chunk;
      const overlap = await tx.query(
        `SELECT 1 FROM recording_chunks WHERE recording_id=$1 AND track_id=$2
         AND sample_start < $3 AND sample_start+sample_count > $4`,
        [id, c.track_id, c.sample_start + c.sample_count, c.sample_start],
      );
      if (overlap.rowCount)
        throw new ServiceError(
          'chunk_overlap',
          'Declared track samples cannot overlap.',
          409,
        );
      const result = await tx.query(
        `INSERT INTO recording_chunks(id,recording_id,track_id,sequence,sample_start,sample_count,descriptor,request_key,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          c.chunk_id,
          id,
          c.track_id,
          c.sequence,
          c.sample_start,
          c.sample_count,
          JSON.stringify(upload),
          key,
          digest,
        ],
      );
      if (!result.rowCount) throw conflict();
      return { upload, state: 'pending' };
    });
  }
  async chunk(user: string, id: string): Promise<RemoteChunk> {
    return this.database.transaction(async (tx) => {
      const { chunk } = await this.chunkAccess(user, id, tx);
      return remoteChunkSchema.parse({
        upload: chunk.descriptor,
        state: chunk.state,
      });
    });
  }
  async chunks(user: string, id: string, offset: number) {
    return this.database.transaction(async (tx) => {
      await this.access(user, id, tx);
      const rows = (
        await tx.query<ChunkRow>(
          'SELECT * FROM recording_chunks WHERE recording_id=$1 ORDER BY track_id,sequence LIMIT 51 OFFSET $2',
          [id, offset],
        )
      ).rows;
      return {
        chunks: rows.slice(0, 50).map((row) =>
          remoteChunkSchema.parse({
            upload: row.descriptor,
            state: row.state,
          }),
        ),
        has_more: rows.length > 50,
      };
    });
  }
  async transcriptionSource(
    user: string,
    id: string,
    sealHash: string,
    tx: Transaction,
  ) {
    const row = await this.access(user, id, tx);
    const snapshot = await this.snapshot(row, tx);
    if (snapshot.state !== 'ready' || row.seal_hash !== sealHash)
      throw new ServiceError(
        'recording_incomplete',
        'The requested immutable recording seal is not ready.',
        409,
        true,
      );
    const seal = recordingSealSchema.parse(row.seal);
    if (!seal.tracks.some((track) => track.end_sample > 0))
      throw new ServiceError(
        'empty_audio',
        'This recording contains no audio to transcribe.',
        400,
      );
    return { ...snapshot, seal };
  }
  async seal(user: string, id: string, value: RecordingSeal, key: string) {
    const seal = recordingSealSchema.parse(value);
    return this.database.transaction(async (tx) => {
      const recording = await this.access(user, id, tx);
      const digest = hash(seal);
      if (recording.seal_hash !== null) {
        if (recording.seal_key === key && recording.seal_hash !== digest)
          throw conflict();
        if (recording.seal_hash !== digest) throw immutable();
        return this.snapshot(recording, tx);
      }
      const source = createRecordingSchema.parse({
        id,
        created_at: recording.source_created_at.toISOString(),
        tracks: recording.tracks,
      });
      if (
        source.tracks.length !== seal.tracks.length ||
        source.tracks.some(
          (t) => !seal.tracks.some((s) => s.track_id === t.spec.track_id),
        )
      )
        throw new ServiceError(
          'invalid_track',
          'Seal exactly the declared recording tracks.',
          400,
        );
      const rows = (
        await tx.query<ChunkRow>(
          'SELECT * FROM recording_chunks WHERE recording_id=$1',
          [id],
        )
      ).rows;
      const byId = new Map(
        rows.map((row) => [row.id, registerChunkSchema.parse(row.descriptor)]),
      );
      if (
        rows.length !==
        seal.tracks.reduce((sum, t) => sum + t.chunk_ids.length, 0)
      )
        throw new ServiceError(
          'recording_incomplete',
          'Register every expected chunk and include every registered chunk before sealing.',
          409,
          true,
        );
      for (const track of seal.tracks) {
        let position = 0;
        for (const [sequence, chunkId] of track.chunk_ids.entries()) {
          const c = byId.get(chunkId)?.chunk;
          if (
            !c ||
            c.track_id !== track.track_id ||
            c.sequence !== sequence ||
            c.sample_start !== position
          )
            throw new ServiceError(
              'recording_incomplete',
              'The frozen chunks must describe contiguous, ordered track samples.',
              409,
              true,
            );
          position += c.sample_count;
        }
        if (position !== track.end_sample)
          throw new ServiceError(
            'recording_incomplete',
            'A declared track end does not match its expected chunks.',
            409,
            true,
          );
      }
      await tx.query(
        'UPDATE recordings SET seal=$2,seal_hash=$3,seal_key=$4 WHERE id=$1',
        [id, JSON.stringify(seal), digest, key],
      );
      return this.snapshot(
        { ...recording, seal, seal_hash: digest, seal_key: key },
        tx,
      );
    });
  }
  async authorizeUpload(user: string, id: string, key: string) {
    return this.database.transaction(async (tx) => {
      const { recording, chunk } = await this.chunkAccess(user, id, tx);
      if (chunk.state === 'verified') return null;
      let object = (
        await tx.query<{ id: string; upload_expires: Date }>(
          `SELECT id,upload_expires FROM recording_objects WHERE chunk_id=$1 AND kind='staging' AND request_key=$2`,
          [id, key],
        )
      ).rows[0];
      if (!object) {
        await this.objectBudget(tx, id, user);
        const expires = new Date(Date.now() + UPLOAD_LIFETIME_MS);
        const until = new Date(expires.getTime() + 60_000);
        object = (
          await tx.query<{ id: string; upload_expires: Date }>(
            `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,request_key,upload_expires,protected_until,cleanup_after)
           VALUES ($1,$2,$3,'staging',$4,$5,$6,$6) RETURNING id,upload_expires`,
            [randomUUID(), recording.id, id, key, expires, until],
          )
        ).rows[0]!;
      }
      const expires = object.upload_expires;
      if (expires.getTime() <= Date.now())
        throw new ServiceError(
          'upload_expired',
          'Request fresh upload authorization with a new idempotency key.',
          409,
          true,
        );
      return {
        object: { id: object.id, kind: 'staging' as const },
        expires,
        upload: registerChunkSchema.parse(chunk.descriptor),
      };
    });
  }
  private async objectBudget(tx: Transaction, chunk: string, user: string) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `recording-budget:${user}`,
    ]);
    const active = (
      await tx.query<{ count: number }>(
        `SELECT count(*)::int count FROM recording_objects o JOIN recordings r ON r.id=o.recording_id
       WHERE r.owner_id=$1 AND o.protected_until>now() AND o.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM recording_chunks c WHERE c.verified_object=o.id)`,
        [user],
      )
    ).rows[0]!.count;
    if (active >= 256)
      throw new ServiceError(
        'quota_exceeded',
        'At most 256 temporary recording objects may be live per user. Retry after upload authorization expires.',
        429,
        true,
      );
    const count = (
      await tx.query<{ count: number }>(
        "SELECT count(*)::int count FROM recording_objects WHERE chunk_id=$1 AND created_at>now()-interval '1 hour'",
        [chunk],
      )
    ).rows[0]!.count;
    if (count >= 32)
      throw new ServiceError(
        'quota_exceeded',
        'Too many upload or verification attempts for this chunk. Retry after one hour.',
        429,
        true,
      );
  }
  async beginVerification(
    user: string,
    id: string,
    uploadId: string,
    key: string,
  ): Promise<Verification | null> {
    return this.database.transaction(async (tx) => {
      const { recording, chunk } = await this.chunkAccess(user, id, tx);
      const prior = (
        await tx.query<{ upload_id: string }>(
          'SELECT upload_id FROM recording_completions WHERE chunk_id=$1 AND request_key=$2',
          [id, key],
        )
      ).rows[0];
      if (prior && prior.upload_id !== uploadId) throw conflict();
      const staging = (
        await tx.query<{
          id: string;
          protected_until: Date;
          deleted_at: Date | null;
        }>(
          `SELECT id,protected_until,deleted_at FROM recording_objects
         WHERE id=$1 AND chunk_id=$2 AND recording_id=$3 AND kind='staging'`,
          [uploadId, id, recording.id],
        )
      ).rows[0];
      if (!staging)
        throw new ServiceError(
          'upload_not_found',
          'The upload does not belong to this audio chunk.',
          404,
        );
      if (!prior) {
        const count = (
          await tx.query<{ count: number }>(
            'SELECT count(*)::int count FROM recording_completions WHERE chunk_id=$1',
            [id],
          )
        ).rows[0]!.count;
        if (count >= 64)
          throw new ServiceError(
            'quota_exceeded',
            'This chunk exhausted its completion-key budget.',
            429,
          );
        await tx.query(
          'INSERT INTO recording_completions(chunk_id,request_key,upload_id) VALUES ($1,$2,$3)',
          [id, key, uploadId],
        );
      }
      if (chunk.state === 'verified') return null;
      if (staging.deleted_at || staging.protected_until.getTime() <= Date.now())
        throw new ServiceError(
          'upload_expired',
          'This upload is unavailable. Request fresh authorization and retry.',
          409,
          true,
        );
      if (
        chunk.state === 'checking' &&
        chunk.verification_until &&
        chunk.verification_until.getTime() > Date.now()
      )
        throw new ServiceError(
          'verification_pending',
          'A bounded integrity check is already in progress.',
          409,
          true,
        );
      await this.objectBudget(tx, id, user);
      const candidate = { id: randomUUID(), kind: 'verified' as const };
      await tx.query(
        `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,protected_until,cleanup_after)
         VALUES ($1,$2,$3,'verified',now()+interval '5 minutes',now()+interval '5 minutes')`,
        [candidate.id, recording.id, id],
      );
      await tx.query(
        `UPDATE recording_objects SET protected_until=greatest(protected_until,now()+interval '3 minutes'),
         cleanup_after=greatest(cleanup_after,now()+interval '3 minutes') WHERE id=$1`,
        [uploadId],
      );
      const token = (
        await tx.query<{ verification_token: number }>(
          `UPDATE recording_chunks SET state='checking',verification_token=verification_token+1,
         verification_until=now()+interval '2 minutes' WHERE id=$1 RETURNING verification_token`,
          [id],
        )
      ).rows[0]!.verification_token;
      return {
        chunkId: id,
        recordingId: recording.id,
        token,
        upload: registerChunkSchema.parse(chunk.descriptor),
        staging: { id: uploadId, kind: 'staging' },
        candidate,
      };
    });
  }
  async finishVerification(user: string, lease: Verification) {
    return this.database.transaction(async (tx) => {
      const { chunk } = await this.chunkAccess(user, lease.chunkId, tx);
      const result = await tx.query(
        `UPDATE recording_chunks SET state='verified',verified_object=$3,verification_until=NULL
         WHERE id=$1 AND state='checking' AND verification_token=$2 AND verification_until>now()
         AND EXISTS (SELECT 1 FROM recording_objects o WHERE o.id=$3 AND o.recording_id=recording_chunks.recording_id
           AND o.kind='verified' AND o.deleted_at IS NULL)`,
        [chunk.id, lease.token, lease.candidate.id],
      );
      if (!result.rowCount)
        throw new ServiceError(
          'verification_superseded',
          'This verification attempt lost its lease. Retry from the current chunk state.',
          409,
          true,
        );
      return remoteChunkSchema.parse({
        upload: chunk.descriptor,
        state: 'verified',
      });
    });
  }
  async failVerification(lease: Verification) {
    await this.database.pool.query(
      `UPDATE recording_chunks SET state='pending',verification_until=NULL
       WHERE id=$1 AND state='checking' AND verification_token=$2`,
      [lease.chunkId, lease.token],
    );
  }
  private async erase(tx: Transaction, id: string) {
    await this.database.recordingTranscriptions.eraseRecording(tx, id);
    await tx.query(
      "UPDATE recordings SET deleted_at=coalesce(deleted_at,now()),tracks='[]'::jsonb,seal=NULL,seal_hash=NULL,seal_key=NULL WHERE id=$1",
      [id],
    );
    await tx.query('DELETE FROM recording_chunks WHERE recording_id=$1', [id]);
    await tx.query(
      'UPDATE recording_objects SET cleanup_after=least(cleanup_after,protected_until) WHERE recording_id=$1',
      [id],
    );
  }
  async remove(user: string, id: string) {
    await this.database.transaction(async (tx) => {
      const row = (
        await tx.query<Row>(
          'SELECT * FROM recordings WHERE id=$1 AND owner_id=$2',
          [id, user],
        )
      ).rows[0];
      if (!row) throw unavailable();
      await this.database.document(user, row.document_id, tx);
      if (row.deleted_at) return;
      await this.access(user, id, tx);
      await this.erase(tx, id);
    });
  }
  async removeExpected(user: string, document: string, id: string) {
    await this.database.transaction(async (tx) => {
      const doc = await this.database.document(user, document, tx);
      const row = (
        await tx.query<Row>('SELECT * FROM recordings WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (row && (row.document_id !== document || row.owner_id !== user))
        throw unavailable();
      if (!row) {
        const inserted = await tx.query(
          `INSERT INTO recordings
          (id,document_id,workspace_id,owner_id,source_created_at,tracks,create_key,create_hash,deleted_at)
          VALUES ($1,$2,$3,$4,now(),'[]'::jsonb,$5,$6,now()) ON CONFLICT DO NOTHING`,
          [
            id,
            document,
            doc.workspace_id,
            user,
            `deleted:${id}`,
            hash({ id, document, deleted: true }),
          ],
        );
        if (!inserted.rowCount) throw unavailable();
      } else await this.erase(tx, id);
    });
  }
  async removeDocument(tx: Transaction, document: string) {
    const rows = (
      await tx.query<{ id: string }>(
        'SELECT id FROM recordings WHERE document_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE',
        [document],
      )
    ).rows;
    for (const row of rows) await this.erase(tx, row.id);
  }
  async deletion(user: string, id: string) {
    const row = (
      await this.database.pool.query<{ pending: number; errors: number }>(
        `SELECT count(o.id) FILTER (WHERE o.deleted_at IS NULL)::int pending,
       count(o.id) FILTER (WHERE o.last_error IS NOT NULL)::int errors FROM recordings r
       JOIN documents d ON d.id=r.document_id
       JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=r.owner_id AND m.active
       JOIN users u ON u.id=r.owner_id AND u.active
       LEFT JOIN recording_objects o ON o.recording_id=r.id
       WHERE r.id=$1 AND r.owner_id=$2 AND r.deleted_at IS NOT NULL GROUP BY r.id`,
        [id, user],
      )
    ).rows[0];
    if (!row) throw unavailable();
    return {
      state:
        row.pending || row.errors ? 'cleanup_pending' : 'cleanup_confirmed',
      pending_objects: row.pending,
      cleanup_errors: row.errors,
      repeated_cleanup: true,
    };
  }
  async claimCleanup(): Promise<(RecordingObject & { token: number })[]> {
    return this.database.transaction(async (tx) => {
      const revoked = (
        await tx.query<{ id: string }>(
          `SELECT r.id FROM recordings r JOIN documents d ON d.id=r.document_id
         JOIN memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_id JOIN users u ON u.id=r.owner_id
         WHERE r.deleted_at IS NULL AND (d.deleted_at IS NOT NULL OR NOT m.active OR NOT u.active)
         ORDER BY r.id LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,
        )
      ).rows;
      for (const row of revoked) await this.erase(tx, row.id);
      return (
        await tx.query<RecordingObject & { token: number }>(
          `WITH eligible AS (
          SELECT o.id FROM recording_objects o JOIN recordings r ON r.id=o.recording_id
          WHERE o.protected_until<=now() AND o.cleanup_after<=now() AND (o.cleanup_until IS NULL OR o.cleanup_until<now())
          AND (o.kind='staging' OR r.deleted_at IS NOT NULL OR NOT EXISTS
            (SELECT 1 FROM recording_chunks c WHERE c.verified_object=o.id))
          ORDER BY o.cleanup_after,o.id LIMIT 20 FOR UPDATE OF o SKIP LOCKED
        ) UPDATE recording_objects o SET cleanup_token=cleanup_token+1,cleanup_until=now()+interval '2 minutes'
          FROM eligible e WHERE o.id=e.id RETURNING o.id,o.kind,o.cleanup_token token`,
        )
      ).rows;
    });
  }
  async finishCleanup(
    object: RecordingObject & { token: number },
    success: boolean,
  ) {
    await this.database.pool.query(
      `UPDATE recording_objects SET cleanup_until=NULL,
       deleted_at=CASE WHEN $3 THEN coalesce(deleted_at,now()) ELSE deleted_at END,
       last_error=CASE WHEN $3 THEN NULL ELSE 'object_cleanup_failed' END,
       cleanup_after=now()+CASE WHEN $3 THEN interval '1 hour' ELSE interval '1 minute' END
       WHERE id=$1 AND cleanup_token=$2 AND cleanup_until>now()`,
      [object.id, object.token, success],
    );
  }
}
