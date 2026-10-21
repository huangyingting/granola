import { z } from 'zod';
import { livePcmFrameSchema } from './index.js';

export const liveSourceSchema = z.strictObject({
  recording_id: livePcmFrameSchema.shape.recording_id,
  preview_id: livePcmFrameSchema.shape.preview_id,
  track_id: livePcmFrameSchema.shape.track_id,
  capture_epoch: livePcmFrameSchema.shape.capture_epoch,
});
export type LiveSource = z.infer<typeof liveSourceSchema>;
const sample = z.number().int().min(0).max(230_400_000);
export const liveRecognitionEventSchema = z
  .strictObject({
    schema_version: z.literal(1),
    provider_epoch: z.uuidv4(),
    source: liveSourceSchema,
    event_type: z.enum([
      'transcript.partial',
      'transcript.final',
      'transcript.discarded',
    ]),
    segment_id: z.uuidv4(),
    version: z.number().int().min(1).max(1_000_000),
    sample_start: sample,
    sample_end: sample,
    text: z.string().max(4000),
    discard_reason: z.literal('no_match').nullable(),
    provider_result_id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  })
  .refine(
    (event) =>
      event.sample_end >= event.sample_start &&
      (event.event_type === 'transcript.discarded'
        ? event.text === '' && event.discard_reason === 'no_match'
        : event.text.trim().length > 0 && event.discard_reason === null),
  );
export type LiveRecognitionEvent = z.infer<typeof liveRecognitionEventSchema>;
