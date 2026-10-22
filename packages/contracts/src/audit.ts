import { z } from 'zod';
import { resourceId } from './server.js';

export const auditSourceSchema = z.enum([
  'api',
  'worker',
  'deployment',
  'system',
]);
export const auditActionSchema = z.enum([
  'account_created',
  'account_access_changed',
  'account_deleted',
  'membership_access_changed',
  'document_created',
  'document_updated',
  'document_deleted',
  'transcript_published',
  'recording_created',
  'recording_sealed',
  'recording_access_revoked',
  'object_cleanup_confirmed',
  'job_created',
  'job_state_changed',
  'job_lease_replaced',
  'chat_thread_created',
  'chat_thread_deleted',
  'chat_turn_created',
  'chat_turn_state_changed',
  'chat_dispatch_started',
  'chat_turn_deleted',
  'usage_limits_changed',
  'usage_reserved',
  'usage_settled',
  'retention_policy_changed',
  'live_lease_opened',
  'live_lease_closed',
  'live_lease_deleted',
]);
export const auditCursorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');
const state = z
  .enum([
    'queued',
    'running',
    'retry_wait',
    'succeeded',
    'failed',
    'cancelled',
    'pending',
    'sending',
    'settled',
    'expired',
  ])
  .nullable();
export const auditEventSchema = z.strictObject({
  id: auditCursorSchema,
  created_at: z.iso.datetime(),
  action: auditActionSchema,
  resource_type: z.enum([
    'account',
    'membership',
    'document',
    'recording',
    'object',
    'job',
    'chat_thread',
    'chat_turn',
    'usage_account',
    'usage_call',
    'workspace',
    'live_lease',
  ]),
  resource_id: resourceId,
  workspace_id: resourceId.nullable(),
  subject_owner_id: resourceId.nullable(),
  document_id: resourceId.nullable(),
  job_id: resourceId.nullable(),
  turn_id: resourceId.nullable(),
  actor_id: resourceId.nullable(),
  request_id: resourceId.nullable(),
  source: auditSourceSchema,
  from_state: state,
  to_state: state,
  active: z.boolean().nullable(),
  revision: z.number().int().min(0).max(2_147_483_647).nullable(),
  reason: z.enum(['user', 'document', 'revoked', 'retention']).nullable(),
});
export const auditQuerySchema = z.strictObject({
  before: auditCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const auditPageSchema = z.strictObject({
  version: z.literal(1),
  observed_at: z.iso.datetime(),
  retained_since: z.iso.datetime(),
  retention_days: z.literal(30),
  expired_rows_pending_cleanup: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
  events: z.array(auditEventSchema).max(100),
  next_before: auditCursorSchema.nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
