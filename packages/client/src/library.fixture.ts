import { z } from 'zod';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import type { EditableDraft } from '@windows-ai-notes/contracts/desktop';
import { latencySummarySchema } from './load.fixture.js';

export const WINDOWS_LIBRARY_DOCUMENTS = 1100;
export const WINDOWS_LIBRARY_MARKER =
  'Synthetic private Windows library evidence';

export function windowsLibraryFields(index: number): EditableDraft {
  z.number()
    .int()
    .min(0)
    .max(WINDOWS_LIBRARY_DOCUMENTS - 1)
    .parse(index);
  const text =
    `${WINDOWS_LIBRARY_MARKER} ${index}. ` +
    'Discussion material with decisions, follow-up work and evidence. '.repeat(
      35,
    ) +
    `endtoken-${index}`;
  return {
    title: `Synthetic Windows library meeting ${index}`,
    tags: ['Synthetic', index % 2 ? 'Structured' : 'Plain'],
    content:
      index % 2
        ? {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 2 },
                content: [{ type: 'text', text: 'Synthetic meeting context' }],
              },
              ...richTextFromPlainText(text).content,
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [
                      {
                        type: 'paragraph',
                        content: [
                          { type: 'text', text: 'Synthetic follow-up work.' },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }
        : richTextFromPlainText(text),
  };
}

const samples = (count: number) =>
  latencySummarySchema.refine((value) => value.samples === count);

export const windowsLibraryObservationSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('controlled_windows_library'),
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
    setup: z.literal('main_local_store_with_actual_dpapi_key'),
    latency_scope: z.literal('sandboxed_renderer_validated_ipc_round_trip'),
    cohort: z.strictObject({
      documents: z.literal(WINDOWS_LIBRARY_DOCUMENTS),
      plain_documents: z.literal(550),
      structured_documents: z.literal(550),
      initial_body_utf8_bytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024),
    }),
    process_restarts: z.literal(4),
    latency: z.strictObject({
      first_full_scan_after_startup: samples(3),
      distinct_warm_full_scan: samples(15),
      selected_save_with_active_no_match_query: samples(3),
    }),
    maximum_measured_response_utf8_bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024),
    first_page_documents: z.literal(50),
    last_page_documents: z.literal(50),
    empty_search_responses: z.literal(18),
    nonselected_full_body_matches: z.literal(3),
    selected_edits_survived_restarts: z.literal(true),
    plaintext_marker_absent: z.literal(true),
    natural_exit_verified: z.literal(true),
    resources_cleaned: z.literal(true),
  })
  .refine((value) =>
    value.execution === 'github_actions'
      ? value.source_commit !== null
      : value.source_commit === null,
  );
