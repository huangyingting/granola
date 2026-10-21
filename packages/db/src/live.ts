import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { livePcmFrameSchema } from '@windows-ai-notes/contracts';
import {
  liveSourceSchema,
  type LiveSource,
} from '@windows-ai-notes/contracts/realtime';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { resourceId, ServiceError } from '@windows-ai-notes/contracts/server';
import type { Database, Transaction } from './index.js';

export const LIVE_MEDIA_MS = 60_000;
export const LIVE_LEASE_MS = 15_000;
const startSchema = z.strictObject({
  source: liveSourceSchema,
  locale: z.enum(['en-US', 'zh-CN']),
  provider: z.enum(['azure', 'fixture']),
  configurationVersion: z.string().min(1).max(200),
  consent: z.literal(true),
});
export type LiveStart = z.infer<typeof startSchema>;
const claimSchema = z.strictObject({
  id: resourceId,
  ownerId: resourceId,
  documentId: resourceId,
  leaseToken: resourceId,
  source: liveSourceSchema,
});
export type LiveClaim = z.infer<typeof claimSchema>;
const cursorSchema = z
  .strictObject({
    sequence: livePcmFrameSchema.shape.sequence,
    sample_start: livePcmFrameSchema.shape.sample_start,
    frame_count: z.number().int().min(1).max(10),
  })
  .refine(
    (value) =>
      value.sample_start + value.frame_count * 800 <= 230_400_000 &&
      value.sequence + value.frame_count <= 288_001,
  );
export type LiveCursor = z.infer<typeof cursorSchema>;
interface SourceRow extends LiveSource {
  id: string;
  document_id: string;
  next_sample: number | null;
  next_sequence: number | null;
}
interface LeaseRow {
  id: string;
  source_id: string;
  owner_id: string;
  document_id: string;
  lease_token: string;
  request_hash: string;
  locale: 'en-US' | 'zh-CN';
  provider: 'azure' | 'fixture';
  configuration_version: string;
  accepted_samples: number;
  valid: boolean;
  dispatched: boolean;
  source: LiveSource;
}
const lost = () =>
  new ServiceError(
    'live_lease_lost',
    'This live source lease is unavailable, expired or no longer authorized.',
    409,
  );
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(
      'invalid_live_request',
      'Use valid live source metadata and explicit live-cloud consent.',
      400,
    );
  return parsed.data;
}
function claim(row: LeaseRow): LiveClaim {
  return claimSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    documentId: row.document_id,
    leaseToken: row.lease_token,
    source: row.source,
  });
}
const sameSource = (left: LiveSource, right: LiveSource) =>
  left.recording_id === right.recording_id &&
  left.preview_id === right.preview_id &&
  left.track_id === right.track_id &&
  left.capture_epoch === right.capture_epoch;
const leaseQuery = `SELECT l.*,jsonb_build_object('recording_id',s.recording_id,'preview_id',s.preview_id,
 'track_id',s.track_id,'capture_epoch',s.capture_epoch) source,
 l.closed_at IS NULL AND l.lease_until>clock_timestamp() AND l.deadline>clock_timestamp()
 AND l.access_expires_at>clock_timestamp() AND m.active AND u.active
 AND m.sync_epoch=l.membership_epoch AND u.live_access_epoch=l.user_epoch valid,
 EXISTS (SELECT 1 FROM ai_usage_calls c WHERE c.live_lease_id=l.id) dispatched
 FROM live_leases l JOIN live_sources s ON s.id=l.source_id
 JOIN documents d ON d.id=l.document_id AND d.owner_id=l.owner_id
 JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=l.owner_id
 JOIN users u ON u.id=l.owner_id`;

export class LiveSourceStore {
  constructor(private readonly database: Database) {}

