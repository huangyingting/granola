import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resourceId, ServiceError } from '@windows-ai-notes/contracts/server';
import {
  recordingTrackSchema,
  registerChunkSchema,
} from '@windows-ai-notes/contracts/uploads';
import { recordingMediaVerificationSchema } from '@windows-ai-notes/contracts/operations';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import type { RecordingBlobs } from '@windows-ai-notes/storage';
import type { Database } from './index.js';

export type RecordingMediaReader = Pick<RecordingBlobs, 'assertReady' | 'read'>;
const sourceSchema = z.strictObject({
  id: z.uuid(),
  recording_id: resourceId,
  track_id: z.uuid(),
  sequence: z.number().int().nonnegative(),
  sample_start: z.string().regex(/^(0|[1-9][0-9]*)$/),
  sample_count: z.number().int().positive(),
  descriptor: registerChunkSchema,
  tracks: z.array(recordingTrackSchema).min(1).max(2),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  object_id: resourceId,
  object_chunk_id: z.uuid(),
  object_kind: z.literal('verified'),
  object_deleted_at: z.null(),
});
const metadataFailure = () =>
  new ServiceError(
    'recording_media_metadata_invalid',
    'Retained verified media metadata is inconsistent. Keep restored services offline and inspect the backup inventory.',
    409,
  );
const integrityFailure = () =>
  new ServiceError(
    'recording_media_integrity_failed',
    'Retained verified recording media is missing or differs from its immutable size or SHA-256. Keep restored services offline and repair the media restore.',
    409,
  );

export async function verifyRecordingMedia(
  database: Database,
  storage: RecordingMediaReader,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await database.assertSchemaReady();
  const report = await database.transaction(async (tx) => {
    await tx.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    await database.deletions.assertUsageReady(tx);
    const clock = z
      .strictObject({
        snapshot_at: z.iso.datetime({ precision: 6 }),
        recovery_pending: z.boolean(),
      })
      .parse(
        (
          await tx.query(
            `SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') snapshot_at,
       recovery_pending FROM task_outcome_coverage WHERE singleton`,
          )
        ).rows[0],
      );
    if (clock.recovery_pending)
      throw new ServiceError(
        'deletion_recovery_required',
        'Complete independent deletion recovery and usage review before verifying restored recording media.',
        409,
      );
    signal.throwIfAborted();
    await storage.assertReady();
    let cursor: string | null = null;
    let chunks = 0n,
      bytes = 0n;
    while (true) {
      signal.throwIfAborted();
      const page = (
        await tx.query(
          `SELECT c.id,c.recording_id,c.track_id,c.sequence,c.sample_start::text,c.sample_count,c.descriptor,c.request_hash,r.tracks,
         c.verified_object object_id,o.chunk_id object_chunk_id,o.kind object_kind,o.deleted_at object_deleted_at
         FROM recording_chunks c JOIN recordings r ON r.id=c.recording_id
         JOIN documents d ON d.id=r.document_id
         JOIN users u ON u.id=r.owner_id AND u.active
         JOIN memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_id AND m.active
         LEFT JOIN recording_objects o ON o.id=c.verified_object AND o.recording_id=r.id
         WHERE c.state='verified' AND r.deleted_at IS NULL AND d.deleted_at IS NULL
         AND r.retention_expires_at>transaction_timestamp() AND ($1::uuid IS NULL OR c.id>$1)
         ORDER BY c.id LIMIT 128`,
          [cursor],
        )
      ).rows;
      for (const raw of page) {
        signal.throwIfAborted();
        const parsed = sourceSchema.safeParse(raw);
        if (!parsed.success) throw metadataFailure();
        const source = parsed.data;
        const upload = source.descriptor,
          chunk = upload.chunk;
        if (
          chunk.chunk_id.toLowerCase() !== source.id ||
          chunk.recording_id.toLowerCase() !== source.recording_id ||
          chunk.track_id.toLowerCase() !== source.track_id ||
          !source.tracks.some(
            (track) => track.spec.track_id.toLowerCase() === source.track_id,
          ) ||
          chunk.sequence !== source.sequence ||
          String(chunk.sample_start) !== source.sample_start ||
          chunk.sample_count !== source.sample_count ||
          source.object_chunk_id !== source.id ||
          createHash('sha256').update(canonicalJson(upload)).digest('hex') !==
            source.request_hash
        )
          throw metadataFailure();
        let body: Buffer;
        try {
          body = await storage.read(
            { id: source.object_id, kind: 'verified' },
            upload.size_bytes,
            AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          );
        } catch (error) {
          if (
            error instanceof ServiceError &&
            ['upload_missing', 'checksum_mismatch'].includes(error.code)
          )
            throw integrityFailure();
          throw error;
        }
        try {
          signal.throwIfAborted();
          if (
            body.length !== upload.size_bytes ||
            createHash('sha256').update(body).digest('hex') !== upload.sha256
          )
            throw integrityFailure();
          chunks++;
          bytes += BigInt(body.length);
        } finally {
          body.fill(0);
        }
        cursor = source.id;
      }
      if (page.length < 128) break;
    }
    signal.throwIfAborted();
    return recordingMediaVerificationSchema.parse({
      version: 1,
      scope: 'retained_verified_recording_chunks',
      basis: 'immutable_upload_size_and_sha256',
      snapshot_at: clock.snapshot_at,
      verified_chunks: chunks.toString(),
      verified_bytes: bytes.toString(),
    });
  });
  signal.throwIfAborted();
  return report;
}
