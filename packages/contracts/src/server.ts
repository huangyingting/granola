import { z } from 'zod';

export const resourceId = z.uuidv4();
export const revision = z.number().int().nonnegative();
export const locale = z.enum(['en-US', 'zh-CN']);
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
export const MAX_AUDIO_BYTES = 60 * 16_000 * 2 + 44;

export const createDocumentSchema = z.strictObject({
  workspace_id: resourceId,
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(40_000).default(''),
});
export const updateNotesSchema = z.strictObject({
  base_revision: revision.min(1),
  notes: z.string().max(40_000),
});
export const updateDocumentSchema = z.strictObject({
  base_revision: revision.min(1),
  title: z.string().trim().min(1).max(200),
});
export const segmentSchema = z
  .strictObject({
    id: resourceId,
    start_ms: z.number().int().nonnegative().max(14_400_000),
    end_ms: z.number().int().nonnegative().max(14_400_000),
    text: z.string().trim().min(1).max(10_000),
  })
  .refine(
    (value) => value.end_ms >= value.start_ms,
    'Invalid segment time range.',
  );
export const segmentsSchema = z
  .array(segmentSchema)
  .max(1000)
  .refine(
    (segments) =>
      new Set(segments.map((segment) => segment.id)).size === segments.length &&
      segments.reduce((total, segment) => total + segment.text.length, 0) <=
        80_000,
    'Segment IDs must be unique and transcript text must fit the context limit.',
  );
export const updateTranscriptSchema = z.strictObject({
  base_revision: revision,
  segments: segmentsSchema,
});
export const documentSchema = z.strictObject({
  id: resourceId,
  workspace_id: resourceId,
  owner_id: resourceId,
  title: z.string(),
  revision: revision.min(1),
  transcript_revision: revision,
  notes: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const transcriptSchema = z.strictObject({
  document_id: resourceId,
  revision,
  source: z.enum(['none', 'manual', 'azure_speech_fast']),
  segments: segmentsSchema,
});
export const summaryRequestSchema = z.strictObject({
  note_revision: revision.min(1),
  transcript_revision: revision,
  language: z.enum(['en', 'zh']).default('en'),
});
export const transcriptionQuerySchema = z.strictObject({
  base_revision: z.coerce.number().int().nonnegative(),
  locale: locale.default('en-US'),
});
export const citationSchema = z.strictObject({
  source: z.enum(['note', 'transcript']),
  id: resourceId,
  revision: revision.min(1),
});
const factSchema = z.strictObject({
  text: z.string().min(1).max(4000),
  citations: z.array(citationSchema).min(1).max(16),
});
export const summarySchema = z.strictObject({
  overview: factSchema,
  topics: z.array(factSchema).max(20),
  decisions: z.array(factSchema).max(20),
  action_items: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(4000),
        owner: z.string().max(200).nullable(),
        due_date: z.string().max(200).nullable(),
        citations: z.array(citationSchema).min(1).max(16),
      }),
    )
    .max(30),
  open_questions: z.array(factSchema).max(20),
});
export const summarySnapshotSchema = z.strictObject({
  document_id: resourceId,
  note_revision: revision.min(1),
  transcript_revision: revision,
  notes: z.string().max(40_000),
  segments: segmentsSchema,
  language: z.enum(['en', 'zh']),
});
export const jobInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('summary'),
    snapshot: summarySnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal('transcription'),
    base_transcript_revision: revision,
    locale,
    duration_ms: z.number().positive().max(60_000),
  }),
]);
export const usageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  audio_ms: z.number().nonnegative(),
});
export const failureSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export const jobStateSchema = z.enum([
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
]);
export const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('summary'),
    summary: summarySchema,
    provider: z.enum(['azure', 'fixture']),
    configuration_version: z.string(),
    prompt_version: z.string(),
    usage: usageSchema,
  }),
  z.strictObject({
    kind: z.literal('transcription'),
    transcript_revision: revision.min(1),
    segment_count: z.number().int().nonnegative(),
    provider: z.enum(['azure', 'fixture']),
    configuration_version: z.string(),
    usage: usageSchema,
  }),
]);
export const jobSchema = z.strictObject({
  id: resourceId,
  document_id: resourceId,
  kind: z.enum(['summary', 'transcription']),
  state: jobStateSchema,
  attempt: z.number().int().nonnegative(),
  input_stale: z.boolean(),
  result: resultSchema.nullable(),
  error: failureSchema.nullable(),
  created_at: z.string(),
});
export const jobEventSchema = z.strictObject({
  job_id: resourceId,
  seq: z.number().int().positive(),
  event_type: z.enum([
    'job.accepted',
    'job.progress',
    'output.completed',
    'job.failed',
    'job.cancelled',
  ]),
  schema_version: z.literal(1),
  created_at: z.string(),
  payload: z.unknown(),
});

export type Segment = z.infer<typeof segmentSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type SummarySnapshot = z.infer<typeof summarySnapshotSchema>;
export type JobInput = z.infer<typeof jobInputSchema>;
export type JobResult = z.infer<typeof resultSchema>;
export type Job = z.infer<typeof jobSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Failure = z.infer<typeof failureSchema>;

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
    readonly details?: { current_revision: number },
  ) {
    super(message);
  }
}

export function validateSummary(
  value: unknown,
  snapshot: SummarySnapshot,
): Summary {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError(
      'invalid_model_output',
      'The model did not return a valid structured summary.',
      502,
    );
  }
  const summary = parsed.data;
  const allowed = new Set<string>();
  if (snapshot.notes.trim())
    allowed.add(`note:${snapshot.document_id}:${snapshot.note_revision}`);
  for (const segment of snapshot.segments) {
    allowed.add(`transcript:${segment.id}:${snapshot.transcript_revision}`);
  }
  for (const fact of [
    summary.overview,
    ...summary.topics,
    ...summary.decisions,
    ...summary.action_items,
    ...summary.open_questions,
  ]) {
    for (const citation of fact.citations) {
      if (
        !allowed.has(`${citation.source}:${citation.id}:${citation.revision}`)
      ) {
        throw new ServiceError(
          'invalid_citation',
          'The model cited material outside the frozen input revisions.',
          502,
        );
      }
    }
  }
  return summary;
}
