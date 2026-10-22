import { z } from 'zod';
import { usageTotalsSchema } from './server.js';

const count = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
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
