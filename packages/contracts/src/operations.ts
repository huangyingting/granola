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
