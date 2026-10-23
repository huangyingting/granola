import { describe, expect, it } from 'vitest';
import {
  taskOutcomesSnapshotSchema,
  taskOutcomeKindsSnapshotSchema,
} from './operations.js';

const empty = {
  succeeded: '0',
  failed: '0',
  cancelled: '0',
  non_cancelled_terminal_entries: '0',
  success_share_ppm: null,
};
const snapshot = {
  version: 1,
  scope: 'deployment',
  basis: 'audit_terminal_state_entries',
  status: 'observing',
  observed_at: '2026-06-20T12:00:00.123456Z',
  coverage_since: '2026-06-18T12:00:00.123456Z',
  window_start: '2026-06-19T12:00:00.123456Z',
  window_hours: 24,
  window_complete: true,
  entries: { jobs: empty, chat: empty },
};

describe('deployment task-outcome contract', () => {
  it('distinguishes empty, cancellation-only and unavailable observations', () => {
    expect(taskOutcomesSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      taskOutcomesSnapshotSchema.parse({
        ...snapshot,
        entries: { jobs: { ...empty, cancelled: '40' }, chat: empty },
      }).entries?.jobs.success_share_ppm,
    ).toBeNull();
    expect(
      taskOutcomesSnapshotSchema.parse({
        ...snapshot,
        status: 'recovery_pending',
        entries: null,
      }).entries,
    ).toBeNull();
    for (const value of [
      { ...snapshot, entries: null },
      { ...snapshot, status: 'recovery_pending' },
      { ...snapshot, notes: 'private' },
      { ...snapshot, entries: { ...snapshot.entries, account_id: 'private' } },
      {
        ...snapshot,
        entries: { ...snapshot.entries, jobs: { ...empty, id: 'private' } },
      },
    ])
      expect(taskOutcomesSnapshotSchema.safeParse(value).success).toBe(false);
  });

  describe('deployment task-kind outcome contract', () => {
    const detailed = {
      ...snapshot,
      breakdown: 'job_kind',
      entries: {
        jobs: {
          summary: empty,
          transcription: empty,
          recording_transcription: empty,
          unclassified: empty,
        },
        chat: empty,
      },
    };
    it('requires every fixed label, preserves unknown historical entries and keeps aggregate v1 distinct', () => {
      const legacy = {
        ...empty,
        failed: '3',
        non_cancelled_terminal_entries: '3',
        success_share_ppm: 0,
      };
      const value = {
        ...detailed,
        entries: {
          ...detailed.entries,
          jobs: { ...detailed.entries.jobs, unclassified: legacy },
        },
      };
      expect(taskOutcomeKindsSnapshotSchema.parse(value)).toEqual(value);
      expect(taskOutcomesSnapshotSchema.safeParse(value).success).toBe(false);
      expect(taskOutcomeKindsSnapshotSchema.safeParse(snapshot).success).toBe(
        false,
      );
      for (const jobs of [
        {},
        { ...detailed.entries.jobs, private_identifier: empty },
        { ...detailed.entries.jobs, summary: { ...empty, notes: 'private' } },
      ]) {
        expect(
          taskOutcomeKindsSnapshotSchema.safeParse({
            ...detailed,
            entries: { ...detailed.entries, jobs },
          }).success,
        ).toBe(false);
      }
    });
    it.each([
      'summary',
      'transcription',
      'recording_transcription',
      'unclassified',
    ])('validates exact terminal accounting for %s', (kind) => {
      const counts = {
        succeeded: '9007199254740993',
        failed: '18014398509481986',
        cancelled: '9',
        non_cancelled_terminal_entries: '27021597764222979',
        success_share_ppm: 333333,
      };
      for (const [change, valid] of [
        [{}, true],
        [{ failed: 'private' }, false],
        [{ non_cancelled_terminal_entries: '0' }, false],
        [{ success_share_ppm: 333334 }, false],
      ] as const) {
        expect(
          taskOutcomeKindsSnapshotSchema.safeParse({
            ...detailed,
            entries: {
              ...detailed.entries,
              jobs: {
                ...detailed.entries.jobs,
                [kind]: { ...counts, ...change },
              },
            },
          }).success,
        ).toBe(valid);
      }
    });
    it('retains recovery quarantine and truthful window checks for the breakdown', () => {
      expect(
        taskOutcomeKindsSnapshotSchema.parse({
          ...detailed,
          status: 'recovery_pending',
          entries: null,
        }).entries,
      ).toBeNull();
      for (const change of [
        { status: 'recovery_pending' },
        { entries: null },
        { window_complete: false },
        { coverage_since: '2026-06-21T12:00:00.123456Z' },
        { window_start: '2026-06-19T12:00:00.123457Z' },
      ]) {
        expect(
          taskOutcomeKindsSnapshotSchema.safeParse({ ...detailed, ...change })
            .success,
        ).toBe(false);
      }
    });
  });
  it('checks the exact non-cancelled denominator and truncated millionths above safe integers', () => {
    const jobs = {
      succeeded: '9007199254740993',
      failed: '18014398509481986',
      cancelled: '9007199254740995',
      non_cancelled_terminal_entries: '27021597764222979',
      success_share_ppm: 333333,
    };
    expect(
      taskOutcomesSnapshotSchema.parse({
        ...snapshot,
        entries: { jobs, chat: empty },
      }).entries?.jobs,
    ).toEqual(jobs);
    for (const change of [
      { non_cancelled_terminal_entries: '27021597764222978' },
      { success_share_ppm: 333334 },
      { success_share_ppm: null },
      { success_share_ppm: -1 },
      { success_share_ppm: 1_000_001 },
      { success_share_ppm: 333333.1 },
    ])
      expect(
        taskOutcomesSnapshotSchema.safeParse({
          ...snapshot,
          entries: { jobs: { ...jobs, ...change }, chat: empty },
        }).success,
      ).toBe(false);
    expect(
      taskOutcomesSnapshotSchema.safeParse({
        ...snapshot,
        entries: {
          jobs: { ...empty, success_share_ppm: 0 },
          chat: empty,
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    'succeeded',
    'failed',
    'cancelled',
    'non_cancelled_terminal_entries',
  ])('rejects malformed %s without throwing from refinements', (field) => {
    for (const value of [
      -1,
      1,
      null,
      '',
      '-1',
      '01',
      '1.1',
      '1e3',
      'private',
      '1'.repeat(31),
    ])
      expect(
        taskOutcomesSnapshotSchema.safeParse({
          ...snapshot,
          entries: { jobs: { ...empty, [field]: value }, chat: empty },
        }).success,
      ).toBe(false);
  });
  it('exposes partial coverage and rejects contradictory windows', () => {
    const partial = {
      ...snapshot,
      coverage_since: '2026-06-20T11:00:00.123456Z',
      window_start: '2026-06-20T11:00:00.123456Z',
      window_complete: false,
    };
    expect(taskOutcomesSnapshotSchema.parse(partial)).toEqual(partial);
    for (const change of [
      { window_complete: true },
      { window_start: snapshot.window_start },
      { coverage_since: '2026-06-20T13:00:00.123456Z' },
      { coverage_since: '2026-06-20T12:00:00.123457Z' },
      { window_start: '2026-06-20T11:00:00.123457Z' },
      { observed_at: 'invalid' },
      { window_hours: 48 },
    ])
      expect(
        taskOutcomesSnapshotSchema.safeParse({ ...partial, ...change }).success,
      ).toBe(false);
  });
});
