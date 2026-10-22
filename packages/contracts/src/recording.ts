import { z } from 'zod';
import {
  audioStorageSchema,
  captureLevelsSchema,
  localAudioQuotaGiBSchema,
  recoverySchema,
  trackSchema,
} from './index.js';
import { resourceId } from './server.js';
import { liveRecognitionEventSchema, liveSourceSchema } from './realtime.js';
import {
  createRecordingSchema,
  registerChunkSchema,
  recordingSealSchema,
  MAX_RECORDING_CHUNKS,
} from './uploads.js';

export const recordingProblemSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(512),
});
export const localRecordingSchema = z
  .strictObject({
    id: resourceId,
    document_id: resourceId,
    created_at: z.iso.datetime(),
    state: z.enum([
      'starting',
      'recording',
      'paused',
      'sealed',
      'failed',
      'interrupted',
    ]),
    tracks: z
      .array(
        z.strictObject({
          spec: trackSchema,
          actual_device_id: z.string().min(1).max(1024).nullable(),
          saved_samples: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(2),
    error: recordingProblemSchema.nullable(),
    inspection: recoverySchema.nullable(),
    audio_retired_at: z.iso.datetime().optional(),
  })
  .refine(
    ({ tracks }) =>
      new Set(tracks.map((track) => track.spec.track_id)).size ===
        tracks.length &&
      new Set(tracks.map((track) => track.spec.kind)).size === tracks.length,
    'Recording tracks must have unique IDs and kinds.',
  );
export const recordingOwnerSchema = z.strictObject({
  profile: z.string().min(1).max(200),
  document_id: resourceId,
  recording_id: resourceId,
});
export type LocalRecording = z.infer<typeof localRecordingSchema>;
export type RecordingOwner = z.infer<typeof recordingOwnerSchema>;
export const recordingUploadPlanSchema = z
  .strictObject({
    create: createRecordingSchema,
    chunks: z.array(registerChunkSchema).min(1).max(MAX_RECORDING_CHUNKS),
    seal: recordingSealSchema,
  })
  .refine((plan) => {
    const tracks = new Set(
      plan.create.tracks.map((track) => track.spec.track_id),
    );
    return (
      plan.seal.tracks.length === tracks.size &&
      plan.chunks.every(
        (chunk) =>
          chunk.chunk.recording_id === plan.create.id &&
          tracks.has(chunk.chunk.track_id),
      ) &&
      new Set(plan.chunks.map((chunk) => chunk.chunk.chunk_id)).size ===
        plan.chunks.length &&
      plan.seal.tracks.every((track) => {
        const chunks = plan.chunks.filter(
          (chunk) => chunk.chunk.track_id === track.track_id,
        );
        let sample = 0;
        return (
          tracks.has(track.track_id) &&
          chunks.length === track.chunk_ids.length &&
          chunks.every((chunk, index) => {
            const valid =
              chunk.chunk.sequence === index &&
              chunk.chunk.sample_start === sample &&
              chunk.chunk.chunk_id === track.chunk_ids[index];
            sample += chunk.chunk.sample_count;
            return valid;
          }) &&
          sample === track.end_sample
        );
      })
    );
  });
export const recordingUploadStatusSchema = z.strictObject({
  recording_id: resourceId,
  document_id: resourceId,
  state: z.enum([
    'queued',
    'uploading',
    'waiting',
    'paused',
    'attention',
    'complete',
    'delete_pending',
    'deleting',
  ]),
  verified_chunks: z.number().int().min(0).max(MAX_RECORDING_CHUNKS),
  total_chunks: z.number().int().min(0).max(MAX_RECORDING_CHUNKS),
  verified_bytes: z
    .number()
    .int()
    .min(0)
    .max(10_000 * 960_044),
  partial: z.boolean(),
  attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  retry_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  error: recordingProblemSchema.nullable(),
});
export const recordingUploadIntentSchema = recordingUploadStatusSchema
  .extend({
    accept_incomplete: z.boolean(),
    plan: recordingUploadPlanSchema.nullable(),
  })
  .refine(
    (intent) =>
      intent.partial === intent.accept_incomplete &&
      (intent.plan === null
        ? intent.total_chunks === 0 &&
          intent.verified_chunks === 0 &&
          intent.verified_bytes === 0
        : intent.plan.create.id === intent.recording_id &&
          intent.plan.chunks.length === intent.total_chunks &&
          intent.verified_chunks <= intent.total_chunks &&
          intent.verified_bytes <=
            intent.plan.chunks.reduce(
              (sum, chunk) => sum + chunk.size_bytes,
              0,
            ) &&
          intent.plan.seal.accept_incomplete === intent.accept_incomplete),
  );
export type RecordingUploadPlan = z.infer<typeof recordingUploadPlanSchema>;
export type RecordingUploadStatus = z.infer<typeof recordingUploadStatusSchema>;
export type RecordingUploadIntent = z.infer<typeof recordingUploadIntentSchema>;
export const livePreviewSchema = z.strictObject({
  document_id: resourceId,
  recording_id: resourceId,
  locale: z.enum(['en-US', 'zh-CN']),
  phase: z.enum([
    'starting',
    'live',
    'finishing',
    'rotating',
    'stopped',
    'attention',
  ]),
  running: z.boolean(),
  attempt: z.number().int().min(1).max(100_000),
  canonical: z.literal(false),
  continuity: z.literal('unverified'),
  usage_status: z.enum(['settled', 'check_account']),
  sources: z
    .array(
      z.strictObject({
        track_id: resourceId,
        kind: z.enum(['microphone', 'loopback']),
        provider_epoch: resourceId.nullable(),
        accepted_samples: z.number().int().min(0).max(960_000),
        skipped_samples: z.number().int().min(0).max(230_400_000),
      }),
    )
    .max(2),
  segments: z
    .array(
      z.strictObject({
        attempt: z.number().int().min(1).max(100_000),
        event: liveRecognitionEventSchema,
      }),
    )
    .max(12),
  boundaries: z
    .array(
      z.strictObject({
        attempt: z.number().int().min(1).max(100_000),
        reason: z.enum([
          'started',
          'normal_rotation',
          'uncertain_previous_tail',
        ]),
      }),
    )
    .max(8),
  gaps: z
    .array(
      z
        .strictObject({
          attempt: z.number().int().min(1).max(100_000),
          source: liveSourceSchema,
          sample_start: z.number().int().min(0).max(230_400_000),
          sample_end: z.number().int().min(1).max(230_400_000),
          reason: z.enum(['startup', 'rotation', 'authorization']),
        })
        .refine((gap) => gap.sample_end > gap.sample_start),
    )
    .max(8),
  omitted: z.boolean(),
  error: recordingProblemSchema.nullable(),
});
export type LivePreviewState = z.infer<typeof livePreviewSchema>;
export const localAudioRetentionDaysSchema = z.number().int().min(0).max(7);
export const localAudioRetentionSchema = z.strictObject({
  recording_id: resourceId,
  document_id: resourceId,
  canonical_at: z.iso.datetime(),
  delete_after: z.number().int().min(0).max(8_640_000_000_000_000),
});
export type LocalAudioRetention = z.infer<typeof localAudioRetentionSchema>;
export const audioStateSchema = z.strictObject({
  document_id: resourceId.nullable(),
  active: localRecordingSchema.nullable(),
  recordings: z.array(localRecordingSchema).max(50),
  has_more: z.boolean(),
  offset: z.number().int().min(0).max(1_000_000),
  busy: z.boolean(),
  pending_deletions: z.number().int().min(0).max(10_000),
  error: recordingProblemSchema.nullable(),
  cleanup_error: recordingProblemSchema.nullable(),
  storage_quota_gib: localAudioQuotaGiBSchema.default(5),
  storage: z
    .strictObject({
      received_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      capacity: audioStorageSchema,
    })
    .nullable()
    .default(null),
  storage_error: recordingProblemSchema.nullable().default(null),
  retention_days: localAudioRetentionDaysSchema.default(7),
  retention: z.array(localAudioRetentionSchema).max(50).default([]),
  retention_error: recordingProblemSchema.nullable().default(null),
  upload_available: z.boolean().default(false),
  uploads: z.array(recordingUploadStatusSchema).max(50).default([]),
  active_upload: recordingUploadStatusSchema.nullable().default(null),
  upload_destination: z.url().nullable().default(null),
  levels: z
    .strictObject({
      received_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      capture: captureLevelsSchema,
    })
    .nullable()
    .default(null),
  live: livePreviewSchema.nullable().default(null),
});
export type AudioState = z.infer<typeof audioStateSchema>;
