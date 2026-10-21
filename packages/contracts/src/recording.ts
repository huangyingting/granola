import { z } from 'zod';
import { recoverySchema, trackSchema } from './index.js';
import { resourceId } from './server.js';

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
});
export type AudioState = z.infer<typeof audioStateSchema>;
