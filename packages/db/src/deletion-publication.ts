import { randomUUID } from 'node:crypto';
import {
  deletionArchiveHeadSchema,
  deletionIntentSchema,
  deletionOriginSchema,
  type DeletionArchiveHead,
  type DeletionBatch,
  type DeletionIntent,
  type DeletionOrigin,
} from '@windows-ai-notes/contracts/deletion';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { digest, type Database, type Transaction } from './index.js';
import { recoverDeletions } from './deletion-recovery.js';

export interface DeletionArchivePublisher {
  readonly identity: string;
  assertReady(signal: AbortSignal): Promise<void>;
  initialize(
    origin: DeletionOrigin,
    signal: AbortSignal,
    fresh?: boolean,
  ): Promise<DeletionArchiveHead>;
  append(
    batch: DeletionBatch,
    signal: AbortSignal,
  ): Promise<DeletionArchiveHead>;
  verify(
    origin: DeletionOrigin,
    visit: (batch: DeletionBatch, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    maxLinks?: number,
    required?: DeletionArchiveHead,
  ): Promise<DeletionArchiveHead>;
}
type IntentRow = Omit<DeletionIntent, 'recorded_at' | 'expires_at'> & {
  recorded_at: Date;
  expires_at: Date | null;
};
const columns = `id,transaction_id::text,recorded_at,event,resource_id,workspace_id,
  expires_at,retention_days,processing_days,reason`;
function unavailable(code: string, message: string): never {
  throw new ServiceError(code, message, 503);
}
function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    unavailable(
      'deletion_journal_invalid',
      'Deletion recovery metadata contains an unsupported timestamp.',
    );
  return value.toISOString();
}
function intent(row: IntentRow): DeletionIntent {
  const parsed = deletionIntentSchema.safeParse({
    ...row,
    recorded_at: timestamp(row.recorded_at),
    expires_at: row.expires_at ? timestamp(row.expires_at) : null,
  });
  if (!parsed.success)
    unavailable(
      'deletion_journal_invalid',
      'Deletion recovery metadata is invalid. No source changes were committed.',
    );
  return parsed.data;
}
function head(value: unknown, origin: DeletionOrigin): DeletionArchiveHead {
  const parsed = deletionArchiveHeadSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.origin.deployment_id !== origin.deployment_id ||
    parsed.data.origin.initialized_at !== origin.initialized_at
  )
    unavailable(
      'deletion_archive_invalid',
      'Independent deletion publication returned invalid lineage or metadata.',
    );
  return parsed.data;
}

