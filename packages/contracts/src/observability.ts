import { z } from 'zod';
import { resourceId } from './server.js';
import { auditSourceSchema } from './audit.js';

export const providerContextSchema = z.strictObject({
  source: auditSourceSchema.default('system'),
  usage_call_id: resourceId.nullable().default(null),
  origin_request_id: resourceId.nullable().default(null),
  job_id: resourceId.nullable().default(null),
  turn_id: resourceId.nullable().default(null),
  live_lease_id: resourceId.nullable().default(null),
});
export type ProviderContext = z.infer<typeof providerContextSchema>;
const base = {
  version: z.literal(1),
  observed_at: z.iso.datetime(),
  ...providerContextSchema.shape,
  client_request_id: z.uuidv4(),
  operation: z.enum([
    'answer',
    'extract',
    'merge',
    'summarize_facts',
    'summarize',
    'transcribe',
  ]),
};
const duration = z.number().int().nonnegative();
export const providerEventSchema = z.discriminatedUnion('code', [
  z.strictObject({
    ...base,
    code: z.literal('provider_request_started'),
  }),
  z.strictObject({
    ...base,
    code: z.literal('provider_call_completed'),
    dispatched: z.boolean(),
    outcome: z.enum(['returned', 'failed', 'cancelled', 'timed_out']),
    duration_ms: duration,
    response_headers_ms: duration.nullable(),
    first_content_ms: duration.nullable(),
    response_body_ms: duration.nullable(),
    http_status: z.number().int().min(100).max(599).nullable(),
    provider_response_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    provider_response_id_status: z.enum(['missing', 'accepted', 'rejected']),
  }),
]);
export type ProviderEvent = z.infer<typeof providerEventSchema>;
