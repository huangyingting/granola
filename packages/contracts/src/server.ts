import { z } from 'zod';
import { summaryTemplateIdSchema } from './templates.js';
import { captureGapSchema, captureTimelineEventSchema } from './index.js';
import {
  notesTextSchema,
  richTextSchema,
  richTextToPlainText,
  tagsSchema,
  type RichTextDocument,
} from './content.js';

export const resourceId = z.uuidv4();
export const revision = z.number().int().nonnegative();
export const locale = z.enum(['en-US', 'zh-CN']);
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
export const MAX_AUDIO_BYTES = 60 * 16_000 * 2 + 44;
const oauthScope = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;
export const oidcClientConfigurationSchema = z.strictObject({
  issuer: z.url().max(2048),
  audience: z.string().min(1).max(1024),
  client_id: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\u0000-\u0020\u007f]+$/),
  scope: z
    .string()
    .max(2048)
    .regex(oauthScope)
    .refine(
      (value) =>
        ['openid', 'offline_access'].every((scope) =>
          value.split(' ').includes(scope),
        ),
      'Desktop login requires openid and offline_access scopes.',
    ),
  required_scope: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/),
  loopback_host: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
});
export type OidcClientConfiguration = z.infer<
  typeof oidcClientConfigurationSchema
>;

