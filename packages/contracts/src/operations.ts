import { z } from 'zod';
import { usageTotalsSchema } from './server.js';

const count = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
export const recordingMediaVerificationSchema = z
  .strictObject({
    version: z.literal(1),
    scope: z.literal('retained_verified_recording_chunks'),
    basis: z.literal('immutable_upload_size_and_sha256'),
    snapshot_at: z.iso.datetime({ precision: 6 }),
    verified_chunks: count,
    verified_bytes: count,
  })
  .superRefine((value, context) => {
    if (
      !count.safeParse(value.verified_chunks).success ||
      !count.safeParse(value.verified_bytes).success
    )
      return;
    const chunks = BigInt(value.verified_chunks);
    const bytes = BigInt(value.verified_bytes);
    if (bytes < chunks * 46n || bytes > chunks * 960_044n)
      context.addIssue({
        code: 'custom',
        message:
          'Verified byte totals must match bounded canonical chunk sizes.',
      });
  });
const age = count.nullable();
const outcomes = {
  succeeded: count,
  failed: count,
  cancelled: count,
};
export const operationsSnapshotSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal('deployment'),
  observed_at: z.iso.datetime(),
  jobs: z.strictObject({
    queued: count,
    retry_wait: count,
    running: count,
    ...outcomes,
    claimable: count,
    expired_leases: count,
    oldest_claimable_age_ms: age,
  }),
  chat: z.strictObject({
    queued: count,
    running: count,
    ...outcomes,
    claimable: count,
    expired_leases: count,
    oldest_claimable_age_ms: age,
  }),
  live: z.strictObject({
    open_leases: count,
    expired_open_leases: count,
    closed_last_hour: z.strictObject({
      settled: count,
      failed: count,
      expired: count,
      cancelled: count,
    }),
  }),
  audio: z.strictObject({
    expired_recordings_awaiting_revocation: count,
    pending_object_deletions: count,
    object_deletions_claimable: count,
    object_deletion_errors: count,
    tombstone_rechecks_claimable: count,
    oldest_claimable_deletion_age_ms: age,
  }),
  usage: z.strictObject({
    period_start: z.iso.date(),
    period_end: z.iso.date(),
    accounts: count,
    over_budget_accounts: count,
    settled: usageTotalsSchema,
    uncertain: usageTotalsSchema,
    settled_requests: count,
    uncertain_requests: count,
    unsettled_calls_all_periods: count,
  }),
});
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>;

