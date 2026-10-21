import { z } from 'zod';
import { richTextSchema, tagsSchema } from './content.js';
import { resourceId } from './server.js';

export const editableSchema = z.strictObject({
  title: z
    .string()
    .max(200)
    .refine((text) => !text.includes('\0')),
  content: richTextSchema,
  tags: tagsSchema,
});
export const draftSchema = editableSchema.extend({
  id: resourceId,
  local_revision: z.number().int().positive(),
  remote_revision: z.number().int().nonnegative(),
  status: z.enum(['local', 'pending', 'synced', 'conflict', 'deleted_remote']),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type EditableDraft = z.infer<typeof editableSchema>;
export type Draft = z.infer<typeof draftSchema>;
export const desktopCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('bootstrap') }),
  z.strictObject({
    operation: z.literal('create'),
    value: editableSchema.optional(),
  }),
  z.strictObject({ operation: z.literal('select'), id: resourceId }),
  z.strictObject({
    operation: z.literal('save'),
    id: resourceId,
    local_revision: z.number().int().positive(),
    value: editableSchema,
  }),
  z.strictObject({
    operation: z.literal('delete'),
    id: resourceId,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    operation: z.literal('export'),
    id: resourceId,
    format: z.enum(['markdown', 'text']),
  }),
  z.strictObject({ operation: z.literal('openRecoveryFolder') }),
  z.strictObject({ operation: z.literal('closeReady'), nonce: resourceId }),
]);
export const desktopStateSchema = z.strictObject({
  documents: z.array(draftSchema),
  selected_id: resourceId.nullable(),
  storage: z.literal('encrypted'),
});
export const desktopResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    state: desktopStateSchema,
    notice: z.enum(['exported', 'export_cancelled']).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
export type DesktopCommand = z.infer<typeof desktopCommandSchema>;
export type DesktopState = z.infer<typeof desktopStateSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;
export interface DesktopBridge {
  invoke(command: DesktopCommand): Promise<DesktopResponse>;
  onFlush(callback: (nonce: string) => void): () => void;
}