const noteFields = {
  notes: notesTextSchema.optional(),
  content: richTextSchema.nullish(),
};
function validateNoteFields(
  value: {
    notes?: string | undefined;
    content?: RichTextDocument | null | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (
    value.content &&
    value.notes !== undefined &&
    value.notes !== richTextToPlainText(value.content)
  )
    ctx.addIssue({
      code: 'custom',
      message: 'Plain text must agree with the structured notes.',
      path: ['notes'],
    });
}
function normalizeNotes(value: {
  notes?: string | undefined;
  content?: RichTextDocument | null | undefined;
}) {
  return {
    notes: value.content
      ? richTextToPlainText(value.content)
      : (value.notes ?? ''),
    content: value.content ?? null,
  };
}
export const createDocumentSchema = z
  .strictObject({
    id: resourceId.optional(),
    workspace_id: resourceId,
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((text) => !text.includes('\0')),
    tags: tagsSchema.default([]),
    ...noteFields,
  })
  .superRefine(validateNoteFields)
  .transform((value) => ({ ...value, ...normalizeNotes(value) }));
export const updateNotesSchema = z
  .strictObject({
    base_revision: revision.min(1),
    ...noteFields,
  })
  .superRefine(validateNoteFields)
  .refine(
    (value) => value.notes !== undefined || !!value.content,
    'Provide notes or structured content.',
  )
  .transform((value) => ({ ...value, ...normalizeNotes(value) }));
export const updateDocumentSchema = z
  .strictObject({
    base_revision: revision.min(1),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((text) => !text.includes('\0'))
      .optional(),
    tags: tagsSchema.optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.tags !== undefined,
    'Provide a title or tags.',
  );
export const segmentSchema = z
  .strictObject({
    id: resourceId,
    start_ms: z.number().int().nonnegative().max(14_400_000),
    end_ms: z.number().int().nonnegative().max(14_400_000),
    text: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .refine((text) => !text.includes('\0')),
    origin: z
      .strictObject({
        recording_id: resourceId,
        track_id: z.uuid(),
        kind: z.enum(['microphone', 'loopback']),
        capture_epoch: z.uuid(),
        chunk_id: z.uuid(),
        start_offset_ms: z.number().int().min(0).max(30_000),
        end_offset_ms: z.number().int().min(0).max(30_000),
        time_basis: z.enum(['chunk_clock_linear', 'unmapped_clock']),
      })
      .refine((origin) => origin.end_offset_ms >= origin.start_offset_ms)
      .optional(),
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
export const documentSchema = z
  .strictObject({
    id: resourceId,
    workspace_id: resourceId,
    owner_id: resourceId,
    title: z
      .string()
      .max(200)
      .refine((value) => !value.includes('\0')),
    revision: revision.min(1),
    transcript_revision: revision,
    notes: notesTextSchema,
    content: richTextSchema.nullable(),
    tags: tagsSchema,
    applied_revision: revision.min(1).optional(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .superRefine(validateNoteFields);
export const transcriptSchema = z.strictObject({
  document_id: resourceId,
  revision,
  source: z.enum(['none', 'manual', 'azure_speech_fast']),
  segments: segmentsSchema,
});
export const MAX_TRANSCRIPT_SEGMENTS = 100_000;
export const MAX_TRANSCRIPT_TEXT_BYTES = 8_000_000;
export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_PAGE_TEXT_BYTES = 128_000;
const utf8 = new TextEncoder();
export const storedSegmentsSchema = z
  .array(segmentSchema)
  .max(MAX_TRANSCRIPT_SEGMENTS)
  .refine(
    (segments) =>
      new Set(segments.map((segment) => segment.id)).size === segments.length &&
      segments.reduce(
        (sum, segment) => sum + utf8.encode(segment.text).length,
        0,
      ) <= MAX_TRANSCRIPT_TEXT_BYTES,
    'Transcript segment IDs must be unique and stored text must fit the meeting limit.',
  );
export const transcriptHeaderSchema = transcriptSchema
  .omit({ segments: true })
  .extend({
    total_segments: z.number().int().min(0).max(MAX_TRANSCRIPT_SEGMENTS),
    is_candidate: z.boolean().optional(),
    based_on_revision: revision.optional(),
    recording: z
      .strictObject({
        id: resourceId,
        seal_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        partial: z.boolean(),
        tracks: z
          .array(
            z.strictObject({
              track_id: z.uuid(),
              kind: z.enum(['microphone', 'loopback']),
            }),
          )
          .min(1)
          .max(2),
        timeline_count: z.number().int().min(0).max(20_000),
      })
      .optional(),
  });
export const transcriptTimelineEntrySchema = z.union([
  z.strictObject({
    kind: z.literal('event'),
    value: captureTimelineEventSchema,
  }),
  z.strictObject({ kind: z.literal('gap'), value: captureGapSchema }),
]);
export const transcriptTimelinePageSchema = z
  .strictObject({
    document_id: resourceId,
    revision: revision.min(1),
    offset: z.number().int().min(0).max(20_000),
    total: z.number().int().min(0).max(20_000),
    entries: z.array(transcriptTimelineEntrySchema).max(50),
    has_more: z.boolean(),
  })
  .refine(
    (page) =>
      page.offset + page.entries.length <= page.total &&
      page.has_more === page.offset + page.entries.length < page.total &&
      (!page.has_more || page.entries.length > 0),
  );
export const applyTranscriptSchema = z.strictObject({
  base_revision: revision,
  source_revision: revision.min(1),
  confirmed: z.literal(true),
});
export const finalizeTranscriptSchema = z.strictObject({
  base_revision: revision,
  locale,
  seal_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  accept_incomplete: z.boolean(),
});
export const transcriptPageSchema = transcriptHeaderSchema
  .extend({
    offset: z.number().int().min(0).max(MAX_TRANSCRIPT_SEGMENTS),
    segments: z.array(segmentSchema).max(TRANSCRIPT_PAGE_SIZE),
    has_more: z.boolean(),
  })
  .refine(
    (page) =>
      page.offset + page.segments.length <= page.total_segments &&
      page.has_more ===
        page.offset + page.segments.length < page.total_segments &&
      (!page.has_more || page.segments.length > 0) &&
      (page.revision !== 0 ||
        (page.source === 'none' && page.total_segments === 0)) &&
      (page.source !== 'none' || page.revision === 0) &&
      new Set(page.segments.map((segment) => segment.id)).size ===
        page.segments.length &&
      page.segments.reduce(
        (sum, segment) => sum + utf8.encode(segment.text).length,
        0,
      ) <= TRANSCRIPT_PAGE_TEXT_BYTES,
    'The transcript page has inconsistent bounds, identity, or text size.',
  );
export type TranscriptPage = z.infer<typeof transcriptPageSchema>;
export const cachedTranscriptSchema = z
  .union([transcriptPageSchema, transcriptSchema])
  .refine(
    (value) =>
      value.revision === 0
        ? value.source === 'none' && value.segments.length === 0
        : value.source !== 'none',
    'The cached transcript source must agree with its revision.',
  );
export const transcriptPageQuerySchema = z.strictObject({
  revision: z.coerce.number().int().nonnegative().optional(),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_TRANSCRIPT_SEGMENTS)
    .default(0),
});
export function makeTranscriptPage(
  header: z.infer<typeof transcriptHeaderSchema>,
  offset: number,
  candidates: z.infer<typeof segmentSchema>[],
): TranscriptPage {
  const segments: z.infer<typeof segmentSchema>[] = [];
  let bytes = 0;
  for (const segment of candidates.slice(0, TRANSCRIPT_PAGE_SIZE)) {
    bytes += utf8.encode(segment.text).length;
    if (bytes > TRANSCRIPT_PAGE_TEXT_BYTES) break;
    segments.push(segment);
  }
  return transcriptPageSchema.parse({
    ...header,
    offset,
    segments,
    has_more: offset + segments.length < header.total_segments,
  });
}
export const summaryRequestSchema = z.strictObject({
  note_revision: revision.min(1),
  transcript_revision: revision,
  language: z.enum(['en', 'zh']).default('en'),
  template_id: summaryTemplateIdSchema.optional(),
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
  template_id: summaryTemplateIdSchema.optional(),
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
  z.strictObject({
    kind: z.literal('recording_transcription'),
    recording_id: resourceId,
    seal_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    base_transcript_revision: revision,
    locale,
    accept_incomplete: z.boolean(),
    chunk_count: z.number().int().positive().max(10_000),
  }),
]);
export const usageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  audio_ms: z.number().nonnegative(),
});
export const aiLimitsSchema = z.strictObject({
  input_tokens: z.number().int().min(0).max(1_000_000_000_000),
  output_tokens: z.number().int().min(0).max(1_000_000_000_000),
  audio_ms: z.number().int().min(0).max(1_000_000_000_000),
});
export const DEFAULT_AI_LIMITS = {
  input_tokens: 2_000_000,
  output_tokens: 500_000,
  audio_ms: 28_800_000,
} as const;
const usageCount = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
export const usageTotalsSchema = z.strictObject({
  input_tokens: usageCount,
  output_tokens: usageCount,
  audio_ms: usageCount,
});
export const accountUsageSchema = z.strictObject({
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  limits: usageTotalsSchema,
  settled: usageTotalsSchema,
  uncertain: usageTotalsSchema,
  settled_requests: usageCount,
  uncertain_requests: usageCount,
  over_limit: z.boolean(),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;
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
  z.strictObject({
    kind: z.literal('recording_transcription'),
    recording_id: resourceId,
    transcript_revision: revision.min(1),
    segment_count: z.number().int().min(0).max(MAX_TRANSCRIPT_SEGMENTS),
    processed_chunks: z.number().int().min(1).max(10_000),
    uncertain_requests: z.number().int().nonnegative(),
    applied: z.boolean(),
    partial: z.boolean(),
    provider: z.enum(['azure', 'fixture']),
    configuration_version: z.string(),
    usage: usageSchema,
  }),
]);
export const jobSchema = z.strictObject({
  id: resourceId,
  document_id: resourceId,
  kind: z.enum(['summary', 'transcription', 'recording_transcription']),
  state: jobStateSchema,
  attempt: z.number().int().nonnegative(),
  input_stale: z.boolean(),
  result: resultSchema.nullable(),
  error: failureSchema.nullable(),
  created_at: z.string(),
  recording_id: resourceId.nullable().optional(),
  progress: z
    .strictObject({
      completed_chunks: z.number().int().min(0).max(10_000),
      total_chunks: z.number().int().min(1).max(10_000),
      audio_ms: z.number().min(0).max(28_800_000),
      uncertain_requests: z.number().int().nonnegative(),
    })
    .refine((value) => value.completed_chunks <= value.total_chunks)
    .nullable()
    .optional(),
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
const cursorToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(1024);
export const syncSnapshotQuerySchema = z
  .strictObject({
    workspace_id: resourceId,
    cursor: cursorToken.optional(),
    after: resourceId.optional(),
    limit: z.coerce.number().int().min(1).max(25).default(10),
  })
  .refine(
    (value) => !value.after || !!value.cursor,
    'Snapshot pagination requires its original cursor.',
  );
export const syncChangesQuerySchema = z.strictObject({
  workspace_id: resourceId,
  cursor: cursorToken,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const syncSnapshotSchema = z.strictObject({
  documents: z.array(documentSchema),
  cursor: cursorToken,
  next_after: resourceId.nullable(),
  has_more: z.boolean(),
});
export const syncChangesSchema = z.strictObject({
  changes: z.array(
    z.strictObject({
      seq: z.string().regex(/^[1-9]\d*$/),
      document_id: resourceId,
      kind: z.enum(['document', 'transcript', 'job', 'deleted']),
      revision: revision.min(1),
      transcript_revision: revision,
      job_id: resourceId.nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
  cursor: cursorToken,
  has_more: z.boolean(),
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
    readonly details?: {
      current_revision?: number;
      reset_required?: boolean;
      purge_workspace_id?: string;
    },
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
