import { z } from 'zod';
import {
  citationSchema,
  citationKey,
  summarySnapshotSchema,
  summaryResultSchema,
  usageSchema,
  resourceId,
  jobStateSchema,
  ServiceError,
  type Citation,
} from './server.js';

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

export function* evidencePieces(
  text: string,
  source: Pick<SummaryEvidenceUnit, 'citation' | 'start_ms' | 'end_ms'>,
): Generator<SummaryEvidenceUnit> {
  let part = '',
    size = 0,
    start = 0;
  for (const character of text) {
    const cost = utf8.encode(JSON.stringify(character)).length - 2;
    if (size + cost > 3072 && part) {
      yield {
        ...source,
        text: part,
        text_start: start,
        text_end: start + part.length,
        overlap: false,
      };
      start += part.length;
      part = '';
      size = 0;
    }
    part += character;
    size += cost;
  }
  if (part)
    yield {
      ...source,
      text: part,
      text_start: start,
      text_end: start + part.length,
      overlap: false,
    };
}

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

export const MAX_SUMMARY_STEPS = 40_000;
export const SUMMARY_FACT_BYTES = 32_768;
export const evidenceFactsSchema = z.strictObject({
  facts: z
    .array(
      z.strictObject({
        category: z.enum(['fact', 'topic', 'decision', 'action', 'question']),
        text: z.string().min(1).max(2000),
        citations: z.array(citationSchema).min(1).max(16),
        owner: z.string().max(200).nullable(),
        due_date: z.string().max(200).nullable(),
      }),
    )
    .max(64),
});
export type EvidenceFacts = z.infer<typeof evidenceFactsSchema>;
export const SUMMARY_PIPELINE_FACT_BYTES = 8192;
export const SUMMARY_FACTS_INPUT_BYTES = 36_864;
export const SUMMARY_EXTRACT_PROMPT = 'meeting-evidence-extract-v1';
export const SUMMARY_MERGE_PROMPT = 'meeting-evidence-merge-v1';
export const SUMMARY_FACTS_PROMPT = 'meeting-facts-summary-v1';
export const summaryFactsInputSchema = frozenMeetingSchema
  .omit({ notes: true })
  .extend({
    version: z.literal('meeting-facts-input-v1'),
    facts: z.array(evidenceFactsSchema.shape.facts.element).max(256),
  })
  .refine(
    (value) =>
      utf8.encode(JSON.stringify(value)).length <= SUMMARY_FACTS_INPUT_BYTES,
  );
export type SummaryFactsInput = z.infer<typeof summaryFactsInputSchema>;
export function factCitations(facts: EvidenceFacts['facts']) {
  const unique = new Map<string, Citation>();
  for (const fact of facts)
    for (const citation of fact.citations)
      unique.set(citationKey(citation), citation);
  return [...unique.values()];
}
export function validatePipelineFacts(
  value: unknown,
  citations: readonly Citation[],
) {
  const result = validateEvidenceFacts(value, citations);
  if (utf8.encode(JSON.stringify(result)).length > SUMMARY_PIPELINE_FACT_BYTES)
    throw new ServiceError(
      'invalid_model_output',
      'The extracted evidence exceeds the resumable pipeline fact budget.',
      502,
    );
  return result;
}
export function validateEvidenceFacts(
  value: unknown,
  citations: readonly Citation[],
) {
  const parsed = evidenceFactsSchema.safeParse(value);
  if (
    !parsed.success ||
    utf8.encode(JSON.stringify(parsed.data)).length > SUMMARY_FACT_BYTES
  )
    throw new ServiceError(
      'invalid_model_output',
      'The model did not return bounded structured evidence facts.',
      502,
    );
  const allowed = new Set(citations.map(citationKey));
  for (const fact of parsed.data.facts) {
    if (
      fact.category !== 'action' &&
      (fact.owner !== null || fact.due_date !== null)
    )
      throw new ServiceError(
        'invalid_model_output',
        'Only explicit action items may carry an owner or due date.',
        502,
      );
    if (fact.citations.some((citation) => !allowed.has(citationKey(citation))))
      throw new ServiceError(
        'invalid_citation',
        'The model cited material outside its supplied evidence stage.',
        502,
      );
  }
  return parsed.data;
}
export const summaryStageKeySchema = z
  .strictObject({
    phase: z.enum(['extract', 'merge', 'generate']),
    round: z.number().int().min(0).max(8),
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_SUMMARY_CHUNKS - 1),
  })
  .refine((key) => (key.phase === 'merge' ? key.round > 0 : key.round === 0))
  .refine((key) => key.phase !== 'generate' || key.index === 0);
export type SummaryStageKey = z.infer<typeof summaryStageKeySchema>;
export const summaryStageSpecSchema = summaryStageKeySchema.safeExtend({
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_version: z.string().min(1).max(80),
  citations: z
    .array(citationSchema)
    .min(1)
    .max(4096)
    .refine((items) => new Set(items.map(citationKey)).size === items.length),
});
export type SummaryStageSpec = z.infer<typeof summaryStageSpecSchema>;
export const summaryStageOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('facts'),
    facts: evidenceFactsSchema.shape.facts,
    usage: usageSchema,
  }),
  z.strictObject({ kind: z.literal('summary'), result: summaryResultSchema }),
]);
export type SummaryStageOutput = z.infer<typeof summaryStageOutputSchema>;
export const summaryProgressSchema = z
  .strictObject({
    document_id: resourceId,
    job_id: resourceId,
    state: jobStateSchema,
    total_stages: z.number().int().min(0).max(MAX_SUMMARY_STEPS),
    completed_stages: z.number().int().min(0).max(MAX_SUMMARY_STEPS),
    provider_requests: z.number().int().nonnegative(),
    uncertain_requests: z.number().int().nonnegative(),
    resume_available: z.boolean(),
    resume_token: resourceId.nullable(),
  })
  .refine(
    (progress) =>
      progress.completed_stages <= progress.total_stages &&
      progress.uncertain_requests <= progress.provider_requests &&
      (!progress.resume_available || progress.state === 'failed') &&
      progress.resume_available === (progress.resume_token !== null),
  );
export type SummaryProgress = z.infer<typeof summaryProgressSchema>;
const newRequestErrors = new Set([
  'insufficient_evidence',
  'context_too_large',
  'empty_context',
  'summary_progress_expired',
]);
export const summaryNeedsNewRequest = (code: string | null | undefined) =>
  newRequestErrors.has(code ?? '');
