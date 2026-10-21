import { z } from 'zod';
import { citationSchema, summarySnapshotSchema } from './server.js';

const utf8 = new TextEncoder();
export const SUMMARY_EVIDENCE_VERSION = 'meeting-evidence-v1';
// This bounds serialized evidence, not provider-specific prompt/schema overhead.
export const SUMMARY_CHUNK_BYTES = 6144;
export const MAX_SUMMARY_CHUNKS = 20_000;
export const frozenMeetingSchema = summarySnapshotSchema.omit({
  segments: true,
});
export type FrozenMeeting = z.infer<typeof frozenMeetingSchema>;

// Text offsets are UTF-16 code units; times retain the whole original segment.
export const summaryEvidenceUnitSchema = z
  .strictObject({
    citation: citationSchema,
    text: z.string().min(1).max(40_000),
    text_start: z.number().int().min(0).max(40_000),
    text_end: z.number().int().min(1).max(40_000),
    start_ms: z.number().int().min(0).max(14_400_000).nullable(),
    end_ms: z.number().int().min(0).max(14_400_000).nullable(),
    overlap: z.boolean(),
  })
  .refine(
    (unit) =>
      unit.text_end - unit.text_start === unit.text.length &&
      (unit.citation.source === 'note'
        ? unit.start_ms === null && unit.end_ms === null
        : unit.start_ms !== null &&
          unit.end_ms !== null &&
          unit.end_ms >= unit.start_ms),
    'Evidence must retain its exact source text range and original time bounds.',
  );
export type SummaryEvidenceUnit = z.infer<typeof summaryEvidenceUnitSchema>;

export const summaryEvidenceChunkSchema = frozenMeetingSchema
  .omit({ notes: true })
  .extend({
    version: z.literal(SUMMARY_EVIDENCE_VERSION),
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_SUMMARY_CHUNKS - 1),
    units: z.array(summaryEvidenceUnitSchema).min(1).max(100),
  })
  .refine(
    (chunk) =>
      chunk.units.some((unit) => !unit.overlap) &&
      chunk.units.every((unit) =>
        unit.citation.source === 'note'
          ? unit.citation.id === chunk.document_id &&
            unit.citation.revision === chunk.note_revision
          : chunk.transcript_revision > 0 &&
            unit.citation.revision === chunk.transcript_revision,
      ),
    'Each chunk needs new evidence from the frozen meeting revisions.',
  )
  .refine(
    (chunk) => utf8.encode(JSON.stringify(chunk)).length <= SUMMARY_CHUNK_BYTES,
    'The complete serialized extraction input exceeds its byte budget.',
  );
export type SummaryEvidenceChunk = z.infer<typeof summaryEvidenceChunkSchema>;
