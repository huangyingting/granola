import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ServiceError,
  DEFAULT_AI_LIMITS,
  accountUsageSchema,
  aiLimitsSchema,
  usageSchema,
  usageTotalsSchema,
  type Usage,
} from '@windows-ai-notes/contracts/server';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import type { Database, Transaction, ClaimedJob } from './index.js';
import { LIVE_MEDIA_MS, type LiveClaim } from './live.js';

const units = ['input_tokens', 'output_tokens', 'audio_ms'] as const;
type Totals = z.infer<typeof usageTotalsSchema>;
const zero = (): Totals => ({
  input_tokens: '0',
  output_tokens: '0',
  audio_ms: '0',
});
function totals(value: Usage): Totals {
  const parsed = usageSchema.parse(value);
  if (units.some((unit) => !Number.isSafeInteger(Math.ceil(parsed[unit]))))
    throw new ServiceError(
      'invalid_usage',
      'Provider usage exceeds supported numeric precision.',
      502,
    );
  return {
    input_tokens: String(parsed.input_tokens),
    output_tokens: String(parsed.output_tokens),
    audio_ms: String(Math.ceil(parsed.audio_ms)),
  };
}
function add(left: Totals, right: Totals, sign = 1n): Totals {
  const combine = (unit: (typeof units)[number]) =>
    String(BigInt(left[unit]) + sign * BigInt(right[unit]));
  return usageTotalsSchema.parse({
    input_tokens: combine('input_tokens'),
    output_tokens: combine('output_tokens'),
    audio_ms: combine('audio_ms'),
  });
}
const exceeds = (value: Totals, limits: Totals) =>
  units.some((unit) => BigInt(value[unit]) > BigInt(limits[unit]));
