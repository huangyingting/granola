import { z } from 'zod';
import {
  trackSchema,
  uploadChunkSchema,
  captureTimelineEventSchema,
  captureGapSchema,
} from './index.js';
import { resourceId } from './server.js';

export const MAX_RECORDING_CHUNKS = 10_000;
export const MAX_RECORDING_SAMPLES = 4 * 60 * 60 * 16_000;
export const recordingCapabilitiesSchema = z
  .strictObject({
    enabled: z.boolean(),
    max_chunk_bytes: z.literal(960_044),
    max_chunks: z.literal(MAX_RECORDING_CHUNKS),
    upload_origin: z.url().nullable(),
    multipart: z.literal(false),
  })
  .refine((value) => value.enabled === (value.upload_origin !== null));
export const recordingTrackSchema = z.strictObject({
  spec: trackSchema,
  actual_device_id: z.string().min(1).max(1024),
});
export const createRecordingSchema = z
  .strictObject({
    id: resourceId,
    created_at: z.iso.datetime({ offset: true }),
    tracks: z.array(recordingTrackSchema).min(1).max(2),
  })
  .refine(
    ({ tracks }) =>
      new Set(tracks.map((t) => t.spec.track_id)).size === tracks.length &&
      new Set(tracks.map((t) => t.spec.kind)).size === tracks.length,
    'Recording track identities and kinds must be distinct.',
  );
export const registerChunkSchema = uploadChunkSchema.refine(
  ({ chunk }) =>
    chunk.sample_start + chunk.sample_count <= MAX_RECORDING_SAMPLES &&
    chunk.clock_end_ms <= 4 * 60 * 60 * 1000,
  'Audio must fit the supported four-hour track timeline.',
);
export const recordingSealSchema = z
  .strictObject({
    native_state: z.enum(['recording', 'paused', 'sealed', 'failed']),
    accept_incomplete: z.boolean(),
    tracks: z
      .array(
        z.strictObject({
          track_id: resourceId,
          end_sample: z.number().int().min(0).max(MAX_RECORDING_SAMPLES),
          chunk_ids: z.array(resourceId).max(MAX_RECORDING_CHUNKS),
        }),
      )
      .min(1)
      .max(2),
    events: z.array(captureTimelineEventSchema).max(10_000),
    gaps: z.array(captureGapSchema).max(10_000),
  })
  .refine((seal) => {
    const ids = seal.tracks.flatMap((track) => track.chunk_ids);
    return (
      ids.length <= MAX_RECORDING_CHUNKS &&
      new Set(ids).size === ids.length &&
      new Set(seal.tracks.map((track) => track.track_id)).size ===
        seal.tracks.length &&
      seal.gaps.every((gap) =>
        seal.tracks.some((track) => track.track_id === gap.track_id),
      ) &&
      (seal.accept_incomplete ||
        (seal.native_state === 'sealed' &&
          seal.gaps.every((gap) => gap.reason === 'paused')))
    );
  }, 'Freeze unique tracks and chunks, and explicitly accept an incomplete capture.');
export const remoteRecordingSchema = z.strictObject({
  id: resourceId,
  document_id: resourceId,
  created_at: z.iso.datetime(),
  tracks: z.array(recordingTrackSchema).min(1).max(2),
  state: z.enum(['uploading', 'sealed_pending', 'ready']),
  partial: z.boolean(),
  seal_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  chunk_count: z.number().int().min(0).max(MAX_RECORDING_CHUNKS),
  verified_chunks: z.number().int().min(0).max(MAX_RECORDING_CHUNKS),
});
export const recordingDeletionSchema = z
  .strictObject({
    state: z.enum(['cleanup_pending', 'cleanup_confirmed']),
    pending_objects: z.number().int().nonnegative(),
    cleanup_errors: z.number().int().nonnegative(),
    repeated_cleanup: z.literal(true),
  })
  .refine(
    (value) =>
      (value.state === 'cleanup_confirmed') ===
      (value.pending_objects === 0 && value.cleanup_errors === 0),
  );
export const audioRetentionPolicySchema = z.strictObject({
  retention_days: z.number().int().min(0).max(7),
  processing_days: z.number().int().min(1).max(30),
});
export const recordingRetentionSchema = z
  .strictObject({
    id: resourceId,
    document_id: resourceId,
    state: z.enum(['retained', 'expired', 'deleted']),
    canonical_at: z.iso.datetime().nullable(),
    expires_at: z.iso.datetime(),
    retention_days: z.number().int().min(0).max(7),
    deletion: recordingDeletionSchema.nullable(),
  })
  .refine(
    (value) =>
      (value.state !== 'deleted' || value.deletion !== null) &&
      (value.state !== 'retained' || value.deletion === null),
  );
export const remoteChunkSchema = z.strictObject({
  upload: uploadChunkSchema,
  state: z.enum(['pending', 'checking', 'verified']),
});
export const uploadAuthorizationSchema = z
  .strictObject({
    state: z.enum(['pending', 'verified']),
    upload: z
      .strictObject({
        id: resourceId,
        url: z.url().max(16_384),
        headers: z.strictObject({
          'content-type': z.literal('audio/wav'),
          'content-length': z.string().regex(/^[1-9][0-9]{1,5}$/),
          'x-amz-checksum-sha256': z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
          'x-amz-acl': z.literal('bucket-owner-full-control'),
          'x-amz-server-side-encryption': z
            .enum(['AES256', 'aws:kms'])
            .optional(),
          'x-amz-server-side-encryption-aws-kms-key-id': z
            .string()
            .min(1)
            .max(2048)
            .optional(),
        }),
        expires_at: z.iso.datetime(),
      })
      .nullable(),
  })
  .refine((value) => (value.state === 'pending') === (value.upload !== null));
export type CreateRecording = z.infer<typeof createRecordingSchema>;
export type RecordingSeal = z.infer<typeof recordingSealSchema>;
export type RemoteRecording = z.infer<typeof remoteRecordingSchema>;
export type RemoteChunk = z.infer<typeof remoteChunkSchema>;
