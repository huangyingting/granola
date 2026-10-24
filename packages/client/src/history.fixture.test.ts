import { describe, expect, it } from 'vitest';
import { jobHistorySchema } from '@windows-ai-notes/contracts/server';
import { latencySummary } from './load.fixture.js';
import {
  WINDOWS_HISTORY_JOBS,
  windowsHistoryJobs,
  windowsHistoryObservationSchema,
} from './history.fixture.js';

describe('body-free Windows saved-history observations', () => {
  const document = '10000000-0000-4000-8000-000000000001';
  const jobs = windowsHistoryJobs(document);
  const report = {
    version: 1,
    kind: 'controlled_windows_saved_history',
    scope: 'synthetic_unpacked_windows_dpapi',
    execution: 'github_actions',
    source_commit: 'a'.repeat(40),
    observed_at: '2026-10-24T14:50:00.000Z',
    platform: 'win32',
    architecture: 'x64',
    production_accepted: false,
    slo_accepted: false,
    setup: 'synthetic_service_then_service_and_issuer_shutdown',
    latency_scope: 'sandboxed_renderer_validated_ipc_round_trip',
    cohort: {
      documents: 2,
      saved_jobs: 20,
      full_history_utf8_bytes: Buffer.byteLength(JSON.stringify({ jobs })),
      encrypted_job_records: 22,
    },
    process_restarts: 4,
    latency: {
      first_history_selection_after_startup: latencySummary([100, 150, 200]),
      warm_status: latencySummary(
        Array.from({ length: 15 }, (_, index) => index + 1),
      ),
      selected_note_save: latencySummary([20, 30, 40]),
      explicit_saved_result: latencySummary([50, 60, 70]),
    },
    maximum_measured_status_response_utf8_bytes: 16_000,
    maximum_measured_result_response_utf8_bytes: 100_000,
    all_full_results_verified: 20,
    metadata_body_free: true,
    encrypted_artifacts_unchanged: true,
    selected_saves_survived_restarts: true,
    plaintext_marker_absent: true,
    natural_exit_verified: true,
    resources_cleaned: true,
  };

  it('generates twenty distinct, substantial, deterministic valid saved summaries', () => {
    expect(jobHistorySchema.parse({ jobs }).jobs).toHaveLength(
      WINDOWS_HISTORY_JOBS,
    );
    expect(new Set(jobs.map((job) => job.id)).size).toBe(20);
    expect(
      jobs.every(
        (job) =>
          job.document_id === document &&
          job.result?.kind === 'summary' &&
          job.result.provider === 'fixture',
      ),
    ).toBe(true);
    expect(windowsHistoryJobs(document)).toEqual(jobs);
    expect(report.cohort.full_history_utf8_bytes).toBeGreaterThanOrEqual(
      1024 * 1024,
    );
    expect(report.cohort.full_history_utf8_bytes).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
  });
  it('accepts source-bound diagnostics without production or SLO authority', () => {
    expect(windowsHistoryObservationSchema.parse(report)).toEqual(report);
    const local = { ...report, execution: 'local', source_commit: null };
    expect(windowsHistoryObservationSchema.parse(local)).toEqual(local);
  });
  it.each([
    { production_accepted: true },
    { slo_accepted: true },
    { execution: 'local' },
    { source_commit: null },
    { source_commit: `${report.source_commit}\n` },
    { platform: 'linux' },
    { architecture: 'arm64' },
    { setup: 'live_provider' },
    { latency_scope: 'render_frame_latency' },
    { cohort: { ...report.cohort, saved_jobs: 1 } },
    { cohort: { ...report.cohort, full_history_utf8_bytes: 1024 } },
    { cohort: { ...report.cohort, encrypted_job_records: 21 } },
    { process_restarts: 0 },
    { all_full_results_verified: 3 },
    { metadata_body_free: false },
    { encrypted_artifacts_unchanged: false },
    { selected_saves_survived_restarts: false },
    { plaintext_marker_absent: false },
    { natural_exit_verified: false },
    { resources_cleaned: false },
    { maximum_measured_status_response_utf8_bytes: 512 * 1024 + 1 },
    { maximum_measured_result_response_utf8_bytes: Number.POSITIVE_INFINITY },
    { document_id: document },
    { summary: 'a private body' },
    { latency: { ...report.latency, warm_status: latencySummary([1]) } },
  ])(
    'rejects incomplete, identifying or authority-shaped evidence %j',
    (change) => {
      expect(
        windowsHistoryObservationSchema.safeParse({ ...report, ...change })
          .success,
      ).toBe(false);
    },
  );
  it.each(['', 'invalid', `${document}\n`])(
    'rejects an invalid document identifier %j',
    (id) => {
      expect(() => windowsHistoryJobs(id)).toThrow();
    },
  );
});
