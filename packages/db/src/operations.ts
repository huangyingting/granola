import {
  operationsSnapshotSchema,
  taskOutcomesSnapshotSchema,
  taskOutcomeKindsSnapshotSchema,
} from '@windows-ai-notes/contracts/operations';
import type { Database, Transaction } from './index.js';
import {
  recordingCleanupEligibility,
  recordingObjectDisposable,
} from './recordings.js';

const units = ['input_tokens', 'output_tokens', 'audio_ms'] as const;
const zero = `'{"input_tokens":"0","output_tokens":"0","audio_ms":"0"}'::jsonb`;
const jobMetadata = `
  SELECT j.state,j.created_at,j.lease_until,
    (d.deleted_at IS NULL AND m.active AND u.active AND
      ((j.state IN ('queued','retry_wait') AND j.available_at<=now())
        OR (j.state='running' AND j.lease_until<now()))) claimable
  FROM jobs j JOIN documents d ON d.id=j.document_id
  JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=j.owner_id
  JOIN users u ON u.id=j.owner_id`;
const usageMetadata = `
  SELECT a.limits,coalesce(p.settled,${zero}) settled,
    coalesce(p.uncertain,${zero}) uncertain,
    coalesce(p.settled_requests,0) settled_requests,
    coalesce(p.uncertain_requests,0) uncertain_requests
  FROM ai_usage_accounts a LEFT JOIN ai_usage_periods p
    ON p.owner_id=a.owner_id
    AND p.period_start=date_trunc('month',now() AT TIME ZONE 'UTC')::date`;

async function value(tx: Transaction, sql: string): Promise<unknown> {
  const row = (await tx.query<{ value: unknown }>(sql)).rows[0];
  if (!row) throw new Error('Operational measurement did not return a row.');
  return row.value;
}
function validTotals(column: 'settled' | 'uncertain') {
  return `(${column} ?& ARRAY['input_tokens','output_tokens','audio_ms']
    AND ${column}-ARRAY['input_tokens','output_tokens','audio_ms']='{}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(${column}) v
      WHERE jsonb_typeof(v.value)<>'string'
        OR (v.value#>>'{}') !~ '^(0|[1-9][0-9]{0,29})$'))`;
}
function totals(column: 'settled' | 'uncertain') {
  return `jsonb_build_object(${units
    .map(
      (unit) =>
        `'${unit}',coalesce(sum((${column}->>'${unit}')::numeric),0)::text`,
    )
    .join(',')})`;
}
function oldestAge(column: 'created_at' | 'eligible_at', filter: string) {
  const oldest = `min(${column}) FILTER (WHERE ${filter})`;
  return `CASE WHEN ${oldest} IS NOT NULL THEN
    greatest(0,floor(extract(epoch FROM now()-${oldest})*1000))::text END`;
}

