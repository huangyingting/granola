import {
  auditEventSchema,
  auditPageSchema,
  auditQuerySchema,
  type AuditEvent,
} from '@windows-ai-notes/contracts/audit';
import type { z } from 'zod';
import type { Database, Transaction } from './index.js';

type Row = Omit<AuditEvent, 'created_at'> & { created_at: Date };

export class AuditStore {
  constructor(private readonly database: Database) {}

  async page(query: z.input<typeof auditQuerySchema> = {}) {
    const input = auditQuerySchema.parse(query);
    await this.database.assertReady();
    return this.database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      const clock = (
        await tx.query<{
          observed_at: Date;
          retained_since: Date;
          expired: string;
        }>(`SELECT now() observed_at,now()-interval '720 hours' retained_since,
        (SELECT count(*)::text FROM audit_events
          WHERE created_at<=now()-interval '720 hours') expired`)
      ).rows[0];
      if (!clock)
        throw new Error('Audit inspection has no retention measurement.');
      const rows = (
        await tx.query<Row>(
          `SELECT id::text,created_at,action,resource_type,resource_id,workspace_id,
          subject_owner_id,document_id,job_id,turn_id,actor_id,request_id,source,
          from_state,to_state,active,revision,reason FROM audit_events
         WHERE created_at>now()-interval '720 hours' AND created_at<=now()
           AND ($1::bigint IS NULL OR id<$1)
         ORDER BY audit_events.id DESC LIMIT $2`,
          [input.before ?? null, input.limit + 1],
        )
      ).rows;
      const events = rows.slice(0, input.limit).map((row) =>
        auditEventSchema.parse({
          ...row,
          created_at: row.created_at.toISOString(),
        }),
      );
      return auditPageSchema.parse({
        version: 1,
        observed_at: clock.observed_at.toISOString(),
        retained_since: clock.retained_since.toISOString(),
        retention_days: 30,
        expired_rows_pending_cleanup: clock.expired,
        events,
        next_before: rows.length > input.limit ? events.at(-1)!.id : null,
      });
    });
  }
  async prune(tx: Transaction) {
    await tx.query(`DELETE FROM audit_events WHERE id IN (
      SELECT id FROM audit_events WHERE created_at<=now()-interval '720 hours'
      ORDER BY created_at,id LIMIT 1000)`);
  }
}
