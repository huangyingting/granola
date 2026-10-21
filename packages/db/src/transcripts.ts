import {
  ServiceError,
  TRANSCRIPT_PAGE_SIZE,
  makeTranscriptPage,
  segmentSchema,
  segmentsSchema,
  storedSegmentsSchema,
  transcriptHeaderSchema,
} from '@windows-ai-notes/contracts/server';
import type { Segment } from '@windows-ai-notes/contracts/server';
import { type Database, type Transaction } from './index.js';
import { recordChange } from './sync.js';

export class TranscriptStore {
  constructor(private readonly database: Database) {}

  async header(user: string, id: string, version?: number, tx?: Transaction) {
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
      }>(
        `SELECT t.source,t.segment_count,t.text_bytes FROM transcript_revisions t
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
    return {
      ...transcriptHeaderSchema.parse({
        document_id: id,
        revision: selected,
        source: row.source,
        total_segments: row.segment_count,
      }),
      text_bytes: row.text_bytes,
    };
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
  ) {
    const doc = await this.database.document(user, id, tx);
    if (doc.transcript_revision !== base)
      throw new ServiceError(
        'revision_conflict',
        'A newer transcript exists; it was not overwritten.',
        409,
      );
    const segments = storedSegmentsSchema.parse(input);
    const version = base + 1;
    await tx.query(
      'INSERT INTO transcript_revisions (document_id,revision,source,segment_count,text_bytes) VALUES ($1,$2,$3,$4,$5)',
      [
        id,
        version,
        source,
        segments.length,
        segments.reduce(
          (sum, segment) => sum + Buffer.byteLength(segment.text),
          0,
        ),
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
    await tx.query(
      'UPDATE documents SET transcript_revision=$2,updated_at=now() WHERE id=$1',
      [id, version],
    );
    await recordChange(tx, id, 'transcript');
  }
}
