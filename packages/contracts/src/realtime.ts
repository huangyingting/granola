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

const wireBase = { schema_version: z.literal(1) };
export const liveClientMessageSchema = z.discriminatedUnion('event_type', [
  z.strictObject({
    ...wireBase,
    event_type: z.literal('live.start'),
    request_id: z.uuidv4(),
    source: liveSourceSchema,
    locale: z.enum(['en-US', 'zh-CN']),
    consent: z.literal(true),
  }),
  z
    .strictObject({
      ...wireBase,
      event_type: z.literal('live.audio'),
      frames: z.array(livePcmFrameSchema).min(1).max(10),
    })
    .refine(({ frames }) =>
      frames.every((frame, index) => {
        const previous = frames[index - 1];
        const first = frames[0]!;
        return (
          frame.recording_id === first.recording_id &&
          frame.preview_id === first.preview_id &&
          frame.track_id === first.track_id &&
          frame.capture_epoch === first.capture_epoch &&
          (!previous ||
            (frame.sequence === previous.sequence + 1 &&
              frame.sample_start === previous.sample_start + 800))
        );
      }),
    ),
  z.strictObject({ ...wireBase, event_type: z.literal('live.finish') }),
  z.strictObject({ ...wireBase, event_type: z.literal('live.cancel') }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;

const provisional = {
  ...wireBase,
  canonical: z.literal(false),
  continuity: z.literal('unverified'),
};
export const liveServerMessageSchema = z.union([
  liveRecognitionEventSchema,
  z.strictObject({
    ...provisional,
    event_type: z.literal('live.ready'),
    source: liveSourceSchema,
    provider_epoch: z.uuidv4(),
    max_media_ms: z.literal(60_000),
    max_unfinalized_ms: z.literal(5000),
  }),
  z
    .strictObject({
      ...wireBase,
      event_type: z.literal('live.accepted'),
      source: liveSourceSchema,
      provider_epoch: z.uuidv4(),
      acknowledgment: z.literal('authorization_only'),
      next_sequence: z.number().int().min(1).max(288_001),
      next_sample: sample,
      accepted_samples: z.number().int().min(800).max(960_000).multipleOf(800),
      finalized_samples: z.number().int().min(0).max(960_000).multipleOf(1600),
      gap: z
        .strictObject({ sample_start: sample, sample_end: sample })
        .refine((value) => value.sample_end > value.sample_start)
        .nullable(),
    })
    .refine((value) => value.finalized_samples <= value.accepted_samples),
  z.strictObject({
    ...wireBase,
    event_type: z.literal('live.progress'),
    source: liveSourceSchema,
    provider_epoch: z.uuidv4(),
    finalized_samples: z.number().int().min(1600).max(960_000).multipleOf(1600),
    acknowledgment: z.literal('provider_finalization_only'),
  }),
  z.strictObject({
    ...provisional,
    event_type: z.literal('live.closed'),
    reason: z.enum(['finished', 'cancelled']),
    usage_status: z.enum(['settled', 'check_account']),
  }),
  z.strictObject({
    ...provisional,
    event_type: z.literal('live.error'),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
    request_id: z.uuidv4(),
    usage_status: z.literal('check_account'),
  }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
