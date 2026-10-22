import {
  ServiceError,
  segmentSchema,
  type Segment,
} from '@windows-ai-notes/contracts/server';
import {
  evidencePieces,
  type SummaryEvidenceUnit,
} from '@windows-ai-notes/contracts/evidence';
import {
  QUESTION_CONTEXT_BYTES,
  QUESTION_RETRIEVAL_VERSION,
  QUESTION_VERSION,
  questionEvidenceSchema,
  questionEvidenceScore,
  questionRequestSchema,
  questionSearchTerms,
  type QuestionEvidence,
  type QuestionRequest,
} from '@windows-ai-notes/contracts/questions';
import type { Database, Transaction } from './index.js';

const segmentUnit = (
  segment: Segment,
  revision: number,
): SummaryEvidenceUnit => ({
  citation: { source: 'transcript', id: segment.id, revision },
  text: segment.text,
  text_start: 0,
  text_end: segment.text.length,
  start_ms: segment.start_ms,
  end_ms: segment.end_ms,
  overlap: false,
});

function windows(unit: SummaryEvidenceUnit) {
  return [...evidencePieces(unit.text, unit)].map((piece) => {
    let start = Math.max(0, piece.text_start - 128);
    if (/[\uDC00-\uDFFF]/u.test(unit.text[start] ?? '')) start--;
    return {
      ...piece,
      text_start: start,
      text: unit.text.slice(start, piece.text_end),
    };
  });
}

export class MeetingQuestions {
  constructor(private readonly database: Database) {}

  async evidence(
    user: string,
    id: string,
    value: QuestionRequest,
    tx?: Transaction,
  ): Promise<QuestionEvidence> {
    const request = questionRequestSchema.parse(value);
    if (!tx)
      return this.database.transaction((client) =>
        this.evidence(user, id, request, client),
      );
    const doc = await this.database.document(user, id, tx);
    if (
      doc.revision !== request.note_revision ||
      doc.transcript_revision !== request.transcript_revision
    )
      throw new ServiceError(
        'revision_conflict',
        'Refresh the meeting before asking about its changed evidence.',
        409,
      );
    const header = await this.database.transcripts.header(
      user,
      id,
      request.transcript_revision,
      tx,
    );
    if (header.is_candidate)
      throw new ServiceError(
        'transcript_integrity_error',
        'Questions require the canonical meeting transcript.',
        500,
      );
    const context = {
      ...request,
      document_id: id,
      version: QUESTION_VERSION,
      retrieval_version: QUESTION_RETRIEVAL_VERSION,
    };
    const note: SummaryEvidenceUnit | null = doc.notes.trim()
      ? {
          citation: { source: 'note', id, revision: doc.revision },
          text: doc.notes,
          text_start: 0,
          text_end: doc.notes.length,
          start_ms: null,
          end_ms: null,
          overlap: false,
        }
      : null;
    if (
      header.total_segments <= 256 &&
      header.text_bytes + Buffer.byteLength(doc.notes) <= QUESTION_CONTEXT_BYTES
    ) {
      const transcript = await this.database.transcripts.legacy(
        user,
        id,
        header.revision,
        tx,
      );
      const full = questionEvidenceSchema.safeParse({
        ...context,
        mode: 'full',
        units: [
          ...(note ? [note] : []),
          ...transcript.segments.map((segment) =>
            segmentUnit(segment, header.revision),
          ),
        ],
      });
      if (full.success) {
        await this.database.document(user, id, tx);
        return full.data;
      }
    }

    const terms = questionSearchTerms(request.question);
    const rows = terms.length
      ? await tx.query<{ position: number; segment: unknown; score: number }>(
          `WITH ranked AS MATERIALIZED (
             SELECT s.position,
               (SELECT count(*) FROM unnest($4::text[]) AS p(pattern)
                WHERE lower(normalize(s.segment->>'text', NFKC)) LIKE p.pattern)::int score
             FROM transcript_segments s
             JOIN documents d ON d.id=s.document_id
             JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
             JOIN users u ON u.id=d.owner_id AND u.active
             WHERE s.document_id=$1 AND s.revision=$2 AND d.owner_id=$3 AND d.deleted_at IS NULL
               AND lower(normalize(s.segment->>'text', NFKC)) LIKE ANY($4::text[])
             ORDER BY score DESC,s.position LIMIT 24
           ), positions AS (
             SELECT DISTINCT r.position + n.delta AS position
             FROM ranked r CROSS JOIN generate_series(-1,1) AS n(delta)
           )
           SELECT s.position,s.segment,COALESCE(r.score,0)::int score
           FROM positions p
           JOIN transcript_segments s ON s.document_id=$1 AND s.revision=$2 AND s.position=p.position
           JOIN documents d ON d.id=s.document_id
           JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
           JOIN users u ON u.id=d.owner_id AND u.active
           LEFT JOIN ranked r ON r.position=s.position
           WHERE d.owner_id=$3 AND d.deleted_at IS NULL
           ORDER BY score DESC,s.position`,
          [id, header.revision, user, terms.map((term) => `%${term}%`)],
        )
      : { rows: [] };
    const segments = rows.rows.map((row) => ({
      position: row.position,
      segment: segmentSchema.parse(row.segment),
    }));
    const positions = new Map(
      segments.map((row) => [row.segment.id, row.position]),
    );
    const ranked = [
      ...(note ? windows(note) : []),
      ...segments.flatMap((row) =>
        windows(segmentUnit(row.segment, header.revision)),
      ),
    ]
      .map((unit, index) => ({
        unit,
        index,
        score: questionEvidenceScore(unit.text, terms),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const selected: SummaryEvidenceUnit[] = [];
    const add = (unit: SummaryEvidenceUnit) => {
      const proposed = {
        ...context,
        mode: 'retrieved',
        units: [...selected, unit],
      };
      if (Buffer.byteLength(JSON.stringify(proposed)) <= QUESTION_CONTEXT_BYTES)
        selected.push(unit);
    };
    for (const candidate of ranked)
      if (candidate.score > 0) add(candidate.unit);
    // Only immediate context around accepted primary evidence may fill the remaining budget.
    const primary = [...selected];
    for (const candidate of ranked) {
      if (candidate.score !== 0) continue;
      if (
        primary.some((unit) => {
          if (unit.citation.source !== candidate.unit.citation.source)
            return false;
          if (unit.citation.id === candidate.unit.citation.id)
            return (
              candidate.unit.text_start <= unit.text_end &&
              candidate.unit.text_end >= unit.text_start
            );
          const left = positions.get(unit.citation.id);
          const right = positions.get(candidate.unit.citation.id);
          return (
            left !== undefined &&
            right !== undefined &&
            Math.abs(left - right) === 1
          );
        })
      )
        add(candidate.unit);
    }
    await this.database.document(user, id, tx);
    return questionEvidenceSchema.parse({
      ...context,
      mode: 'retrieved',
      units: selected,
    });
  }
}
