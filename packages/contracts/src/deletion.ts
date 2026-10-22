import { z } from 'zod';
import { resourceId } from './server.js';

const timestamp = z.iso
  .datetime({ precision: 3 })
  .refine((value) => value.length === 24);
const uuid = resourceId.refine(
  (value) => value.length === 36 && value === value.toLowerCase(),
);
const counter = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(
    (value) =>
      value === value.trim() &&
      (value.length < 20 || value <= '18446744073709551615'),
  );
const positive = counter.refine((value) => value !== '0');
const hash = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
const base = {
  id: uuid,
  transaction_id: positive,
  recorded_at: timestamp,
  resource_id: uuid,
  workspace_id: z.null(),
  expires_at: z.null(),
  retention_days: z.null(),
  processing_days: z.null(),
  reason: z.null(),
};
export const deletionIntentSchema = z.discriminatedUnion('event', [
  z.strictObject({
    ...base,
    event: z.enum([
      'document_erased',
      'chat_thread_erased',
      'chat_turn_erased',
      'account_revoked',
      'workspace_erased',
      'job_erased',
      'job_audio_erased',
      'staging_object_erased',
      'verified_object_erased',
    ]),
  }),
  z.strictObject({
    ...base,
    event: z.literal('recording_erased'),
    reason: z.enum(['user', 'document', 'revoked', 'retention']).nullable(),
  }),
  z.strictObject({
    ...base,
    event: z.literal('membership_revoked'),
    workspace_id: uuid,
  }),
  z.strictObject({
    ...base,
    event: z.literal('recording_expiry_bound'),
    expires_at: timestamp,
  }),
  z.strictObject({
    ...base,
    event: z.literal('workspace_retention_bound'),
    retention_days: z.number().int().min(0).max(7),
    processing_days: z.number().int().min(1).max(30),
  }),
]);
export const deletionOriginSchema = z.strictObject({
  deployment_id: uuid,
  initialized_at: timestamp,
});
export const deletionBatchSchema = z.strictObject({
  version: z.literal(1),
  id: uuid,
  origin: deletionOriginSchema,
  entries: z
    .array(deletionIntentSchema)
    .min(1)
    .max(100)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.id)).size === entries.length,
    ),
});
export const deletionArchiveHeadSchema = z.strictObject({
  version: z.literal(1),
  origin: deletionOriginSchema,
  generation: counter,
  entry_references: counter,
  tip: hash,
});
export const deletionArchiveLinkSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('genesis'),
    origin: deletionOriginSchema,
    generation: z.literal('0'),
    entry_references: z.literal('0'),
    previous: z.null(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('batch'),
    origin: deletionOriginSchema,
    generation: positive,
    entry_references: positive,
    previous: hash,
    batch_id: uuid,
    batch_sha256: hash,
    batch_entries: z.number().int().min(1).max(100),
  }),
]);
export type DeletionIntent = z.infer<typeof deletionIntentSchema>;
export type DeletionOrigin = z.infer<typeof deletionOriginSchema>;
export type DeletionBatch = z.infer<typeof deletionBatchSchema>;
export type DeletionArchiveHead = z.infer<typeof deletionArchiveHeadSchema>;
export type DeletionArchiveLink = z.infer<typeof deletionArchiveLinkSchema>;