  async open(
    owner: string,
    document: string,
    value: LiveStart,
    key: string,
    accessExpiresAt: number,
    transaction?: Transaction,
  ): Promise<LiveClaim> {
    parse(resourceId, owner);
    parse(resourceId, document);
    parse(resourceId, key);
    const input = parse(startSchema, value);
    const expiry = parse(
      z.number().int().positive().max(8_640_000_000_000_000),
      accessExpiresAt,
    );
    const hash = createHash('sha256')
      .update(canonicalJson({ document, ...input }))
      .digest('hex');
    const open = async (tx: Transaction) => {
      const doc = await this.database.lockDocument(owner, document, tx);
      const epochs = (
        await tx.query<{ membership: number; user: number; allowed: boolean }>(
          `SELECT m.sync_epoch membership,u.live_access_epoch "user",$3::timestamptz>clock_timestamp() allowed
         FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.active AND u.active FOR SHARE OF m,u`,
          [doc.workspace_id, owner, new Date(expiry)],
        )
      ).rows[0];
      if (!epochs?.allowed)
        throw new ServiceError(
          'live_auth_expired',
          'A current authorized access token is required for live recognition.',
          401,
        );
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `live-sources:${owner}`,
      ]);
      await tx.query(
        `UPDATE live_leases l SET closed_at=clock_timestamp(),close_code='expired'
        FROM live_sources s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_id
        JOIN users u ON u.id=s.owner_id WHERE s.id=l.source_id AND l.owner_id=$1 AND l.closed_at IS NULL AND
        (l.lease_until<=clock_timestamp() OR l.deadline<=clock_timestamp() OR l.access_expires_at<=clock_timestamp()
          OR l.membership_epoch<>m.sync_epoch OR l.user_epoch<>u.live_access_epoch OR NOT m.active OR NOT u.active)`,
        [owner],
      );
      const previous = (
        await tx.query<LeaseRow>(
          `${leaseQuery} WHERE l.owner_id=$1 AND l.request_key=$2`,
          [owner, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ServiceError(
            'idempotency_conflict',
            'This live request key is bound to different input.',
            409,
          );
        if (!previous.valid) throw lost();
        return claim(previous);
      }
      const counts = (
        await tx.query<{ active: number; recent: number }>(
          `SELECT count(*) FILTER (WHERE closed_at IS NULL)::int active,
         count(*) FILTER (WHERE created_at>clock_timestamp()-interval '1 minute')::int recent
         FROM live_leases WHERE owner_id=$1 AND (closed_at IS NULL OR created_at>clock_timestamp()-interval '1 minute')`,
          [owner],
        )
      ).rows[0]!;
      if (counts.active >= 2)
        throw new ServiceError(
          'live_sources_busy',
          'At most two live sources can be active for this account.',
          429,
          true,
        );
      if (counts.recent >= 12)
        throw new ServiceError(
          'live_rate_limited',
          'At most twelve new live source attempts are allowed per account per minute.',
          429,
          true,
        );
      const selected = input.source;
      if (
        (
          await tx.query(
            'SELECT id FROM live_sources WHERE owner_id=$1 AND recording_id=$2 AND document_id<>$3 LIMIT 1',
            [owner, selected.recording_id, document],
          )
        ).rowCount
      )
        throw new ServiceError(
          'live_source_conflict',
          'This native recording is bound to a different document.',
          409,
        );
      let source = (
        await tx.query<SourceRow>(
          `SELECT * FROM live_sources WHERE owner_id=$1 AND recording_id=$2 AND preview_id=$3 AND track_id=$4 AND capture_epoch=$5 FOR KEY SHARE`,
          [
            owner,
            selected.recording_id,
            selected.preview_id,
            selected.track_id,
            selected.capture_epoch,
          ],
        )
      ).rows[0];
      if (!source) {
        const retained = (
          await tx.query<{ count: number }>(
            'SELECT count(*)::int count FROM live_sources WHERE owner_id=$1',
            [owner],
          )
        ).rows[0]!.count;
        if (retained >= 5000)
          throw new ServiceError(
            'live_source_limit',
            'This account reached its retained live source metadata limit.',
            429,
          );
        source = (
          await tx.query<SourceRow>(
            `INSERT INTO live_sources
          (id,owner_id,document_id,workspace_id,recording_id,preview_id,track_id,capture_epoch)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              randomUUID(),
              owner,
              document,
              doc.workspace_id,
              selected.recording_id,
              selected.preview_id,
              selected.track_id,
              selected.capture_epoch,
            ],
          )
        ).rows[0]!;
      }
      if (
        (
          await tx.query(
            'SELECT id FROM live_leases WHERE source_id=$1 AND closed_at IS NULL',
            [source.id],
          )
        ).rowCount
      )
        throw new ServiceError(
          'live_source_busy',
          'This source already has a live recognition attempt.',
          409,
        );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO live_leases
        (id,source_id,owner_id,document_id,lease_token,request_key,request_hash,locale,provider,configuration_version,
         membership_epoch,user_epoch,access_expires_at,lease_until,deadline,created_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
          least($13::timestamptz,clock_timestamp()+interval '15 seconds'),clock_timestamp()+interval '80 seconds',clock_timestamp()
        WHERE $13::timestamptz>clock_timestamp()`,
        [
          id,
          source.id,
          owner,
          document,
          randomUUID(),
          key,
          hash,
          input.locale,
          input.provider,
          input.configurationVersion,
          epochs.membership,
          epochs.user,
          new Date(expiry),
        ],
      );
      await tx.query(
        'UPDATE live_sources SET updated_at=clock_timestamp() WHERE id=$1',
        [source.id],
      );
      const row = (
        await tx.query<LeaseRow>(`${leaseQuery} WHERE l.id=$1`, [id])
      ).rows[0];
      if (!row)
        throw new ServiceError(
          'live_auth_expired',
          'The live access token expired before source authorization completed.',
          401,
        );
      return claim(row);
    };
    return transaction ? open(transaction) : this.database.transaction(open);
  }

  async authorize(
    value: LiveClaim,
    transaction?: Transaction,
  ): Promise<LeaseRow> {
    const selected = parse(claimSchema, value);
    const check = async (tx: Transaction) => {
      await this.database.lockDocument(
        selected.ownerId,
        selected.documentId,
        tx,
      );
      const locked = (
        await tx.query<LeaseRow>(
          `${leaseQuery} WHERE l.id=$1 AND l.owner_id=$2 AND l.document_id=$3
        FOR UPDATE OF l FOR SHARE OF m,u`,
          [selected.id, selected.ownerId, selected.documentId],
        )
      ).rows[0];
      if (
        !locked ||
        locked.lease_token !== selected.leaseToken ||
        !sameSource(locked.source, selected.source)
      )
        throw lost();
      const row = (
        await tx.query<LeaseRow>(`${leaseQuery} WHERE l.id=$1`, [selected.id])
      ).rows[0];
      if (!row?.valid) throw lost();
      await tx.query(
        `UPDATE live_leases SET lease_until=least(access_expires_at,deadline,clock_timestamp()+interval '15 seconds')
        WHERE id=$1`,
        [selected.id],
      );
      return row;
    };
    return transaction ? check(transaction) : this.database.transaction(check);
  }

  async accept(
    value: LiveClaim,
    cursor: LiveCursor,
    transaction?: Transaction,
  ) {
    const input = parse(cursorSchema, cursor);
    const accept = async (tx: Transaction) => {
      const lease = await this.authorize(value, tx);
      if (!lease.dispatched)
        throw new ServiceError(
          'live_not_reserved',
          'Reserve this authorized live attempt before accepting media.',
          409,
        );
      const source = (
        await tx.query<SourceRow>(
          'SELECT * FROM live_sources WHERE id=$1 FOR UPDATE',
          [lease.source_id],
        )
      ).rows[0];
      if (!source) throw lost();
      const samples = input.frame_count * 800;
      if (lease.accepted_samples + samples > LIVE_MEDIA_MS * 16)
        throw new ServiceError(
          'live_media_limit',
          'Finish this bounded live attempt before accepting additional media.',
          409,
        );
      const previous = source.next_sample;
      if (
        previous !== null &&
        (input.sample_start < previous ||
          (lease.accepted_samples > 0 && input.sample_start !== previous) ||
          input.sample_start - previous !==
            (input.sequence - (source.next_sequence ?? 0)) * 800)
      )
        throw new ServiceError(
          'live_frame_discontinuity',
          'Live media cannot replay, rewind or silently skip a source cursor.',
          409,
        );
      await tx.query(
        `UPDATE live_sources SET next_sample=$2,next_sequence=$3,updated_at=clock_timestamp() WHERE id=$1`,
        [
          source.id,
          input.sample_start + samples,
          input.sequence + input.frame_count,
        ],
      );
      await tx.query(
        'UPDATE live_leases SET accepted_samples=accepted_samples+$2 WHERE id=$1',
        [lease.id, samples],
      );
      return {
        accepted_samples: lease.accepted_samples + samples,
        gap:
          previous !== null && input.sample_start > previous
            ? { sample_start: previous, sample_end: input.sample_start }
            : null,
      };
    };
    return transaction
      ? accept(transaction)
      : this.database.transaction(accept);
  }

  async close(
    value: LiveClaim,
    reason: 'cancelled' | 'failed' = 'cancelled',
  ): Promise<{ state: 'closed' | 'unavailable' }> {
    const selected = parse(claimSchema, value);
    parse(z.enum(['cancelled', 'failed']), reason);
    const result = await this.database.pool.query(
      `UPDATE live_leases l SET closed_at=coalesce(closed_at,clock_timestamp()),
      close_code=coalesce(close_code,$6) FROM live_sources s WHERE s.id=l.source_id AND l.id=$1 AND l.owner_id=$2
      AND l.document_id=$3 AND l.lease_token=$4 AND s.recording_id=$5::uuid AND s.preview_id=$7::uuid
      AND s.track_id=$8::uuid AND s.capture_epoch=$9::uuid RETURNING l.id`,
      [
        selected.id,
        selected.ownerId,
        selected.documentId,
        selected.leaseToken,
        selected.source.recording_id,
        reason,
        selected.source.preview_id,
        selected.source.track_id,
        selected.source.capture_epoch,
      ],
    );
    return { state: result.rowCount ? 'closed' : 'unavailable' };
  }

  async prune(tx: Transaction) {
    await tx.query(`UPDATE live_leases SET closed_at=clock_timestamp(),close_code='expired'
      WHERE id IN (SELECT id FROM live_leases WHERE closed_at IS NULL AND
        (lease_until<=clock_timestamp() OR deadline<=clock_timestamp() OR access_expires_at<=clock_timestamp())
        FOR UPDATE SKIP LOCKED LIMIT 100)`);
    await tx.query(`DELETE FROM live_leases WHERE id IN (SELECT id FROM live_leases
      WHERE closed_at IS NOT NULL AND created_at<clock_timestamp()-interval '7 days' FOR UPDATE SKIP LOCKED LIMIT 100)`);
    await tx.query(`DELETE FROM live_sources s WHERE s.id IN (SELECT p.id FROM live_sources p
      WHERE p.updated_at<clock_timestamp()-interval '7 days' AND NOT EXISTS (SELECT 1 FROM live_leases l WHERE l.source_id=p.id)
      FOR UPDATE SKIP LOCKED LIMIT 100)`);
  }
}
