import { z } from 'zod';
import { jobHistorySchema } from '@windows-ai-notes/contracts/server';
import { latencySummarySchema } from './load.fixture.js';

export const WINDOWS_HISTORY_JOBS = 20;
export const WINDOWS_HISTORY_MARKER =
  'Synthetic private saved-history evidence';

export function windowsHistoryJobs(document: string) {
  return jobHistorySchema.parse({
    jobs: Array.from({ length: WINDOWS_HISTORY_JOBS }, (_, index) => {
      const fact = (section: string) => ({
        text:
          `${WINDOWS_HISTORY_MARKER} ${index}/${section}. ` +
          'Controlled details and follow-up evidence. '.repeat(70),
        citations: [{ source: 'note', id: document, revision: 1 }],
      });
      return {
        id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
        document_id: document,
        kind: 'summary',
        state: 'succeeded',
        attempt: 1,
        input_stale: false,
        error: null,
        created_at: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
        result: {
          kind: 'summary',
          provider: 'fixture',
          configuration_version: 'controlled-saved-history-v1',
          prompt_version: 'summary-v1',
          usage: { input_tokens: 20, output_tokens: 30, audio_ms: 0 },
          summary: {
            overview: fact('overview'),
            topics: Array.from({ length: 6 }, (_, item) =>
              fact(`topic-${item}`),
            ),
            decisions: Array.from({ length: 6 }, (_, item) =>
              fact(`decision-${item}`),
            ),
            action_items: Array.from({ length: 6 }, (_, item) => ({
              ...fact(`action-${item}`),
              owner: null,
              due_date: null,
            })),
            open_questions: Array.from({ length: 6 }, (_, item) =>
              fact(`question-${item}`),
            ),
          },
        },
      };
    }),
  }).jobs;
}

const samples = (count: number) =>
  latencySummarySchema.refine((value) => value.samples === count);

export const windowsHistoryObservationSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('controlled_windows_saved_history'),
    scope: z.literal('synthetic_unpacked_windows_dpapi'),
    execution: z.enum(['local', 'github_actions']),
    source_commit: z
      .string()
      .length(40)
      .regex(/^[a-f0-9]{40}$/u)
      .nullable(),
    observed_at: z.iso.datetime(),
    platform: z.literal('win32'),
    architecture: z.literal('x64'),
    production_accepted: z.literal(false),
    slo_accepted: z.literal(false),
    setup: z.literal('synthetic_service_then_service_and_issuer_shutdown'),
    latency_scope: z.literal('sandboxed_renderer_validated_ipc_round_trip'),
    cohort: z.strictObject({
      documents: z.literal(2),
      saved_jobs: z.literal(WINDOWS_HISTORY_JOBS),
      full_history_utf8_bytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(4 * 1024 * 1024),
      encrypted_job_records: z.literal(22),
    }),
    process_restarts: z.literal(4),
    latency: z.strictObject({
      first_history_selection_after_startup: samples(3),
      warm_status: samples(15),
      selected_note_save: samples(3),
      explicit_saved_result: samples(3),
    }),
    maximum_measured_status_response_utf8_bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024),
    maximum_measured_result_response_utf8_bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024),
    all_full_results_verified: z.literal(20),
    metadata_body_free: z.literal(true),
    encrypted_artifacts_unchanged: z.literal(true),
    selected_saves_survived_restarts: z.literal(true),
    plaintext_marker_absent: z.literal(true),
    natural_exit_verified: z.literal(true),
    resources_cleaned: z.literal(true),
  })
  .refine((value) =>
    value.execution === 'github_actions'
      ? value.source_commit !== null
      : value.source_commit === null,
  );