export async function operationsSnapshot(database: Database) {
  await database.assertSchemaReady();
  return database.transaction(async (tx) => {
    await tx.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    const clock = (
      await tx.query<{ observed_at: Date }>('SELECT now() observed_at')
    ).rows[0];
    if (!clock) throw new Error('Operational measurement has no timestamp.');
    const invalidUsage = await value(
      tx,
      `WITH accounts AS (${usageMetadata})
       SELECT count(*)::text value FROM accounts WHERE NOT (
         ${validTotals('settled')} AND ${validTotals('uncertain')}
         AND limits ?& ARRAY['input_tokens','output_tokens','audio_ms']
         AND limits-ARRAY['input_tokens','output_tokens','audio_ms']='{}'::jsonb
         AND NOT EXISTS (SELECT 1 FROM jsonb_each(limits) v
           WHERE jsonb_typeof(v.value)<>'number'
             OR (v.value#>>'{}')::numeric NOT BETWEEN 0 AND 1000000000000
             OR mod((v.value#>>'{}')::numeric,1)<>0))`,
    );
    if (invalidUsage !== '0')
      throw new Error('Operational usage accounting is invalid.');
    const jobs = await value(
      tx,
      `WITH metadata AS (${jobMetadata})
       SELECT jsonb_build_object(
         'queued',count(*) FILTER (WHERE state='queued')::text,
         'retry_wait',count(*) FILTER (WHERE state='retry_wait')::text,
         'running',count(*) FILTER (WHERE state='running')::text,
         'succeeded',count(*) FILTER (WHERE state='succeeded')::text,
         'failed',count(*) FILTER (WHERE state='failed')::text,
         'cancelled',count(*) FILTER (WHERE state='cancelled')::text,
         'claimable',count(*) FILTER (WHERE claimable)::text,
         'expired_leases',count(*) FILTER (WHERE state='running' AND lease_until<now())::text,
         'oldest_claimable_age_ms',${oldestAge('created_at', 'claimable')}
       ) value FROM metadata`,
    );
    const chat = await value(
      tx,
      `WITH job_metadata AS (${jobMetadata}), metadata AS (
         SELECT t.state,t.created_at,t.lease_until,
           (d.deleted_at IS NULL AND d.owner_id=t.owner_id AND m.active AND u.active AND t.expires_at>now()
             AND (t.state='queued' OR (t.state='running' AND t.lease_until<now()))
             AND t.created_at<=coalesce(
               (SELECT min(created_at) FROM job_metadata WHERE claimable),'infinity'::timestamptz)) claimable
         FROM chat_turns t JOIN documents d ON d.id=t.document_id
         JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=t.owner_id
         JOIN users u ON u.id=t.owner_id
       ) SELECT jsonb_build_object(
         'queued',count(*) FILTER (WHERE state='queued')::text,
         'running',count(*) FILTER (WHERE state='running')::text,
         'succeeded',count(*) FILTER (WHERE state='succeeded')::text,
         'failed',count(*) FILTER (WHERE state='failed')::text,
         'cancelled',count(*) FILTER (WHERE state='cancelled')::text,
         'claimable',count(*) FILTER (WHERE claimable)::text,
         'expired_leases',count(*) FILTER (WHERE state='running' AND lease_until<now())::text,
         'oldest_claimable_age_ms',${oldestAge('created_at', 'claimable')}
       ) value FROM metadata`,
    );
    const live = await value(
      tx,
      `SELECT jsonb_build_object(
         'open_leases',count(*) FILTER (WHERE closed_at IS NULL)::text,
         'expired_open_leases',count(*) FILTER
           (WHERE closed_at IS NULL AND least(lease_until,deadline,access_expires_at)<=now())::text,
         'closed_last_hour',jsonb_build_object(
           'settled',count(*) FILTER (WHERE closed_at BETWEEN now()-interval '1 hour' AND now() AND close_code='settled')::text,
           'failed',count(*) FILTER (WHERE closed_at BETWEEN now()-interval '1 hour' AND now() AND close_code='failed')::text,
           'expired',count(*) FILTER (WHERE closed_at BETWEEN now()-interval '1 hour' AND now() AND close_code='expired')::text,
           'cancelled',count(*) FILTER (WHERE closed_at BETWEEN now()-interval '1 hour' AND now() AND close_code='cancelled')::text)
       ) value FROM live_leases`,
    );
    const audio = await value(
      tx,
      `WITH metadata AS (
         SELECT o.deleted_at,o.last_error,greatest(o.protected_until,o.cleanup_after) eligible_at,
           (${recordingCleanupEligibility}) claimable,
           (${recordingObjectDisposable}) disposable
         FROM recording_objects o JOIN recordings r ON r.id=o.recording_id
       ) SELECT jsonb_build_object(
         'expired_recordings_awaiting_revocation',(SELECT count(*)::text FROM recordings
           WHERE deleted_at IS NULL AND retention_expires_at<=now()),
         'pending_object_deletions',count(*) FILTER (WHERE deleted_at IS NULL AND disposable)::text,
         'object_deletions_claimable',count(*) FILTER (WHERE deleted_at IS NULL AND claimable)::text,
         'object_deletion_errors',count(*) FILTER (WHERE deleted_at IS NULL AND disposable AND last_error IS NOT NULL)::text,
         'tombstone_rechecks_claimable',count(*) FILTER (WHERE deleted_at IS NOT NULL AND claimable)::text,
         'oldest_claimable_deletion_age_ms',
           ${oldestAge('eligible_at', 'deleted_at IS NULL AND claimable')}
       ) value FROM metadata`,
    );
    const usage = await value(
      tx,
      `WITH accounts AS (${usageMetadata})
       SELECT jsonb_build_object(
         'period_start',to_char(date_trunc('month',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD'),
         'period_end',to_char(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month','YYYY-MM-DD'),
         'accounts',count(*)::text,
         'over_budget_accounts',count(*) FILTER (WHERE ${units
           .map(
             (unit) =>
               `((settled->>'${unit}')::numeric+(uncertain->>'${unit}')::numeric)>(limits->>'${unit}')::numeric`,
           )
           .join(' OR ')})::text,
         'settled',${totals('settled')},
         'uncertain',${totals('uncertain')},
         'settled_requests',coalesce(sum(settled_requests),0)::text,
         'uncertain_requests',coalesce(sum(uncertain_requests),0)::text,
         'unsettled_calls_all_periods',(SELECT count(*)::text FROM ai_usage_calls WHERE settled_at IS NULL)
       ) value FROM accounts`,
    );
    return operationsSnapshotSchema.parse({
      version: 1,
      scope: 'deployment',
      observed_at: clock.observed_at.toISOString(),
      jobs,
      chat,
      live,
      audio,
      usage,
    });
  });
}

