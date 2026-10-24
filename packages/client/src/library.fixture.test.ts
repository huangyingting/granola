import { describe, expect, it } from 'vitest';
import { richTextToPlainText } from '@windows-ai-notes/contracts/content';
import { editableSchema } from '@windows-ai-notes/contracts/desktop';
import { latencySummary } from './load.fixture.js';
import {
  WINDOWS_LIBRARY_DOCUMENTS,
  windowsLibraryFields,
  windowsLibraryObservationSchema,
} from './library.fixture.js';

describe('body-free Windows library observations', () => {
  const report = {
    version: 1,
    kind: 'controlled_windows_library',
    scope: 'synthetic_unpacked_windows_dpapi',
    execution: 'github_actions',
    source_commit: 'a'.repeat(40),
    observed_at: '2026-10-24T13:00:00.000Z',
    platform: 'win32',
    architecture: 'x64',
    production_accepted: false,
    slo_accepted: false,
    setup: 'main_local_store_with_actual_dpapi_key',
    latency_scope: 'sandboxed_renderer_validated_ipc_round_trip',
    cohort: {
      documents: 1100,
      plain_documents: 550,
      structured_documents: 550,
      initial_body_utf8_bytes: 3_000_000,
    },
    process_restarts: 4,
    latency: {
      first_full_scan_after_startup: latencySummary([300, 200, 250]),
      distinct_warm_full_scan: latencySummary(
        Array.from({ length: 15 }, (_, index) => 10 + index),
      ),
      selected_save_with_active_no_match_query: latencySummary([40, 30, 20]),
    },
    maximum_measured_response_utf8_bytes: 32_000,
    first_page_documents: 50,
    last_page_documents: 50,
    empty_search_responses: 18,
    nonselected_full_body_matches: 3,
    selected_edits_survived_restarts: true,
    plaintext_marker_absent: true,
    natural_exit_verified: true,
    resources_cleaned: true,
  };

  it('uses validated plain and structured notes with complete text beyond the preview', () => {
    const fields = Array.from(
      { length: WINDOWS_LIBRARY_DOCUMENTS },
      (_, index) => editableSchema.parse(windowsLibraryFields(index)),
    );
    expect(fields.filter((value) => value.tags.includes('Plain'))).toHaveLength(
      550,
    );
    expect(
      fields.filter((value) => value.tags.includes('Structured')),
    ).toHaveLength(550);
    for (const [index, value] of fields.entries()) {
      const text = richTextToPlainText(value.content);
      expect(text.indexOf(`endtoken-${index}`)).toBeGreaterThan(160);
    }
  });

  it('accepts fixed observations without granting SLO or production acceptance', () => {
    expect(windowsLibraryObservationSchema.parse(report)).toEqual(report);
    const local = { ...report, execution: 'local', source_commit: null };
    expect(windowsLibraryObservationSchema.parse(local)).toEqual(local);
  });

  it.each([
    { production_accepted: true },
    { slo_accepted: true },
    { execution: 'local' },
    { source_commit: null },
    { source_commit: `${report.source_commit}\n` },
    { platform: 'linux' },
    { architecture: 'arm64' },
    { setup: 'plaintext_database' },
    { latency_scope: 'render_frame_latency' },
    { cohort: { ...report.cohort, documents: 100 } },
    { process_restarts: 0 },
    { first_page_documents: 1100 },
    { empty_search_responses: 0 },
    { selected_edits_survived_restarts: false },
    { plaintext_marker_absent: false },
    { natural_exit_verified: false },
    { resources_cleaned: false },
    { maximum_measured_response_utf8_bytes: 512 * 1024 + 1 },
    { document_id: 'a-private-identifier' },
    { note: 'a-private-body' },
    {
      latency: {
        ...report.latency,
        first_full_scan_after_startup: latencySummary([1]),
      },
    },
    {
      latency: {
        ...report.latency,
        distinct_warm_full_scan: {
          ...report.latency.distinct_warm_full_scan,
          maximum_ms: Number.POSITIVE_INFINITY,
        },
      },
    },
  ])('rejects unsupported, incomplete or identifying evidence %j', (change) => {
    expect(
      windowsLibraryObservationSchema.safeParse({ ...report, ...change })
        .success,
    ).toBe(false);
  });

  it.each([-1, 1100, 1.5, Number.NaN])(
    'rejects an out-of-cohort fixture index %s',
    (index) => {
      expect(() => windowsLibraryFields(index)).toThrow();
    },
  );
});
