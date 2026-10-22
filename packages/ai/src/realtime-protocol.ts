import { z } from 'zod';
import { normalizeProviderId } from './provider-id.js';

export const MAX_PENDING_SAMPLES = 80_000;
export const MAX_SESSION_SAMPLES = 16_000 * 60 * 10;
export const LIVE_STALL_MS = 5000;
export const LIVE_START_MS = 10_000;
const ticks = z
  .number()
  .int()
  .min(0)
  .max(MAX_SESSION_SAMPLES * 625);
export const speechResultSchema = z
  .strictObject({
    kind: z.literal('result'),
    sequence: z.number().int().min(1).max(1_000_000),
    result_type: z.enum(['partial', 'final', 'no_match']),
    result_id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
    offset_ticks: ticks,
    duration_ticks: ticks,
    text: z.string().max(4000),
  })
  .refine(
    (result) =>
      result.offset_ticks + result.duration_ticks <= MAX_SESSION_SAMPLES * 625,
  );
export const speechWorkerEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready') }),
  z
    .strictObject({
      kind: z.literal('session'),
      session_id: z
        .string()
        .length(32)
        .regex(/^[0-9a-f]{32}$/)
        .nullable(),
      status: z.enum(['accepted', 'rejected']),
    })
    .refine(
      (value) => (value.status === 'accepted') === (value.session_id !== null),
    ),
  speechResultSchema,
  z.strictObject({
    kind: z.literal('stopped'),
    samples: z.number().int().min(0).max(MAX_SESSION_SAMPLES),
  }),
  z.strictObject({
    kind: z.literal('error'),
    code: z.enum([
      'provider_authentication_failed',
      'provider_rate_limited',
      'provider_unavailable',
      'live_audio_overrun',
      'live_invalid_result',
      'live_worker_protocol',
      'live_event_overrun',
      'live_provider_closed',
    ]),
  }),
]);
export const speechWorkerCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('audio'),
    sequence: z
      .number()
      .int()
      .min(0)
      .max(MAX_SESSION_SAMPLES / 800),
    pcm: z.instanceof(ArrayBuffer).refine((value) => value.byteLength === 1600),
  }),
  z.strictObject({ kind: z.literal('end') }),
  z.strictObject({
    kind: z.literal('ack'),
    sequence: z.number().int().min(1).max(1_000_000),
  }),
]);
export type SpeechWorkerResult = z.infer<typeof speechResultSchema>;
export type SpeechWorkerEvent = z.infer<typeof speechWorkerEventSchema>;
export function speechSessionIdentity(
  value: unknown,
): Extract<SpeechWorkerEvent, { kind: 'session' }> {
  const session_id = normalizeProviderId(value);
  return {
    kind: 'session',
    session_id,
    status: session_id === null ? 'rejected' : 'accepted',
  };
}