export async function taskOutcomesSnapshot(database: Database) {
  return readTaskOutcomes(database, false, (value) =>
    taskOutcomesSnapshotSchema.parse(value),
  );
}

export async function taskOutcomeKindsSnapshot(database: Database) {
  return readTaskOutcomes(database, true, (value) =>
    taskOutcomeKindsSnapshotSchema.parse(value),
  );
}

async function readTaskOutcomes<T>(
  database: Database,
  byKind: boolean,
  parse: (value: unknown) => T,
) {
  await database.assertSchemaReady();
  return database.transaction(async (tx) => {
    await tx.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    return parse(
      await value(
        tx,
        `WITH clock AS MATERIALIZED (
           SELECT observed_since,recovery_pending,clock_timestamp() observed_at
           FROM task_outcome_coverage WHERE singleton
         ), bounds AS (
           SELECT *,greatest(observed_since,observed_at-interval '24 hours') window_start FROM clock
         ), recent AS (
           SELECT a.resource_type,a.job_kind,a.to_state FROM audit_events a CROSS JOIN bounds b
           WHERE NOT b.recovery_pending AND a.created_at BETWEEN b.window_start AND b.observed_at
             AND ((a.resource_type='job' AND a.action IN ('job_created','job_state_changed')) OR
               (a.resource_type='chat_turn' AND a.action IN ('chat_turn_created','chat_turn_state_changed')))
             AND a.to_state IN ('succeeded','failed','cancelled') AND a.from_state IS DISTINCT FROM a.to_state
         ), totals AS (
           SELECT f.family,
             count(*) FILTER (WHERE a.to_state='succeeded') succeeded,
             count(*) FILTER (WHERE a.to_state='failed') failed,
             count(*) FILTER (WHERE a.to_state='cancelled') cancelled
           FROM (VALUES ${
             byKind
               ? "('summary','job','summary'),('transcription','job','transcription'),('recording_transcription','job','recording_transcription'),('unclassified','job','unclassified'),('chat','chat_turn',NULL)"
               : "('jobs','job',NULL),('chat','chat_turn',NULL)"
           }) f(family,resource_type,job_kind)
           LEFT JOIN recent a ON a.resource_type=f.resource_type
             AND (f.job_kind IS NULL OR coalesce(a.job_kind,'unclassified')=f.job_kind)
           GROUP BY f.family
         ), entries AS (
           SELECT jsonb_object_agg(family,jsonb_build_object(
             'succeeded',succeeded::text,'failed',failed::text,'cancelled',cancelled::text,
             'non_cancelled_terminal_entries',(succeeded::numeric+failed)::text,
             'success_share_ppm',CASE WHEN succeeded::numeric+failed>0
               THEN div(succeeded::numeric*1000000,succeeded::numeric+failed)::integer END
           )) value FROM totals
         ) SELECT jsonb_build_object(
           'version',1,'scope','deployment','basis','audit_terminal_state_entries',
           ${byKind ? "'breakdown','job_kind'," : ''}
           'status',CASE WHEN b.recovery_pending THEN 'recovery_pending' ELSE 'observing' END,
           'observed_at',to_char(b.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'coverage_since',to_char(b.observed_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'window_start',to_char(b.window_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'window_hours',24,'window_complete',b.observed_since<=b.observed_at-interval '24 hours',
           'entries',CASE WHEN b.recovery_pending THEN NULL ELSE ${
             byKind
               ? "jsonb_build_object('jobs',entries.value-'chat','chat',entries.value->'chat')"
               : 'entries.value'
           } END
         ) value FROM bounds b CROSS JOIN entries`,
      ),
    );
  });
}