export const operationsHousekeepingSnapshotSchema = operationsSnapshotSchema
  .extend({
    version: z.literal(2),
    housekeeping: z.strictObject({
      sync: z.strictObject({
        workspaces: count,
        expired_workspaces: count,
        expired_changes: count,
        oldest_expired_change_age_ms: age,
      }),
      replay: z.strictObject({
        expired_jobs: count,
        expired_events: count,
        oldest_expired_event_age_ms: age,
      }),
      recordings: z.strictObject({
        obsolete_runs: count,
        retired_runs: count,
        chunks_pending_cleanup: count,
      }),
      summaries: z.strictObject({
        obsolete_runs: count,
        retired_runs: count,
        steps_pending_cleanup: count,
        resume_receipts_pending_cleanup: count,
      }),
    }),
  })
  .superRefine(({ housekeeping: h }, context) => {
    const counts = [
      h.sync.workspaces,
      h.sync.expired_workspaces,
      h.sync.expired_changes,
      h.replay.expired_jobs,
      h.replay.expired_events,
      ...Object.values(h.recordings),
      ...Object.values(h.summaries),
    ];
    if (counts.some((value) => !count.safeParse(value).success)) return;
    if (
      BigInt(h.sync.expired_workspaces) > BigInt(h.sync.workspaces) ||
      BigInt(h.sync.expired_workspaces) > BigInt(h.sync.expired_changes) ||
      (h.sync.expired_changes === '0') !==
        (h.sync.expired_workspaces === '0') ||
      (h.sync.expired_changes === '0') !==
        (h.sync.oldest_expired_change_age_ms === null) ||
      BigInt(h.replay.expired_jobs) > BigInt(h.replay.expired_events) ||
      (h.replay.expired_events === '0') !== (h.replay.expired_jobs === '0') ||
      (h.replay.expired_events === '0') !==
        (h.replay.oldest_expired_event_age_ms === null) ||
      BigInt(h.recordings.retired_runs) > BigInt(h.recordings.obsolete_runs) ||
      BigInt(h.summaries.retired_runs) > BigInt(h.summaries.obsolete_runs) ||
      (h.recordings.obsolete_runs === '0' &&
        h.recordings.chunks_pending_cleanup !== '0') ||
      (h.summaries.obsolete_runs === '0' &&
        (h.summaries.steps_pending_cleanup !== '0' ||
          h.summaries.resume_receipts_pending_cleanup !== '0'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Housekeeping backlog counts and ages are inconsistent.',
      });
  });
export type OperationsHousekeepingSnapshot = z.infer<
  typeof operationsHousekeepingSnapshotSchema
>;

const terminalEntriesSchema = z
  .strictObject({
    ...outcomes,
    non_cancelled_terminal_entries: count,
    success_share_ppm: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .superRefine((value, context) => {
    if (
      ![
        value.succeeded,
        value.failed,
        value.non_cancelled_terminal_entries,
      ].every((entry) => count.safeParse(entry).success)
    )
      return;
    const denominator = BigInt(value.succeeded) + BigInt(value.failed);
    if (
      denominator !== BigInt(value.non_cancelled_terminal_entries) ||
      value.success_share_ppm !==
        (denominator === 0n
          ? null
          : Number((BigInt(value.succeeded) * 1_000_000n) / denominator))
    )
      context.addIssue({
        code: 'custom',
        message: 'Terminal counts and non-cancelled success share disagree.',
      });
  });

const taskOutcomesHeaderSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal('deployment'),
  basis: z.literal('audit_terminal_state_entries'),
  status: z.enum(['observing', 'recovery_pending']),
  observed_at: z.iso.datetime({ precision: 6 }),
  coverage_since: z.iso.datetime({ precision: 6 }),
  window_start: z.iso.datetime({ precision: 6 }),
  window_hours: z.literal(24),
  window_complete: z.boolean(),
});
function consistentWindow(value: z.infer<typeof taskOutcomesHeaderSchema>) {
  const end = Date.parse(value.observed_at);
  if (!Number.isFinite(end)) return false;
  const cutoff =
    new Date(end - 86_400_000).toISOString().slice(0, 23) +
    value.observed_at.slice(23);
  const complete = value.coverage_since <= cutoff;
  return (
    value.coverage_since <= value.observed_at &&
    value.window_start ===
      (value.coverage_since > cutoff ? value.coverage_since : cutoff) &&
    value.window_complete === complete
  );
}
const windowMessage = 'Task-outcome observation window is inconsistent.';
const recoveryMessage = 'Recovery-pending observations must not report counts.';
function consistentRecovery(value: {
  status: 'observing' | 'recovery_pending';
  entries: unknown;
}) {
  return (value.status === 'recovery_pending') === (value.entries === null);
}

export const taskOutcomesSnapshotSchema = taskOutcomesHeaderSchema
  .extend({
    entries: z
      .strictObject({
        jobs: terminalEntriesSchema,
        chat: terminalEntriesSchema,
      })
      .nullable(),
  })
  .refine(consistentRecovery, recoveryMessage)
  .refine(consistentWindow, windowMessage);
export type TaskOutcomesSnapshot = z.infer<typeof taskOutcomesSnapshotSchema>;

export const taskOutcomeKindsSnapshotSchema = taskOutcomesHeaderSchema
  .extend({
    breakdown: z.literal('job_kind'),
    entries: z
      .strictObject({
        jobs: z.strictObject({
          summary: terminalEntriesSchema,
          transcription: terminalEntriesSchema,
          recording_transcription: terminalEntriesSchema,
          unclassified: terminalEntriesSchema,
        }),
        chat: terminalEntriesSchema,
      })
      .nullable(),
  })
  .refine(consistentRecovery, recoveryMessage)
  .refine(consistentWindow, windowMessage);
export type TaskOutcomeKindsSnapshot = z.infer<
  typeof taskOutcomeKindsSnapshotSchema
>;
