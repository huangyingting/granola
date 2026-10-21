import { z } from 'zod';
import { richTextSchema, tagsSchema } from './content.js';
import {
  resourceId,
  jobSchema,
  cachedTranscriptSchema,
  transcriptPageSchema,
  transcriptTimelinePageSchema,
  MAX_TRANSCRIPT_SEGMENTS,
} from './server.js';
import { deviceSchema, trackSchema } from './index.js';
import { audioStateSchema } from './recording.js';

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
export const draftSummarySchema = draftSchema.omit({ content: true }).extend({
  preview: z.string().max(160),
});
export type DraftSummary = z.infer<typeof draftSummarySchema>;
const scoped = { scope: z.number().int().positive() };
export const desktopCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('bootstrap') }),
  z.strictObject({
    operation: z.literal('getTranscriptPage'),
    ...scoped,
    id: resourceId,
    revision: z.number().int().positive(),
    offset: z.number().int().min(0).max(MAX_TRANSCRIPT_SEGMENTS),
  }),
  z.strictObject({
    operation: z.literal('getTranscriptTimeline'),
    ...scoped,
    id: resourceId,
    revision: z.number().int().positive(),
    offset: z.number().int().min(0).max(20_000),
  }),
  z.strictObject({
    operation: z.literal('finalizeRecordingTranscript'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
    locale: z.enum(['en-US', 'zh-CN']),
    accept_incomplete: z.boolean(),
    confirmed: z.literal(true),
    new_attempt: z.boolean(),
    consent_id: resourceId,
  }),
  z.strictObject({
    operation: z.literal('controlTranscriptionJob'),
    ...scoped,
    id: resourceId,
    job_id: resourceId,
    action: z.enum(['cancel', 'retry']),
    confirmed: z.literal(true),
  }),
  z.strictObject({
    operation: z.literal('applyTranscript'),
    ...scoped,
    id: resourceId,
    source_revision: z.number().int().positive(),
    base_revision: z.number().int().nonnegative(),
    confirmed: z.literal(true),
  }),
  z.strictObject({ operation: z.literal('listAudioDevices'), ...scoped }),
  z.strictObject({
    operation: z.literal('getRecordingState'),
    ...scoped,
    document_id: resourceId.nullable(),
    offset: z.number().int().min(0).max(1_000_000),
  }),
  z.strictObject({
    operation: z.literal('startRecording'),
    ...scoped,
    id: resourceId,
    tracks: z.array(trackSchema).min(1).max(2),
  }),
  z.strictObject({
    operation: z.literal('controlRecording'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
    action: z.enum(['pause', 'resume', 'stop']),
  }),
  z.strictObject({
    operation: z.literal('inspectRecording'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
  }),
  z.strictObject({
    operation: z.literal('recoverRecording'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    operation: z.literal('removeRecording'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
    confirmed: z.literal(true),
  }),
  z.strictObject({ operation: z.literal('retryRecordingCleanup'), ...scoped }),
  z.strictObject({
    operation: z.literal('uploadRecording'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
    confirmed: z.literal(true),
    accept_incomplete: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal('pauseRecordingUpload'),
    ...scoped,
    id: resourceId,
    recording_id: resourceId,
  }),
  z.strictObject({
    operation: z.literal('create'),
    ...scoped,
    value: editableSchema.optional(),
  }),
  z.strictObject({ operation: z.literal('select'), ...scoped, id: resourceId }),
  z.strictObject({
    operation: z.literal('search'),
    ...scoped,
    query: z.string().max(200),
    offset: z.number().int().min(0).max(1_000_000),
  }),
  z.strictObject({
    operation: z.literal('save'),
    ...scoped,
    id: resourceId,
    local_revision: z.number().int().positive(),
    value: editableSchema,
  }),
  z.strictObject({
    operation: z.literal('delete'),
    ...scoped,
    id: resourceId,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    operation: z.literal('export'),
    ...scoped,
    id: resourceId,
    format: z.enum(['markdown', 'text']),
  }),
  z.strictObject({ operation: z.literal('openRecoveryFolder') }),
  z.strictObject({ operation: z.literal('closeReady'), nonce: resourceId }),
  z.strictObject({
    operation: z.literal('connect'),
    ...scoped,
    service_url: z.url().max(2048),
  }),
  z.strictObject({ operation: z.literal('cancelConnect') }),
  z.strictObject({
    operation: z.literal('activateWorkspace'),
    ...scoped,
    workspace_id: resourceId,
    copy_offline: z.boolean(),
  }),
  z.strictObject({ operation: z.literal('workOffline'), ...scoped }),
  z.strictObject({ operation: z.literal('sync'), ...scoped }),
  z.strictObject({
    operation: z.literal('disconnect'),
    ...scoped,
    preserve_unsent: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal('resolve'),
    ...scoped,
    id: resourceId,
    choice: z.enum(['local', 'remote', 'copy']),
  }),
]);
export const desktopConnectionSchema = z.strictObject({
  status: z.enum([
    'offline',
    'connecting',
    'switching',
    'ready',
    'syncing',
    'attention',
    'reauth_required',
    'disconnecting',
  ]),
  service_url: z.string().nullable(),
  user_id: resourceId.nullable(),
  workspaces: z.array(
    z.strictObject({ id: resourceId, name: z.string().max(200) }),
  ),
  active_workspace: resourceId.nullable(),
  unsent_count: z.number().int().nonnegative(),
  offline_count: z.number().int().nonnegative(),
  next_retry_at: z.number().int().nonnegative(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
export const desktopConflictSchema = z.strictObject({
  remote: editableSchema.nullable(),
  remote_revision: z.number().int().nonnegative(),
  deleted_remote: z.boolean(),
});
export const desktopStateSchema = z.strictObject({
  version: z.number().int().positive(),
  scope: z.number().int().positive(),
  documents: z.array(draftSummarySchema).max(50),
  selected: draftSchema.nullable(),
  query: z.string().max(200),
  offset: z.number().int().min(0).max(1_000_000),
  has_more: z.boolean(),
  selected_id: resourceId.nullable(),
  storage: z.literal('encrypted'),
  connection: desktopConnectionSchema,
  conflict: desktopConflictSchema.nullable(),
  transcript_revision: z.number().int().nonnegative(),
  transcript: cachedTranscriptSchema.nullable(),
  jobs: z.array(jobSchema).max(20),
});
export const desktopChangeSchema = z.strictObject({
  version: z.number().int().positive(),
  scope: z.number().int().positive(),
  kind: z.enum(['data', 'scope', 'revoked', 'status', 'audio']),
});
export const desktopResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    state: desktopStateSchema,
    notice: z.enum(['exported', 'export_cancelled']).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
  z.strictObject({ ok: z.literal(true), closing: z.literal(true) }),
  z.strictObject({
    ok: z.literal(true),
    transcript_page: z.strictObject({ ...scoped, page: transcriptPageSchema }),
  }),
  z.strictObject({
    ok: z.literal(true),
    transcript_timeline: z.strictObject({
      ...scoped,
      page: transcriptTimelinePageSchema,
    }),
  }),
  z.strictObject({
    ok: z.literal(true),
    audio_state: z.strictObject({ ...scoped, state: audioStateSchema }),
  }),
  z.strictObject({
    ok: z.literal(true),
    audio_devices: z.strictObject({
      ...scoped,
      devices: z.array(deviceSchema).max(100),
    }),
  }),
]);
export type DesktopCommand = z.infer<typeof desktopCommandSchema>;
export type DesktopState = z.infer<typeof desktopStateSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;
export type DesktopChange = z.infer<typeof desktopChangeSchema>;
export type DesktopConnection = z.infer<typeof desktopConnectionSchema>;
export interface DesktopBridge {
  invoke(command: DesktopCommand): Promise<DesktopResponse>;
  onFlush(callback: (nonce: string) => void): () => void;
  onChanged(callback: (change: DesktopChange) => void): () => void;
}
