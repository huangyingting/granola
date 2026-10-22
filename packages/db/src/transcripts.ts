import {
  ServiceError,
  TRANSCRIPT_PAGE_SIZE,
  makeTranscriptPage,
  segmentSchema,
  segmentsSchema,
  storedSegmentsSchema,
  transcriptHeaderSchema,
  transcriptTimelineEntrySchema,
  transcriptTimelinePageSchema,
} from '@windows-ai-notes/contracts/server';
import type { z } from 'zod';
import type { Segment } from '@windows-ai-notes/contracts/server';
import { digest, type Database, type Transaction } from './index.js';
import { recordChange } from './sync.js';

export class TranscriptStore {
  constructor(private readonly database: Database) {}

  async header(
    user: string,
    id: string,
    version?: number,
    tx?: Transaction,
  ): Promise<z.infer<typeof transcriptHeaderSchema> & { text_bytes: number }> {
    const doc = await this.database.document(user, id, tx);
    const selected = version ?? doc.transcript_revision;
    if (selected === 0)
      return {
        document_id: id,
        revision: 0,
        source: 'none' as const,
        total_segments: 0,
        text_bytes: 0,
      };
    const row = (
      await (tx ?? this.database.pool).query<{
        source: string;
        segment_count: number;
        text_bytes: number;
        candidate: boolean;
        based_on_revision: number | null;
        recording_metadata: unknown;
        timeline_count: number;
      }>(
        `SELECT t.source,t.segment_count,t.text_bytes,t.candidate,t.based_on_revision,t.recording_metadata,t.timeline_count FROM transcript_revisions t
         JOIN documents d ON d.id=t.document_id
         JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
         JOIN users u ON u.id=d.owner_id AND u.active
         WHERE t.document_id=$1 AND t.revision=$2 AND d.owner_id=$3 AND d.deleted_at IS NULL`,
        [id, selected, user],
      )
    ).rows[0];
    if (!row)
      throw new ServiceError(
        'revision_not_found',
        'The requested transcript revision is unavailable.',
        404,
      );
    const header = transcriptHeaderSchema.parse({
      document_id: id,
      revision: selected,
      source: row.source,
      total_segments: row.segment_count,
      is_candidate: row.candidate,
      ...(row.based_on_revision === null
        ? {}
        : { based_on_revision: row.based_on_revision }),
      ...(row.recording_metadata === null
        ? {}
        : { recording: row.recording_metadata }),
    });
    if (row.timeline_count !== (header.recording?.timeline_count ?? 0))
      throw new ServiceError(
        'transcript_integrity_error',
        'The stored capture timeline metadata is inconsistent.',
        500,
      );
    return { ...header, text_bytes: row.text_bytes };
  }
  async timeline(user: string, id: string, version: number, offset: number) {
    if (version < 1)
      throw new ServiceError(
        'revision_not_found',
        'This meeting has no transcript timeline.',
        404,
      );
    const header = await this.header(user, id, version);
    const total = header.recording?.timeline_count ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > total)
      throw new ServiceError(
        'invalid_transcript_page',
        'The capture timeline position is outside this revision.',
        400,
      );
    const rows = await this.database.pool.query<{
      position: number;
      entry: unknown;
    }>(
      `SELECT t.position,t.entry FROM transcript_timeline t
       JOIN documents d ON d.id=t.document_id
       JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
       JOIN users u ON u.id=d.owner_id AND u.active
       WHERE t.document_id=$1 AND t.revision=$2 AND t.position >= $3
         AND d.owner_id=$4 AND d.deleted_at IS NULL ORDER BY t.position LIMIT 50`,
      [id, version, offset, user],
    );
    await this.database.document(user, id);
    if (
      rows.rows.length !== Math.min(50, total - offset) ||
      rows.rows.some((row, index) => row.position !== offset + index)
    )
      throw new ServiceError(
        'transcript_integrity_error',
        'The stored capture timeline is incomplete.',
        500,
      );
    return transcriptTimelinePageSchema.parse({
      document_id: id,
      revision: version,
      offset,
      total,
      entries: rows.rows.map((row) =>
        transcriptTimelineEntrySchema.parse(row.entry),
      ),
      has_more: offset + rows.rows.length < total,
    });
  }

  async page(user: string, id: string, version?: number, offset = 0) {
    const header = await this.header(user, id, version);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > header.total_segments
    )
      throw new ServiceError(
        'invalid_transcript_page',
        'The requested transcript position is outside this revision.',
        400,
      );
    const segments = await this.read(
      user,
      id,
      header.revision,
      offset,
      TRANSCRIPT_PAGE_SIZE,
    );
    if (
      segments.length !==
      Math.min(TRANSCRIPT_PAGE_SIZE, header.total_segments - offset)
    )
      throw new ServiceError(
        'transcript_integrity_error',
        'The stored transcript page is incomplete.',
        500,
      );
    const { text_bytes: _, ...metadata } = header;
    return makeTranscriptPage(metadata, offset, segments);
  }

  private async read(
    user: string,
    id: string,
    version: number,
    offset: number,
    limit: number,
    tx?: Transaction,
  ) {
    // Authorization is repeated on the data query, including empty revisions.
    await this.database.document(user, id, tx);
    const rows = await (tx ?? this.database.pool).query<{
      position: number;
      segment: unknown;
    }>(
      `SELECT s.position,s.segment FROM transcript_segments s
       JOIN documents d ON d.id=s.document_id
       JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
       JOIN users u ON u.id=d.owner_id AND u.active
       WHERE s.document_id=$1 AND s.revision=$2 AND s.position >= $3
         AND d.owner_id=$4 AND d.deleted_at IS NULL
       ORDER BY s.position LIMIT $5`,
      [id, version, offset, user, limit],
    );
    return rows.rows.map((row, index) => {
      if (row.position !== offset + index)
        throw new ServiceError(
          'transcript_integrity_error',
          'The stored transcript segment order is incomplete.',
          500,
        );
      return segmentSchema.parse(row.segment);
    });
  }

  async legacy(user: string, id: string, version?: number, tx?: Transaction) {
    const header = await this.header(user, id, version, tx);
    if (header.total_segments > 1000 || header.text_bytes > 320_000)
      throw this.paginationRequired();
    const segments = await this.read(user, id, header.revision, 0, 1000, tx);
    if (segments.length !== header.total_segments)
      throw new ServiceError(
        'transcript_integrity_error',
        'The stored transcript is incomplete.',
        500,
      );
    const parsed = segmentsSchema.safeParse(segments);
    if (!parsed.success) throw this.paginationRequired();
    return {
      document_id: id,
      revision: header.revision,
      source: header.source,
      segments: parsed.data,
    };
  }
  async citations(
    user: string,
    id: string,
    version: number,
    ids: string[],
    tx?: Transaction,
  ) {
    if (ids.length > 4096 || new Set(ids).size !== ids.length)
      throw new Error('Use a bounded unique frozen citation lookup.');
    await this.database.document(user, id, tx);
    const rows = await (tx ?? this.database.pool).query<{ segment: unknown }>(
      `SELECT s.segment FROM transcript_segments s
       JOIN documents d ON d.id=s.document_id
       JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
       JOIN users u ON u.id=d.owner_id AND u.active
       WHERE s.document_id=$1 AND s.revision=$2 AND s.id=ANY($3::text[])
       AND d.owner_id=$4 AND d.deleted_at IS NULL ORDER BY s.position`,
      [id, version, ids, user],
    );
    await this.database.document(user, id, tx);
    return rows.rows.map((row) => segmentSchema.parse(row.segment));
  }

  private paginationRequired() {
    return new ServiceError(
      'transcript_pagination_required',
      'This transcript requires the paged transcript endpoint.',
      413,
    );
  }

  async write(
    tx: Transaction,
    user: string,
    id: string,
    base: number,
    source: 'manual' | 'azure_speech_fast',
    input: Segment[],
    options: {
      candidate?: boolean;
      basedOn?: number;
      recording?: z.infer<typeof transcriptHeaderSchema>['recording'];
      timeline?: z.infer<typeof transcriptTimelineEntrySchema>[];
    } = {},
  ) {
    const doc = await this.database.document(user, id, tx);
    if (doc.transcript_revision !== base)
      throw new ServiceError(
        'revision_conflict',
        'A newer transcript exists; it was not overwritten.',
        409,
      );
    const segments = storedSegmentsSchema.parse(input);
    const version = (
      await tx.query<{ version: number }>(
        'SELECT coalesce(max(revision),0)+1 version FROM transcript_revisions WHERE document_id=$1',
        [id],
      )
    ).rows[0]!.version;
    const timeline =
      options.timeline?.map((entry) =>
        transcriptTimelineEntrySchema.parse(entry),
      ) ?? [];
    if (
      timeline.length > 20_000 ||
      timeline.length !== (options.recording?.timeline_count ?? 0)
    )
      throw new Error(
        'Transcript timeline metadata must match its bounded entries.',
      );
    await tx.query(
      `INSERT INTO transcript_revisions
       (document_id,revision,source,segment_count,text_bytes,candidate,based_on_revision,recording_metadata,timeline_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        version,
        source,
        segments.length,
        segments.reduce(
          (sum, segment) => sum + Buffer.byteLength(segment.text),
          0,
        ),
        options.candidate ?? false,
        options.basedOn ?? null,
        options.recording ? JSON.stringify(options.recording) : null,
        timeline.length,
      ],
    );
    for (let offset = 0; offset < segments.length; offset += 100)
      await tx.query(
        `INSERT INTO transcript_segments (document_id,revision,position,id,segment)
         SELECT $1,$2,$3::integer+(s.ordinality-1)::integer,s.value->>'id',s.value
         FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS s(value,ordinality)`,
        [
          id,
          version,
          offset,
          JSON.stringify(segments.slice(offset, offset + 100)),
        ],
      );
    for (let offset = 0; offset < timeline.length; offset += 100)
      await tx.query(
        `INSERT INTO transcript_timeline (document_id,revision,position,entry)
         SELECT $1,$2,$3::integer+(s.ordinality-1)::integer,s.value
         FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS s(value,ordinality)`,
        [
          id,
          version,
          offset,
          JSON.stringify(timeline.slice(offset, offset + 100)),
        ],
      );
    if (!options.candidate)
      await tx.query(
        'UPDATE documents SET transcript_revision=$2,updated_at=now() WHERE id=$1',
        [id, version],
      );
    if (!options.candidate) await recordChange(tx, id, 'transcript');
    return version;
  }
  async apply(
    user: string,
    id: string,
    base: number,
    source: number,
    key: string,
  ) {
    const hash = digest({ base, source });
    const version = await this.database.transaction(async (tx) => {
      const doc = await this.database.document(user, id, tx);
      const existing = (
        await tx.query<{ request_hash: string; revision: number }>(
          'SELECT request_hash,revision FROM transcript_applications WHERE document_id=$1 AND request_key=$2',
          [id, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== hash)
          throw new ServiceError(
            'idempotency_conflict',
            'This transcript application key is bound to different input.',
            409,
          );
        return existing.revision;
      }
      if (doc.transcript_revision !== base)
        throw new ServiceError(
          'revision_conflict',
          'A newer transcript exists; review it before replacing it.',
          409,
        );
      await this.header(user, id, source, tx);
      const next = (
        await tx.query<{ revision: number }>(
          'SELECT coalesce(max(revision),0)+1 revision FROM transcript_revisions WHERE document_id=$1',
          [id],
        )
      ).rows[0]!.revision;
      await tx.query(
        `INSERT INTO transcript_revisions (document_id,revision,source,segment_count,text_bytes,candidate,based_on_revision,recording_metadata,timeline_count)
         SELECT document_id,$3,source,segment_count,text_bytes,false,$2,recording_metadata,timeline_count
         FROM transcript_revisions WHERE document_id=$1 AND revision=$2`,
        [id, source, next],
      );
      await tx.query(
        `INSERT INTO transcript_segments SELECT document_id,$3,position,id,segment
         FROM transcript_segments WHERE document_id=$1 AND revision=$2`,
        [id, source, next],
      );
      await tx.query(
        `INSERT INTO transcript_timeline SELECT document_id,$3,position,entry
         FROM transcript_timeline WHERE document_id=$1 AND revision=$2`,
        [id, source, next],
      );
      await tx.query(
        'INSERT INTO transcript_applications VALUES ($1,$2,$3,$4)',
        [id, key, hash, next],
      );
      await tx.query(
        'UPDATE documents SET transcript_revision=$2,updated_at=now() WHERE id=$1',
        [id, next],
      );
      await recordChange(tx, id, 'transcript');
      return next;
    });
    return this.page(user, id, version);
  }
}
