import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ServiceError,
  jobInputSchema,
  summaryResultSchema,
  summarySnapshotCitations,
  validateSummaryCitations,
  citationKey,
  usageTotalsSchema,
  type Usage,
} from '@windows-ai-notes/contracts/server';
import {
  MAX_SUMMARY_STEPS,
  summaryStageKeySchema,
  summaryStageSpecSchema,
  summaryStageOutputSchema,
  summaryProgressSchema,
  validateEvidenceFacts,
  type SummaryStageKey,
  type SummaryStageSpec,
  type SummaryStageOutput,
  type SummaryProgress,
} from '@windows-ai-notes/contracts/evidence';
import {
  digest,
  type Database,
  type Transaction,
  type ClaimedJob,
} from './index.js';
import { usageTotals } from './usage.js';

const identitySchema = z.strictObject({
  provider: z.enum(['azure', 'fixture']),
  configurationVersion: z.string().min(1).max(200),
  pipelineVersion: z.string().min(1).max(80),
});
type Identity = z.infer<typeof identitySchema>;
interface Run {
  input_hash: string;
  provider: Identity['provider'];
  configuration_version: string;
  pipeline_version: string;
  resume_token: string;
  fresh: boolean;
}
interface Step extends SummaryStageSpec {
  state: 'pending' | 'sending' | 'completed';
  call_id: string | null;
  owned: boolean;
  output: unknown | null;
}
type Progress = Omit<
  SummaryProgress,
  'document_id' | 'job_id' | 'resume_available'
> & {
  fresh: boolean;
};
const expired = () =>
  new ServiceError(
    'summary_progress_expired',
    'Saved summary progress is unavailable or expired. Confirm a new summary request instead of replaying old provider work.',
    410,
  );
const changed = () =>
  new ServiceError(
    'summary_stage_changed',
    'The saved summary stage no longer matches its immutable input or prompt version.',
    409,
  );
const snapshot = (job: ClaimedJob) => {
  if (job.input.kind !== 'summary') throw new Error('Expected a summary job.');
  return job.input.snapshot;
};
const keyValues = (job: ClaimedJob, key: SummaryStageKey) => [
  job.id,
  key.phase,
  key.round,
  key.index,
];
const operation = (key: SummaryStageKey) =>
  `summary:${key.phase}:${key.round}:${key.index}`;
const stageKey = (value: SummaryStageKey) =>
  summaryStageKeySchema.parse({
    phase: value.phase,
    round: value.round,
    index: value.index,
  });

export class SummaryStages {
  constructor(private readonly database: Database) {}