export class DeletionPublications {
  private readonly shutdown = new AbortController();
  private recovered = false;
  private recovering: Promise<void> | undefined;
  constructor(
    private readonly db: Database,
    private readonly publisher?: DeletionArchivePublisher,
  ) {
    if (
      publisher &&
      (publisher.identity.length !== 64 ||
        !/^[0-9a-f]{64}$/.test(publisher.identity))
    )
      throw new Error(
        'Independent deletion storage requires a stable identity.',
      );
  }
  private async origin(tx: Transaction): Promise<DeletionOrigin> {
    const row = (
      await tx.query<{ deployment_id: string; initialized_at: Date }>(
        'SELECT deployment_id,initialized_at FROM deletion_recovery_origin WHERE singleton',
      )
    ).rows[0];
    const parsed = deletionOriginSchema.safeParse(
      row && {
        deployment_id: row.deployment_id,
        initialized_at: timestamp(row.initialized_at),
      },
    );
    if (!parsed.success)
      unavailable(
        'deletion_origin_invalid',
        'A valid deletion recovery origin is required.',
      );
    return parsed.data;
  }
  private async publish(
    tx: Transaction,
    origin: DeletionOrigin,
    rows: IntentRow[],
    scope: string | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.publisher)
      unavailable(
        'deletion_archive_required',
        'Configure independent deletion storage before changing retained data.',
      );
    const batch: DeletionBatch = {
      version: 1,
      id: randomUUID(),
      origin,
      entries: rows.map(intent),
    };
    const acknowledged = head(
      await this.publisher.append(batch, signal),
      origin,
    );
    if (
      acknowledged.generation === '0' ||
      BigInt(acknowledged.entry_references) < BigInt(batch.entries.length)
    )
      unavailable(
        'deletion_archive_invalid',
        'Independent deletion publication did not acknowledge the batch.',
      );
    await tx.query(
      `INSERT INTO deletion_publications(id,scope,tip,generation,entry_references)
       VALUES($1,$2,$3,$4,$5)`,
      [
        batch.id,
        scope,
        acknowledged.tip,
        acknowledged.generation,
        acknowledged.entry_references,
      ],
    );
    await tx.query(
      `INSERT INTO deletion_receipts(intent_id,sha256,publication_id)
       SELECT id,sha256,$3 FROM unnest($1::uuid[],$2::text[]) AS entries(id,sha256)`,
      [
        batch.entries.map((entry) => entry.id),
        batch.entries.map((entry) => digest(entry, true)),
        batch.id,
      ],
    );
    return acknowledged;
  }
  async initialize(signal: AbortSignal): Promise<DeletionArchiveHead> {
    const publisher = this.publisher;
    if (!publisher)
      unavailable(
        'deletion_archive_required',
        'Configure independent deletion storage before initialization.',
      );
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
    await publisher.assertReady(bounded);
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('windows-ai-notes-deletion-binding',0))",
      );
      await tx.query('LOCK TABLE deletion_journal IN SHARE ROW EXCLUSIVE MODE');
      if ((await tx.query('SELECT 1 FROM deletion_archive_binding')).rowCount)
        unavailable(
          'deletion_archive_already_bound',
          'The deployment is already bound. Do not initialize restored databases.',
        );
      const count = (
        await tx.query<{ count: string }>(
          'SELECT count(*)::text count FROM deletion_journal',
        )
      ).rows[0]!.count;
      if (BigInt(count) > 1_000_000n)
        unavailable(
          'deletion_baseline_too_large',
          'The deletion baseline exceeds the bounded initialization inventory.',
        );
      const origin = await this.origin(tx);
      let acknowledged = head(
        await publisher.initialize(origin, bounded, true),
        origin,
      );
      if (
        acknowledged.generation !== '0' ||
        acknowledged.entry_references !== '0'
      )
        unavailable(
          'deletion_archive_invalid',
          'Fresh deletion initialization requires a zero-entry genesis.',
        );
      let cursor: string | null = null;
      for (let page = 0; page <= 10_000; page++) {
        bounded.throwIfAborted();
        const rows: IntentRow[] = (
          await tx.query<IntentRow>(
            `SELECT ${columns} FROM deletion_journal
             WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 100`,
            [cursor],
          )
        ).rows;
        if (!rows.length) break;
        acknowledged = await this.publish(tx, origin, rows, null, bounded);
        cursor = rows.at(-1)!.id;
        if (page === 10_000)
          unavailable(
            'deletion_baseline_too_large',
            'The deletion baseline changed beyond its bounded inventory.',
          );
      }
      await tx.query(
        `INSERT INTO deletion_archive_binding
         (deployment_id,archive_identity,baseline_tip,baseline_generation,baseline_entry_references)
         VALUES($1,$2,$3,$4,$5)`,
        [
          origin.deployment_id,
          publisher.identity,
          acknowledged.tip,
          acknowledged.generation,
          acknowledged.entry_references,
        ],
      );
      return acknowledged;
    });
  }
  async beforeCommit(tx: Transaction, scope: string): Promise<void> {
    if (!this.publisher) return;
    const binding = (
      await tx.query<{ archive_identity: string }>(
        'SELECT archive_identity FROM deletion_archive_binding WHERE singleton',
      )
    ).rows[0];
    if (!binding) return;
    const rows = (
      await tx.query<IntentRow>(
        `SELECT ${columns} FROM deletion_journal
         WHERE publication_scope=$1 ORDER BY id LIMIT 10001`,
        [scope],
      )
    ).rows;
    if (!rows.length) return;
    if (binding.archive_identity !== this.publisher.identity)
      unavailable(
        'deletion_archive_binding_mismatch',
        'Independent deletion storage does not match the deployment binding.',
      );
    if (rows.length > 10_000)
      unavailable(
        'deletion_publication_too_large',
        'The deletion exceeds the bounded recovery transaction size. No source changes were committed.',
      );
    const origin = await this.origin(tx),
      bounded = AbortSignal.timeout(30_000);
    try {
      for (let offset = 0; offset < rows.length; offset += 100)
        await this.publish(
          tx,
          origin,
          rows.slice(offset, offset + 100),
          scope,
          bounded,
        );
    } catch (error) {
      if (bounded.aborted)
        throw new ServiceError(
          'deletion_publication_timed_out',
          'Independent deletion publication timed out. No source changes were acknowledged; retry safely.',
          503,
          true,
        );
      throw error;
    }
  }
  close() {
    this.shutdown.abort();
    this.recovered = false;
  }
  async assertUsageReady(tx?: Transaction) {
    const state = (
      await (tx ?? this.db.pool).query<{ usage_review_required: boolean }>(
        'SELECT usage_review_required FROM deletion_recovery_state WHERE singleton',
      )
    ).rows[0];
    if (!state)
      unavailable(
        'deletion_recovery_state_missing',
        'Deletion recovery state is missing. Keep services offline.',
      );
    if (state.usage_review_required)
      unavailable(
        'deletion_usage_review_required',
        'Restore recovery requires authoritative provider-usage reconciliation. No missing usage was assumed to be zero. Complete deployment-only review before exposing services.',
      );
  }
  private async replay(signal: AbortSignal, restoredBackup: boolean) {
    this.recovered = false;
    if (!this.publisher)
      unavailable(
        'deletion_archive_required',
        'Configure independent deletion storage to recover a bound database.',
      );
    const bounded = AbortSignal.any([
      signal,
      this.shutdown.signal,
      AbortSignal.timeout(300_000),
    ]);
    const tx = await this.db.pool.connect();
    let origin: DeletionOrigin;
    try {
      origin = await this.origin(tx);
    } finally {
      tx.release();
    }
    await recoverDeletions(
      this.db,
      this.publisher,
      origin,
      bounded,
      restoredBackup,
    );
  }
  async recover(signal: AbortSignal, restoredBackup = false) {
    await this.replay(signal, restoredBackup);
    await this.assertUsageReady();
    this.recovered = true;
  }
  async reviewUsage(proof: string, signal: AbortSignal) {
    if (!this.publisher || proof.length !== 64 || !/^[0-9a-f]{64}$/.test(proof))
      unavailable(
        'invalid_usage_review',
        'Supply independent archive configuration and a lowercase SHA-256 proof of completed provider-usage reconciliation.',
      );
    const reviewed = (
      await this.db.pool.query<{
        verified_tip: string;
        verified_generation: string;
      }>(
        `SELECT verified_tip,verified_generation::text FROM deletion_recovery_state
        WHERE singleton AND usage_review_required AND completed_at IS NOT NULL`,
      )
    ).rows[0];
    if (!reviewed)
      unavailable(
        'invalid_usage_review',
        'Complete verified restore replay and actual usage reconciliation before attesting its proof.',
      );
    await this.replay(signal, false);
    signal.throwIfAborted();
    await this.db.transaction(async (tx) => {
      const binding = (
        await tx.query<{ archive_identity: string }>(
          'SELECT archive_identity FROM deletion_archive_binding',
        )
      ).rows[0];
      if (binding?.archive_identity !== this.publisher?.identity)
        unavailable(
          'deletion_archive_binding_mismatch',
          'Usage review requires the bound independent archive.',
        );
      const result = await tx.query(
        `UPDATE deletion_recovery_state SET usage_review_required=false,usage_proof_sha256=$1
        WHERE singleton AND usage_review_required AND completed_at IS NOT NULL
        AND verified_tip=$2 AND verified_generation=$3`,
        [proof, reviewed.verified_tip, reviewed.verified_generation],
      );
      if (!result.rowCount)
        unavailable(
          'invalid_usage_review',
          'Verified recovery changed during usage review. Reconcile the new recovery state before attesting its proof.',
        );
    });
    await this.assertUsageReady();
    this.recovered = true;
  }
  async assertExposureReady(signal: AbortSignal = this.shutdown.signal) {
    const bound = (
      await this.db.pool.query('SELECT 1 FROM deletion_archive_binding')
    ).rowCount;
    if (!this.publisher && bound)
      unavailable(
        'deletion_archive_required',
        'This database requires its bound independent archive. Keep services offline.',
      );
    if (!this.publisher) return;
    if (!bound)
      unavailable(
        'deletion_archive_uninitialized',
        'Initialize a fresh deployment with the deployment CLI. Never initialize restored databases.',
      );
    if (!this.recovered) {
      this.recovering ??= this.recover(signal).finally(() => {
        this.recovering = undefined;
      });
      await this.recovering;
    }
    await this.assertUsageReady();
  }
}
