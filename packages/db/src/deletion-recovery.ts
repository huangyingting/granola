import {
  deletionIntentSchema,
  deletionArchiveHeadSchema,
  type DeletionIntent,
  type DeletionOrigin,
  type DeletionArchiveHead,
} from '@windows-ai-notes/contracts/deletion';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { digest, type Database, type Transaction } from './index.js';
import type { DeletionArchivePublisher } from './deletion-publication.js';

function invalid(message: string): never {
  throw new ServiceError('deletion_recovery_invalid', message, 503);
}
async function apply(db: Database, tx: Transaction, entry: DeletionIntent) {
  const id = entry.resource_id;
  switch (entry.event) {
    case 'document_erased':
      await db.eraseDocument(tx, id);
      break;
    case 'recording_erased':
      if (
        (
          await tx.query(
            'SELECT 1 FROM recordings WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
            [id],
          )
        ).rowCount
      )
        await db.recordings.erase(tx, id, entry.reason ?? 'user');
      break;
    case 'recording_expiry_bound':
      await tx.query(
        'UPDATE recordings SET retention_expires_at=least(retention_expires_at,$2) WHERE id=$1 AND deleted_at IS NULL AND retention_expires_at>$2',
        [id, entry.expires_at],
      );
      break;
    case 'workspace_retention_bound':
      await tx.query(
        `UPDATE workspaces SET audio_retention_days=least(audio_retention_days,$2),
        audio_processing_days=least(audio_processing_days,$3) WHERE id=$1
        AND (audio_retention_days>$2 OR audio_processing_days>$3)`,
        [id, entry.retention_days, entry.processing_days],
      );
      await tx.query(
        `UPDATE recordings SET retention_days=least(retention_days,$2),
        retention_expires_at=least(retention_expires_at,
          coalesce(canonical_transcript_at,retention_started_at)+
          CASE WHEN canonical_transcript_at IS NULL THEN $3 ELSE $2 END * interval '24 hours')
        WHERE workspace_id=$1 AND deleted_at IS NULL`,
        [id, entry.retention_days, entry.processing_days],
      );
      break;
    case 'account_revoked':
      await tx.query('UPDATE users SET active=false WHERE id=$1 AND active', [
        id,
      ]);
      break;
    case 'membership_revoked':
      await tx.query(
        'UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2 AND active',
        [id, entry.workspace_id],
      );
      break;
    case 'workspace_erased': {
      const documents = (
        await tx.query<{ id: string }>(
          'SELECT id FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE',
          [id],
        )
      ).rows;
      for (const document of documents) await db.eraseDocument(tx, document.id);
      await tx.query(
        'UPDATE memberships SET active=false WHERE workspace_id=$1 AND active',
        [id],
      );
      await tx.query("UPDATE workspaces SET name='[deleted]' WHERE id=$1", [
        id,
      ]);
      break;
    }
    case 'chat_thread_erased':
      await tx.query('DELETE FROM chat_threads WHERE id=$1', [id]);
      break;
    case 'chat_turn_erased':
      await tx.query('DELETE FROM chat_turns WHERE id=$1', [id]);
      break;
    case 'job_erased':
      await tx.query('DELETE FROM jobs WHERE id=$1', [id]);
      break;
    case 'job_audio_erased':
      await tx.query(
        `UPDATE jobs SET audio=NULL,
        state=CASE WHEN state IN ('queued','running','retry_wait') THEN 'cancelled' ELSE state END,
        lease_token=lease_token+1,lease_until=NULL WHERE id=$1 AND audio IS NOT NULL`,
        [id],
      );
      break;
    case 'staging_object_erased':
    case 'verified_object_erased': {
      if (entry.event === 'verified_object_erased') {
        const object = (
          await tx.query<{ recording_id: string }>(
            'SELECT recording_id FROM recording_objects WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (object)
          await db.recordingTranscriptions.eraseRecording(
            tx,
            object.recording_id,
          );
        await tx.query(
          'DELETE FROM recording_chunks WHERE verified_object=$1',
          [id],
        );
      }
      await tx.query('DELETE FROM recording_completions WHERE upload_id=$1', [
        id,
      ]);
      await tx.query(
        `UPDATE recording_objects SET cleanup_token=cleanup_token+1,cleanup_until=NULL,
        cleanup_after=least(cleanup_after,protected_until) WHERE id=$1`,
        [id],
      );
      break;
    }
  }
}

export async function recoverDeletions(
  db: Database,
  publisher: DeletionArchivePublisher,
  origin: DeletionOrigin,
  signal: AbortSignal,
  restoredBackup: boolean,
): Promise<void> {
  const tx = await db.pool.connect();
  let locked = false,
    staged = false;
  try {
    locked = (
      await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('windows-ai-notes-deletion-recovery',0)) locked",
      )
    ).rows[0]!.locked;
    if (!locked)
      throw new ServiceError(
        'deletion_recovery_busy',
        'Another process is verifying deletion recovery. Keep this service offline and retry.',
        503,
        true,
      );
    if (restoredBackup)
      await tx.query(
        `WITH held AS (
          UPDATE deletion_recovery_state SET usage_review_required=true,usage_proof_sha256=NULL,completed_at=NULL
          RETURNING singleton
        ) UPDATE task_outcome_coverage SET recovery_pending=true
          WHERE singleton AND EXISTS(SELECT 1 FROM held)`,
      );
    const binding = (
      await tx.query<{
        deployment_id: string;
        archive_identity: string;
        baseline_tip: string;
        baseline_generation: string;
        baseline_entry_references: string;
      }>(`SELECT deployment_id,archive_identity,baseline_tip,baseline_generation::text,baseline_entry_references::text
       FROM deletion_archive_binding WHERE singleton`)
    ).rows[0];
    if (
      !binding ||
      binding.archive_identity !== publisher.identity ||
      binding.deployment_id !== origin.deployment_id
    )
      invalid(
        'The independent archive binding is missing or does not match. Never initialize a restored database.',
      );
    const latest = (
      await tx.query<{
        tip: string;
        generation: string;
        entry_references: string;
      }>(
        `SELECT tip,generation::text,entry_references::text FROM (
          SELECT tip,generation,entry_references FROM deletion_publications
          UNION ALL SELECT verified_tip,verified_generation,verified_entry_references
          FROM deletion_recovery_state WHERE verified_tip IS NOT NULL
        ) witnesses ORDER BY witnesses.generation DESC LIMIT 1`,
      )
    ).rows[0];
    const witness: DeletionArchiveHead = deletionArchiveHeadSchema.parse({
      version: 1,
      origin,
      tip:
        latest &&
        BigInt(latest.generation) >= BigInt(binding.baseline_generation)
          ? latest.tip
          : binding.baseline_tip,
      generation:
        latest &&
        BigInt(latest.generation) >= BigInt(binding.baseline_generation)
          ? latest.generation
          : binding.baseline_generation,
      entry_references:
        latest &&
        BigInt(latest.generation) >= BigInt(binding.baseline_generation)
          ? latest.entry_references
          : binding.baseline_entry_references,
    });
    await publisher.assertReady(signal);
    await tx.query(
      'CREATE TEMP TABLE deletion_restore_intents(id uuid PRIMARY KEY,sha256 text NOT NULL,intent jsonb NOT NULL)',
    );
    staged = true;
    for (let pass = 0; pass < 3; pass++) {
      signal.throwIfAborted();
      await tx.query('TRUNCATE pg_temp.deletion_restore_intents');
      let references = 0;
      const snapshot = await publisher.verify(
        origin,
        async (batch) => {
          references += batch.entries.length;
          if (references > 1_000_000)
            invalid(
              'Deletion recovery exceeds its bounded inventory. Keep services offline.',
            );
          const result = await tx.query(
            `INSERT INTO pg_temp.deletion_restore_intents(id,sha256,intent)
          SELECT id,sha256,intent FROM unnest($1::uuid[],$2::text[],$3::jsonb[]) entries(id,sha256,intent)
          ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256
          WHERE deletion_restore_intents.sha256=excluded.sha256 RETURNING id`,
            [
              batch.entries.map((entry) => entry.id),
              batch.entries.map((entry) => digest(entry, true)),
              batch.entries.map((entry) => JSON.stringify(entry)),
            ],
          );
          if (result.rowCount !== batch.entries.length)
            invalid('An archived intent ID has conflicting metadata.');
        },
        signal,
        1_000_000,
        witness,
      );
      if (
        (
          await tx.query(`SELECT 1 FROM pg_temp.deletion_restore_intents s JOIN deletion_receipts r ON r.intent_id=s.id
        WHERE r.sha256<>s.sha256 LIMIT 1`)
        ).rowCount
      )
        invalid(
          'Primary recovery receipts conflict with independent archival metadata.',
        );
      if (
        (
          await tx.query(
            `SELECT 1 FROM deletion_receipts r JOIN deletion_publications p ON p.id=r.publication_id
        LEFT JOIN pg_temp.deletion_restore_intents s ON s.id=r.intent_id
        WHERE s.id IS NULL AND p.generation<=$1 LIMIT 1`,
            [snapshot.generation],
          )
        ).rowCount
      )
        invalid(
          'Independent archival history is missing a previously applied intent.',
        );
      const missing = (
        await tx.query(`SELECT 1 FROM pg_temp.deletion_restore_intents s
        LEFT JOIN deletion_receipts r ON r.intent_id=s.id WHERE r.intent_id IS NULL LIMIT 1`)
      ).rowCount;
      if (missing)
        await tx.query(
          `WITH held AS (
            UPDATE deletion_recovery_state SET usage_review_required=true,usage_proof_sha256=NULL,completed_at=NULL
            RETURNING singleton
          ) UPDATE task_outcome_coverage SET recovery_pending=true
            WHERE singleton AND EXISTS(SELECT 1 FROM held)`,
        );
      let cursor: string | null = null;
      for (;;) {
        signal.throwIfAborted();
        const rows: { id: string; intent: unknown }[] = (
          await tx.query<{ id: string; intent: unknown }>(
            `SELECT s.id,s.intent FROM pg_temp.deletion_restore_intents s LEFT JOIN deletion_receipts r ON r.intent_id=s.id
           WHERE r.intent_id IS NULL AND ($1::uuid IS NULL OR s.id>$1) ORDER BY s.id LIMIT 100`,
            [cursor],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) {
          signal.throwIfAborted();
          const entry = deletionIntentSchema.parse(row.intent);
          await db.transaction(async (current) => {
            const receipt = (
              await current.query<{ sha256: string }>(
                'SELECT sha256 FROM deletion_receipts WHERE intent_id=$1',
                [entry.id],
              )
            ).rows[0];
            if (receipt) {
              if (receipt.sha256 !== digest(entry, true))
                invalid('A replayed intent conflicts with its receipt.');
              return;
            }
            if (
              (
                await current.query(
                  'SELECT 1 FROM deletion_journal WHERE id=$1',
                  [entry.id],
                )
              ).rowCount
            )
              invalid(
                'A captured intent has no matching receipt in a bound database.',
              );
            await current.query(
              `INSERT INTO deletion_journal
              (id,transaction_id,recorded_at,event,resource_id,workspace_id,expires_at,retention_days,processing_days,reason)
              VALUES($1,$2::xid8,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                entry.id,
                entry.transaction_id,
                entry.recorded_at,
                entry.event,
                entry.resource_id,
                entry.workspace_id,
                entry.expires_at,
                entry.retention_days,
                entry.processing_days,
                entry.reason,
              ],
            );
            await apply(db, current, entry);
          });
        }
        cursor = rows.at(-1)!.id;
      }
      let pending = false;
      const completed = await publisher.verify(
        origin,
        async (batch) => {
          const receipts = (
            await tx.query<{ intent_id: string; sha256: string }>(
              'SELECT intent_id,sha256 FROM deletion_receipts WHERE intent_id=ANY($1::uuid[])',
              [batch.entries.map((entry) => entry.id)],
            )
          ).rows;
          for (const entry of batch.entries) {
            const receipt = receipts.find((row) => row.intent_id === entry.id);
            if (!receipt) pending = true;
            else if (receipt.sha256 !== digest(entry, true))
              invalid(
                'Final recovery receipts conflict with archival metadata.',
              );
          }
        },
        signal,
        1_000_000,
        witness,
      );
      if (pending) continue;
      await tx.query(
        `WITH completed AS (
          UPDATE deletion_recovery_state SET verified_tip=$1,verified_generation=$2,
            verified_entry_references=$3,completed_at=clock_timestamp() RETURNING singleton
        ) UPDATE task_outcome_coverage SET observed_since=clock_timestamp(),recovery_pending=false
          WHERE singleton AND recovery_pending AND EXISTS(SELECT 1 FROM completed)`,
        [completed.tip, completed.generation, completed.entry_references],
      );
      return;
    }
    throw new ServiceError(
      'deletion_recovery_busy',
      'Archival history changed during recovery. Stop all old writers and retry before exposing services.',
      503,
      true,
    );
  } finally {
    let reusable = false;
    try {
      if (staged) await tx.query('DROP TABLE pg_temp.deletion_restore_intents');
      if (locked)
        await tx.query(
          "SELECT pg_advisory_unlock(hashtextextended('windows-ai-notes-deletion-recovery',0))",
        );
      reusable = true;
    } finally {
      tx.release(!reusable);
    }
  }
}