  private async authorize(tx: Transaction, user: string, id: string) {
    const active = await tx.query(
      'SELECT id FROM users WHERE id=$1 AND active FOR SHARE',
      [user],
    );
    if (!active.rowCount)
      throw new ServiceError(
        'workspace_access_revoked',
        'This account no longer has access to summary processing.',
        403,
      );
    const document = await this.database.document(user, id, tx);
    const membership = await tx.query(
      'SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active FOR SHARE',
      [document.workspace_id, user],
    );
    if (!membership.rowCount)
      throw new ServiceError(
        'workspace_access_revoked',
        'This workspace no longer permits summary processing.',
        403,
      );
    const visible = await tx.query(
      'SELECT id FROM documents WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR SHARE',
      [id, user],
    );
    if (!visible.rowCount)
      throw new ServiceError(
        'document_not_found',
        'The meeting is no longer available.',
        404,
      );
  }
  private async guard(tx: Transaction, job: ClaimedJob) {
    const input = snapshot(job);
    await this.authorize(tx, job.ownerId, job.documentId);
    const row = (
      await tx.query<{
        valid: boolean;
        input: unknown;
        summary_started: boolean;
      }>(
        `SELECT state='running' AND lease_token=$2 AND lease_until>now()
       AND owner_id=$3 AND document_id=$4 AND kind='summary' valid,input,summary_started
       FROM jobs WHERE id=$1 FOR UPDATE`,
        [job.id, job.leaseToken, job.ownerId, job.documentId],
      )
    ).rows[0];
    if (!row?.valid)
      throw new ServiceError(
        'job_lease_lost',
        'This summary attempt no longer owns its job.',
        409,
      );
    if (
      input.document_id !== job.documentId ||
      digest(row.input, true) !== digest(job.input, true)
    )
      throw changed();
    return row;
  }
  private async run(tx: Transaction, id: string): Promise<Run> {
    const row = (
      await tx.query<Run>(
        `SELECT p.*,j.updated_at>now()-interval '24 hours' fresh FROM summary_runs p
         JOIN jobs j ON j.id=p.job_id WHERE p.job_id=$1 FOR UPDATE OF p`,
        [id],
      )
    ).rows[0];
    if (!row) throw expired();
    return row;
  }
  private async step(tx: Transaction, job: ClaimedJob, key: SummaryStageKey) {
    return (
      await tx.query<Step>(
        `SELECT phase,round,ordinal AS index,input_hash,prompt_version,citations,state,call_id,output,
       lease_token=$5 owned FROM summary_steps
       WHERE job_id=$1 AND phase=$2 AND round=$3 AND ordinal=$4 FOR UPDATE`,
        [...keyValues(job, key), job.leaseToken],
      )
    ).rows[0];
  }
  async begin(job: ClaimedJob, value: Identity) {
    const identity = identitySchema.parse(value);
    await this.database.transaction(async (tx) => {
      const selected = await this.guard(tx, job);
      const exists = (
        await tx.query('SELECT job_id FROM summary_runs WHERE job_id=$1', [
          job.id,
        ])
      ).rowCount;
      if (!exists) {
        const prior = (
          await tx.query(
            'SELECT id FROM ai_usage_calls WHERE job_id=$1 LIMIT 1',
            [job.id],
          )
        ).rowCount;
        if (selected.summary_started || prior) throw expired();
        await tx.query(
          `INSERT INTO summary_runs(job_id,input_hash,provider,configuration_version,pipeline_version,resume_token)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            job.id,
            digest(job.input, true),
            identity.provider,
            identity.configurationVersion,
            identity.pipelineVersion,
            randomUUID(),
          ],
        );
        await tx.query('UPDATE jobs SET summary_started=true WHERE id=$1', [
          job.id,
        ]);
      }
      const run = await this.run(tx, job.id);
      if (run.input_hash !== digest(job.input, true)) throw changed();
      if (!run.fresh) throw expired();
      if (
        run.provider !== identity.provider ||
        run.configuration_version !== identity.configurationVersion ||
        run.pipeline_version !== identity.pipelineVersion
      )
        throw new ServiceError(
          'provider_configuration_changed',
          'Restore the original summary processing configuration to resume, or confirm a new summary request.',
          409,
        );
    });
  }
  async prepare(job: ClaimedJob, value: SummaryStageSpec) {
    const spec = summaryStageSpecSchema.parse(value);
    return this.database.transaction(async (tx) => {
      await this.guard(tx, job);
      const run = await this.run(tx, job.id);
      if (run.input_hash !== digest(job.input, true)) throw changed();
      const allowed = new Set(
        summarySnapshotCitations(snapshot(job)).map(citationKey),
      );
      if (
        spec.citations.some((citation) => !allowed.has(citationKey(citation)))
      )
        throw new ServiceError(
          'invalid_citation',
          'The stage references material outside its frozen summary input.',
          502,
        );
      let step = await this.step(tx, job, spec);
      if (!step) {
        const count = (
          await tx.query<{ count: number }>(
            'SELECT count(*)::integer count FROM summary_steps WHERE job_id=$1',
            [job.id],
          )
        ).rows[0]!.count;
        if (count >= MAX_SUMMARY_STEPS)
          throw new ServiceError(
            'context_too_large',
            'This meeting exceeds the supported durable stage budget.',
            413,
          );
        await tx.query(
          `INSERT INTO summary_steps(job_id,phase,round,ordinal,input_hash,prompt_version,citations)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            ...keyValues(job, spec),
            spec.input_hash,
            spec.prompt_version,
            JSON.stringify(spec.citations),
          ],
        );
        step = await this.step(tx, job, spec);
      }
      if (
        !step ||
        step.input_hash !== spec.input_hash ||
        step.prompt_version !== spec.prompt_version ||
        digest(step.citations, true) !== digest(spec.citations, true)
      )
        throw changed();
      return {
        state: step.state,
        output:
          step.output === null
            ? null
            : summaryStageOutputSchema.parse(step.output),
      };
    });
  }
  async sending(job: ClaimedJob, value: SummaryStageKey, budget: Usage) {
    const key = stageKey(value);
    return this.database.transaction(async (tx) => {
      await this.guard(tx, job);
      const run = await this.run(tx, job.id);
      const step = await this.step(tx, job, key);
      if (!step) throw changed();
      if (step.state !== 'pending')
        throw new ServiceError(
          'summary_dispatch_unconfirmed',
          'This stage already has a provider dispatch or saved result. Refresh or explicitly resume instead of sending it twice.',
          409,
        );
      const call = await this.database.usage.start(
        job,
        {
          operation: operation(key),
          provider: run.provider,
          configurationVersion: run.configuration_version,
          budget,
        },
        tx,
      );
      await tx.query(
        `UPDATE summary_steps SET state='sending',call_id=$5,lease_token=$6,updated_at=now()
         WHERE job_id=$1 AND phase=$2 AND round=$3 AND ordinal=$4`,
        [...keyValues(job, key), call, job.leaseToken],
      );
      await tx.query(
        'UPDATE summary_runs SET updated_at=now() WHERE job_id=$1',
        [job.id],
      );
      return call;
    });
  }
  async save(
    job: ClaimedJob,
    value: SummaryStageKey,
    output: SummaryStageOutput,
  ) {
    const key = stageKey(value);
    const accepted = summaryStageOutputSchema.parse(output);
    return this.database.transaction(async (tx) => {
      await this.guard(tx, job);
      const run = await this.run(tx, job.id);
      const step = await this.step(tx, job, key);
      if (!step) throw changed();
      if ((key.phase === 'generate') !== (accepted.kind === 'summary'))
        throw changed();
      const usage =
        accepted.kind === 'summary' ? accepted.result.usage : accepted.usage;
      if (accepted.kind === 'summary') {
        if (
          accepted.result.provider !== run.provider ||
          accepted.result.configuration_version !== run.configuration_version ||
          accepted.result.prompt_version !== step.prompt_version
        )
          throw changed();
        validateSummaryCitations(accepted.result.summary, step.citations);
      } else validateEvidenceFacts({ facts: accepted.facts }, step.citations);
      if (step.state === 'completed') {
        if (digest(step.output, true) !== digest(accepted, true))
          throw changed();
        return;
      }
      if (step.state !== 'sending' || !step.call_id || !step.owned)
        throw new ServiceError(
          'job_lease_lost',
          'This attempt does not own the summary stage dispatch.',
          409,
        );
      const call = (
        await tx.query<{ actual: unknown | null }>(
          'SELECT actual FROM ai_usage_calls WHERE id=$1',
          [step.call_id],
        )
      ).rows[0];
      if (
        !call?.actual ||
        digest(usageTotalsSchema.parse(call.actual), true) !==
          digest(usageTotals(usage), true)
      )
        throw new ServiceError(
          'summary_usage_unconfirmed',
          'Settle the actual provider usage before saving this summary stage.',
          409,
        );
      await tx.query(
        `UPDATE summary_steps SET state='completed',output=$5,updated_at=now()
         WHERE job_id=$1 AND phase=$2 AND round=$3 AND ordinal=$4`,
        [...keyValues(job, key), JSON.stringify(accepted)],
      );
      await tx.query(
        'UPDATE summary_runs SET updated_at=now() WHERE job_id=$1',
        [job.id],
      );
      await this.database.event(tx, job.id, 'job.progress', {
        stage: `summary_${key.phase}`,
        round: key.round,
        index: key.index,
      });
    });
  }
  async completed(job: ClaimedJob) {
    return this.database.transaction(async (tx) => {
      const selected = await this.guard(tx, job);
      if (!selected.summary_started) return null;
      const run = await this.run(tx, job.id);
      if (run.input_hash !== digest(job.input, true)) throw changed();
      const step = await this.step(tx, job, {
        phase: 'generate',
        round: 0,
        index: 0,
      });
      if (step?.state !== 'completed') return null;
      const output = summaryStageOutputSchema.parse(step.output);
      if (
        output.kind !== 'summary' ||
        output.result.provider !== run.provider ||
        output.result.configuration_version !== run.configuration_version ||
        output.result.prompt_version !== step.prompt_version
      )
        throw changed();
      validateSummaryCitations(output.result.summary, step.citations);
      return summaryResultSchema.parse(output.result);
    });
  }
  async progress(user: string, id: string) {
    const job = await this.database.job(user, id);
    if (job.kind !== 'summary')
      throw new ServiceError(
        'unsupported_summary_job',
        'This job does not produce a meeting summary.',
        409,
      );
    const current = (
      await this.database.pool.query<Progress>(
        `SELECT j.state,p.resume_token,j.updated_at>now()-interval '24 hours' fresh,
         s.total_stages,s.completed_stages,c.provider_requests,c.uncertain_requests
         FROM jobs j LEFT JOIN summary_runs p ON p.job_id=j.id
         CROSS JOIN LATERAL (
           SELECT count(*)::integer total_stages,count(*) FILTER (WHERE state='completed')::integer completed_stages
           FROM summary_steps WHERE job_id=j.id
         ) s
         CROSS JOIN LATERAL (
           SELECT count(*)::integer provider_requests,count(*) FILTER (WHERE actual IS NULL)::integer uncertain_requests
           FROM ai_usage_calls WHERE job_id=j.id
         ) c WHERE j.id=$1`,
        [id],
      )
    ).rows[0];
    await this.database.document(user, job.document_id);
    if (!current)
      throw new ServiceError(
        'job_not_found',
        'The summary job is no longer available.',
        404,
      );
    const resume =
      current.state === 'failed' &&
      current.fresh &&
      current.resume_token !== null;
    return summaryProgressSchema.parse({
      document_id: job.document_id,
      job_id: id,
      state: current.state,
      total_stages: current.total_stages,
      completed_stages: current.completed_stages,
      provider_requests: current.provider_requests,
      uncertain_requests: current.uncertain_requests,
      resume_available: resume,
      resume_token: resume ? current.resume_token : null,
    });
  }
  async resume(user: string, id: string, token: string) {
    z.uuid().parse(token);
    const visible = await this.database.job(user, id);
    if (visible.kind !== 'summary')
      throw new ServiceError(
        'unsupported_retry',
        'This operation resumes a failed summary.',
        409,
      );
    await this.database.transaction(async (tx) => {
      // Match enqueue's budget-before-document lock order.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `job-budget:${user}`,
      ]);
      await this.authorize(tx, user, visible.document_id);
      const row = (
        await tx.query<{ state: string; input: unknown }>(
          'SELECT state,input FROM jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]!;
      const run = await this.run(tx, id);
      const replay = (
        await tx.query(
          'SELECT token FROM summary_resumes WHERE job_id=$1 AND token=$2',
          [id, token],
        )
      ).rowCount;
      if (replay) return;
      if (row.state !== 'failed')
        throw new ServiceError(
          'job_not_retryable',
          'Only a failed summary can be explicitly resumed.',
          409,
        );
      if (!run.fresh) throw expired();
      if (run.resume_token !== token)
        throw new ServiceError(
          'summary_resume_changed',
          'Refresh and confirm the latest failed summary before authorizing another provider attempt.',
          409,
        );
      const input = jobInputSchema.parse(row.input);
      if (input.kind !== 'summary' || digest(input, true) !== run.input_hash)
        throw changed();
      const pending = (
        await tx.query<{ count: number }>(
          "SELECT count(*)::integer count FROM jobs WHERE owner_id=$1 AND state IN ('queued','running','retry_wait')",
          [user],
        )
      ).rows[0]!.count;
      if (pending >= 8)
        throw new ServiceError(
          'quota_exceeded',
          'At most eight pending jobs are allowed per user.',
          429,
          true,
        );
      await tx.query(
        'INSERT INTO summary_resumes(job_id,token) VALUES ($1,$2)',
        [id, token],
      );
      await tx.query(
        "UPDATE summary_steps SET state='pending',call_id=NULL,lease_token=NULL,updated_at=now() WHERE job_id=$1 AND state='sending'",
        [id],
      );
      await tx.query(
        'UPDATE summary_runs SET resume_token=$2,updated_at=now() WHERE job_id=$1',
        [id, randomUUID()],
      );
      await tx.query(
        "UPDATE jobs SET state='queued',attempt=0,error=NULL,lease_token=lease_token+1,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await this.database.event(tx, id, 'job.accepted', {
        state: 'queued',
        resumed: true,
      });
    });
    return this.database.job(user, id);
  }
}