export interface UsageReservation {
  operation: string;
  provider: 'azure' | 'fixture';
  configurationVersion: string;
  budget: Usage;
}
interface Period {
  settled: unknown;
  uncertain: unknown;
  settled_requests: string;
  uncertain_requests: string;
}
interface Call {
  owner_id: string;
  period_start: string;
  reserved: unknown;
  actual: unknown | null;
  live_lease_id: string | null;
}
export class UsageStore {
  constructor(private readonly database: Database) {}
  private async account(tx: Transaction, owner: string) {
    await tx.query(
      'INSERT INTO ai_usage_accounts VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [owner, JSON.stringify(DEFAULT_AI_LIMITS)],
    );
    const row = (
      await tx.query<{ limits: unknown }>(
        'SELECT limits FROM ai_usage_accounts WHERE owner_id=$1 FOR UPDATE',
        [owner],
      )
    ).rows[0];
    if (!row) throw new Error('The usage account is missing.');
    return totals(aiLimitsSchema.parse(row.limits));
  }
  private async current(tx: Transaction) {
    return (
      await tx.query<{ start: string; end: string }>(
        `SELECT to_char(date_trunc('month',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD') start,
       to_char(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month','YYYY-MM-DD') "end"`,
      )
    ).rows[0]!;
  }
  private async period(
    tx: Transaction,
    owner: string,
    start: string,
    lock = false,
  ) {
    const row = (
      await tx.query<Period>(
        `SELECT settled,uncertain,settled_requests::text,uncertain_requests::text
       FROM ai_usage_periods WHERE owner_id=$1 AND period_start=$2${lock ? ' FOR UPDATE' : ''}`,
        [owner, start],
      )
    ).rows[0];
    return row
      ? {
          ...row,
          settled: usageTotalsSchema.parse(row.settled),
          uncertain: usageTotalsSchema.parse(row.uncertain),
        }
      : null;
  }
  async start(
    job: ClaimedJob,
    request: UsageReservation,
    transaction?: Transaction,
  ): Promise<string> {
    const reserve = async (tx: Transaction) => {
      await this.database.document(job.ownerId, job.documentId, tx);
      const row = (
        await tx.query<{ valid: boolean }>(
          `SELECT state='running' AND lease_token=$2 AND lease_until>now()
         AND owner_id=$3 AND document_id=$4 valid FROM jobs WHERE id=$1 FOR UPDATE`,
          [job.id, job.leaseToken, job.ownerId, job.documentId],
        )
      ).rows[0];
      if (!row?.valid)
        throw new ServiceError(
          'job_lease_lost',
          'This request no longer owns its AI job.',
          409,
        );
      return this.reserve(tx, job.ownerId, request, { kind: 'job', job });
    };
    return transaction
      ? reserve(transaction)
      : this.database.transaction(reserve);
  }
  async startLive(
    claim: LiveClaim,
    transaction?: Transaction,
  ): Promise<string> {
    const reserve = async (tx: Transaction) => {
      const lease = await this.database.live.authorize(claim, tx);
      return this.reserve(
        tx,
        lease.owner_id,
        {
          operation: 'live-speech',
          provider: lease.provider,
          configurationVersion: lease.configuration_version,
          budget: {
            input_tokens: 0,
            output_tokens: 0,
            audio_ms: LIVE_MEDIA_MS,
          },
        },
        { kind: 'live', id: lease.id },
      );
    };
    return transaction
      ? reserve(transaction)
      : this.database.transaction(reserve);
  }
  private async reserve(
    tx: Transaction,
    owner: string,
    request: UsageReservation,
    origin: { kind: 'job'; job: ClaimedJob } | { kind: 'live'; id: string },
  ): Promise<string> {
    const budget = totals(request.budget);
    if (
      units.every((unit) => budget[unit] === '0') ||
      !/^[A-Za-z0-9:_-]{1,80}$/.test(request.operation) ||
      !['azure', 'fixture'].includes(request.provider) ||
      !request.configurationVersion ||
      request.configurationVersion.length > 200
    )
      throw new Error('Use a bounded, nonempty provider usage reservation.');
    const limits = await this.account(tx, owner);
    const { start } = await this.current(tx);
    await tx.query(
      'INSERT INTO ai_usage_periods(owner_id,period_start,settled,uncertain) VALUES ($1,$2,$3,$3) ON CONFLICT DO NOTHING',
      [owner, start, JSON.stringify(zero())],
    );
    const period = await this.period(tx, owner, start, true);
    if (!period) throw new Error('The usage period is missing.');
    if (
      (
        await (origin.kind === 'job'
          ? tx.query(
              'SELECT id FROM ai_usage_calls WHERE job_id=$1 AND lease_token=$2 AND operation=$3',
              [origin.job.id, origin.job.leaseToken, request.operation],
            )
          : tx.query('SELECT id FROM ai_usage_calls WHERE live_lease_id=$1', [
              origin.id,
            ]))
      ).rowCount
    )
      throw new ServiceError(
        'provider_request_already_started',
        'This provider request already has an uncertain or settled reservation; it must not be sent twice.',
        409,
      );
    const uncertain = add(period.uncertain, budget);
    if (exceeds(add(period.settled, uncertain), limits))
      throw new ServiceError(
        'quota_exceeded',
        'This account has insufficient monthly AI allowance, including uncertain earlier requests. Contact the deployment administrator.',
        429,
      );
    const id = randomUUID();
    await tx.query(
      `INSERT INTO ai_usage_calls(id,owner_id,period_start,job_id,lease_token,operation,provider,configuration_version,reserved,request_kind,live_lease_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        owner,
        start,
        origin.kind === 'job' ? origin.job.id : null,
        origin.kind === 'job' ? origin.job.leaseToken : null,
        request.operation,
        request.provider,
        request.configurationVersion,
        JSON.stringify(budget),
        origin.kind,
        origin.kind === 'live' ? origin.id : null,
      ],
    );
    await tx.query(
      'UPDATE ai_usage_periods SET uncertain=$3,uncertain_requests=uncertain_requests+1 WHERE owner_id=$1 AND period_start=$2',
      [owner, start, JSON.stringify(uncertain)],
    );
    return id;
  }
  async settle(
    id: string,
    usage: Usage,
    transaction?: Transaction,
  ): Promise<void> {
    const actual = totals(usage);
    const settle = async (tx: Transaction) => {
      const selected = (
        await tx.query<Call>(
          'SELECT owner_id,period_start::text,reserved,actual,live_lease_id FROM ai_usage_calls WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!selected)
        throw new Error('The provider usage reservation is missing.');
      if (selected.live_lease_id)
        await tx.query(
          `UPDATE live_leases SET closed_at=coalesce(closed_at,clock_timestamp()),
        close_code=coalesce(close_code,'settled') WHERE id=$1`,
          [selected.live_lease_id],
        );
      const period = await this.period(
        tx,
        selected.owner_id,
        selected.period_start,
        true,
      );
      if (!period) throw new Error('The provider usage period is missing.');
      const call = (
        await tx.query<Call>(
          'SELECT owner_id,period_start::text,reserved,actual,live_lease_id FROM ai_usage_calls WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!call) throw new Error('The provider usage reservation disappeared.');
      if (call.actual !== null) {
        if (
          canonicalJson(usageTotalsSchema.parse(call.actual)) !==
          canonicalJson(actual)
        )
          throw new ServiceError(
            'usage_settlement_conflict',
            'This provider request already has different recorded usage.',
            409,
          );
        return;
      }
      const reserved = usageTotalsSchema.parse(call.reserved);
      await tx.query(
        'UPDATE ai_usage_calls SET actual=$2,settled_at=now() WHERE id=$1',
        [id, JSON.stringify(actual)],
      );
      await tx.query(
        `UPDATE ai_usage_periods SET settled=$3,uncertain=$4,
         settled_requests=settled_requests+1,uncertain_requests=uncertain_requests-1 WHERE owner_id=$1 AND period_start=$2`,
        [
          call.owner_id,
          call.period_start,
          JSON.stringify(add(period.settled, actual)),
          JSON.stringify(add(period.uncertain, reserved, -1n)),
        ],
      );
      if (exceeds(actual, reserved))
        console.error(
          JSON.stringify({
            code: 'usage_reservation_exceeded',
            request_id: id,
          }),
        );
    };
    if (transaction) await settle(transaction);
    else await this.database.transaction(settle);
  }
  async snapshot(owner: string) {
    return this.database.transaction(async (tx) => {
      if (
        !(
          await tx.query('SELECT id FROM users WHERE id=$1 AND active', [owner])
        ).rowCount
      )
        throw new ServiceError(
          'account_unavailable',
          'This AI usage account is unavailable.',
          403,
        );
      const limits = await this.account(tx, owner);
      const { start, end } = await this.current(tx);
      const period = await this.period(tx, owner, start);
      const settled = period?.settled ?? zero();
      const uncertain = period?.uncertain ?? zero();
      return accountUsageSchema.parse({
        period_start: start,
        period_end: end,
        limits,
        settled,
        uncertain,
        settled_requests: period?.settled_requests ?? '0',
        uncertain_requests: period?.uncertain_requests ?? '0',
        over_limit: exceeds(add(settled, uncertain), limits),
      });
    });
  }
  async setLimits(owner: string, value: z.infer<typeof aiLimitsSchema>) {
    const limits = aiLimitsSchema.parse(value);
    await this.database.transaction(async (tx) => {
      if (
        !(
          await tx.query('SELECT id FROM users WHERE id=$1 AND active', [owner])
        ).rowCount
      )
        throw new ServiceError(
          'account_unavailable',
          'This AI usage account is unavailable.',
          403,
        );
      await tx.query(
        'INSERT INTO ai_usage_accounts VALUES ($1,$2) ON CONFLICT(owner_id) DO UPDATE SET limits=excluded.limits',
        [owner, JSON.stringify(limits)],
      );
    });
    return this.snapshot(owner);
  }
}
