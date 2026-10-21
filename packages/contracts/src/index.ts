import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_BYTES = 64 * 1024;
export const MAX_AUDIO_RANGE_BYTES = 32 * 1024;
export const AUDIO_ARCHIVE_PAGE_SIZE = 50;

const uuid = z
  .uuid()
  .refine(
    (id) => id !== '00000000-0000-0000-0000-000000000000',
    'UUID must not be empty.',
  );
const baseRequest = {
  protocol_version: z.literal(PROTOCOL_VERSION),
  request_id: uuid,
};

export const trackSchema = z
  .object({
    track_id: uuid,
    kind: z.enum(['microphone', 'loopback']),
    capture_scope: z.literal('endpoint'),
    device_selection_policy: z.enum(['default', 'explicit']),
    device_id: z.string().min(1).max(1024),
  })
  .strict()
  .refine(
    (track) =>
      (track.device_selection_policy === 'default') ===
      (track.device_id === 'default'),
    'Default policy requires the "default" device; explicit policy requires an endpoint ID.',
  );

export const audioRequestSchema = z.discriminatedUnion('command', [
  z.object({ ...baseRequest, command: z.literal('list_devices') }).strict(),
  z.strictObject({
    ...baseRequest,
    command: z.literal('recover_recording'),
    recording_id: uuid,
    accept_incomplete: z.literal(true),
  }),
  z.strictObject({
    ...baseRequest,
    command: z.literal('get_recording'),
    recording_id: uuid,
    offset: z.number().int().min(0).max(10_000),
  }),
  z.strictObject({
    ...baseRequest,
    command: z.literal('list_recording_chunks'),
    recording_id: uuid,
    track_id: uuid,
    sequence_start: z.number().int().min(0).max(10_000),
  }),
  z.strictObject({
    ...baseRequest,
    command: z.literal('read_chunk'),
    recording_id: uuid,
    chunk_id: uuid,
    offset: z.number().int().min(0).max(960_043),
    length: z.number().int().min(1).max(MAX_AUDIO_RANGE_BYTES),
  }),
  z
    .object({
      ...baseRequest,
      command: z.literal('start_recording'),
      recording_id: uuid,
      tracks: z.array(trackSchema).min(1).max(2),
    })
    .strict()
    .refine(
      ({ tracks }) =>
        new Set(tracks.map((track) => track.track_id)).size === tracks.length &&
        new Set(tracks.map((track) => track.kind)).size === tracks.length,
      'Track IDs and kinds must be unique.',
    ),
  ...(
    [
      'pause_recording',
      'resume_recording',
      'stop_recording',
      'inspect_recording',
    ] as const
  ).map((command) =>
    z
      .object({
        ...baseRequest,
        command: z.literal(command),
        recording_id: uuid,
      })
      .strict(),
  ),
]);

export const deviceSchema = z
  .object({
    device_id: z.string().min(1).max(1024),
    name: z.string().min(1).max(1024),
    kind: z.enum(['microphone', 'loopback']),
    is_default: z.boolean(),
  })
  .strict();

export const chunkSchema = z
  .object({
    format_version: z.literal(1),
    recording_id: uuid,
    track_id: uuid,
    chunk_id: uuid,
    capture_epoch: uuid,
    sequence: z.number().int().min(0).max(9_999),
    sample_start: z.number().int().nonnegative(),
    sample_count: z.number().int().positive().max(480_000),
    sample_rate: z.literal(16_000),
    channels: z.literal(1),
    bits_per_sample: z.literal(16),
    clock_start_ms: z.number().finite().nonnegative(),
    clock_end_ms: z.number().finite().nonnegative(),
    pcm_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (chunk) =>
      chunk.clock_end_ms >= chunk.clock_start_ms &&
      Number.isSafeInteger(chunk.sample_start + chunk.sample_count),
    'Chunk clocks and sample bounds must be consistent.',
  );

export const uploadChunkSchema = z
  .strictObject({
    chunk: chunkSchema,
    size_bytes: z.number().int().min(46).max(960_044),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (upload) => upload.size_bytes === upload.chunk.sample_count * 2 + 44,
    'The upload checksum and size describe canonical WAV bytes, not local ciphertext.',
  );
export type UploadChunk = z.infer<typeof uploadChunkSchema>;
export const captureTimelineEventSchema = z.strictObject({
  event_type: z.string().min(1).max(80),
  clock_ms: z.number().finite().min(0).max(14_400_000),
  capture_epoch: z.uuidv4().nullable(),
  code: z.string().max(80).nullable(),
});
export const captureGapSchema = z
  .strictObject({
    track_id: z.uuidv4(),
    start_ms: z.number().finite().min(0).max(14_400_000),
    end_ms: z.number().finite().min(0).max(14_400_000),
    reason: z.enum(['paused', 'device_lost', 'interrupted', 'unknown']),
  })
  .refine((gap) => gap.end_ms >= gap.start_ms);

export const recoverySchema = z
  .object({
    state: z.enum(['sealed', 'interrupted', 'incomplete', 'key_unavailable']),
    verified_chunks: z.number().int().nonnegative(),
    recovered_chunks: z.number().int().nonnegative(),
    issues: z
      .array(z.object({ code: z.string(), message: z.string() }).strict())
      .max(10_000),
    total_samples: z.number().int().nonnegative(),
  })
  .strict();

const eventBase = {
  protocol_version: z.literal(PROTOCOL_VERSION),
  request_id: uuid.nullable(),
  recording_id: uuid.nullable(),
};
const savedTrack = z
  .object({
    track_id: uuid,
    saved_samples: z.number().int().nonnegative(),
    device_id: z.string().min(1).max(1024),
    kind: z.enum(['microphone', 'loopback']),
    capture_scope: z.literal('endpoint'),
    device_selection_policy: z.enum(['default', 'explicit']),
  })
  .strict();
const statePayload = z
  .object({
    state: z.enum(['recording', 'paused', 'sealed', 'failed']),
    tracks: z.array(savedTrack).max(2),
  })
  .strict();

export const captureLevelsSchema = z
  .strictObject({
    capture_epoch: uuid,
    clock_ms: z.number().finite().min(0).max(14_400_000),
    tracks: z
      .array(
        z.strictObject({
          track_id: uuid,
          level: z
            .strictObject({
              samples: z.number().int().min(1).max(16_000),
              peak: z.number().finite().min(0).max(1),
              rms: z.number().finite().min(0).max(1),
              clock_ms: z.number().finite().min(0).max(14_400_000),
            })
            .refine((level) => level.rms <= level.peak)
            .nullable(),
        }),
      )
      .min(1)
      .max(2),
  })
  .refine(
    (levels) =>
      new Set(levels.tracks.map((track) => track.track_id)).size ===
        levels.tracks.length &&
      levels.tracks.every(
        (track) => !track.level || track.level.clock_ms <= levels.clock_ms,
      ),
    'Level previews must have distinct tracks and consistent capture clocks.',
  );
export type CaptureLevels = z.infer<typeof captureLevelsSchema>;

export const audioEventSchema = z.discriminatedUnion('event_type', [
  z.strictObject({
    ...eventBase,
    request_id: z.null(),
    recording_id: uuid,
    event_type: z.literal('recording.levels'),
    payload: captureLevelsSchema,
  }),
  z
    .strictObject({
      ...eventBase,
      event_type: z.literal('recording.manifest'),
      payload: z
        .strictObject({
          format_version: z.literal(1),
          recording_id: uuid,
          created_at: z.iso.datetime({ offset: true }),
          state: z.enum(['recording', 'paused', 'sealed', 'failed']),
          tracks: z
            .array(
              z.strictObject({
                spec: trackSchema,
                actual_device_id: z.string().min(1).max(1024),
                saved_samples: z.number().int().nonnegative(),
                chunk_count: z.number().int().min(0).max(10_000),
              }),
            )
            .min(1)
            .max(2),
          event_offset: z.number().int().min(0).max(10_000),
          event_count: z.number().int().min(0).max(10_000),
          events: z
            .array(
              z.strictObject({
                event_type: z.string().min(1).max(80),
                clock_ms: z.number().finite().nonnegative(),
                capture_epoch: uuid.nullable(),
                code: z.string().max(80).nullable(),
              }),
            )
            .max(AUDIO_ARCHIVE_PAGE_SIZE),
          has_more: z.boolean(),
        })
        .refine(
          (page) =>
            page.event_offset + page.events.length <= page.event_count &&
            page.has_more ===
              page.event_offset + page.events.length < page.event_count &&
            new Set(page.tracks.map((track) => track.spec.track_id)).size ===
              page.tracks.length &&
            new Set(page.tracks.map((track) => track.spec.kind)).size ===
              page.tracks.length &&
            page.tracks.reduce((sum, track) => sum + track.chunk_count, 0) <=
              10_000 &&
            page.tracks.every(
              (track) =>
                track.saved_samples >= track.chunk_count &&
                track.saved_samples <= track.chunk_count * 480_000,
            ),
          'Manifest pages must preserve track and timeline bounds.',
        ),
    })
    .refine((event) => event.recording_id === event.payload.recording_id),
  z
    .strictObject({
      ...eventBase,
      event_type: z.literal('recording.chunks'),
      payload: z
        .strictObject({
          track_id: uuid,
          sequence_start: z.number().int().min(0).max(10_000),
          chunks: z.array(uploadChunkSchema).max(AUDIO_ARCHIVE_PAGE_SIZE),
          has_more: z.boolean(),
        })
        .refine(
          (page) =>
            page.chunks.every(
              (upload, index) =>
                upload.chunk.track_id === page.track_id &&
                upload.chunk.sequence === page.sequence_start + index,
            ),
          'Chunk pages must preserve track sequence.',
        ),
    })
    .refine(
      (event) =>
        event.recording_id !== null &&
        event.payload.chunks.every(
          (upload) => upload.chunk.recording_id === event.recording_id,
        ),
    ),
  z
    .strictObject({
      ...eventBase,
      event_type: z.literal('recording.chunk_range'),
      payload: z
        .strictObject({
          upload: uploadChunkSchema,
          offset: z.number().int().min(0).max(960_043),
          data_base64: z
            .string()
            .min(4)
            .max(Math.ceil(MAX_AUDIO_RANGE_BYTES / 3) * 4)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
          end_of_chunk: z.boolean(),
        })
        .refine((range) => {
          const size =
            (range.data_base64.length / 4) * 3 -
            (range.data_base64.endsWith('==')
              ? 2
              : range.data_base64.endsWith('=')
                ? 1
                : 0);
          return (
            size >= 1 &&
            size <= MAX_AUDIO_RANGE_BYTES &&
            range.offset + size <= range.upload.size_bytes &&
            range.end_of_chunk ===
              (range.offset + size === range.upload.size_bytes)
          );
        }, 'Range bytes and the final marker must agree with the canonical WAV size.'),
    })
    .refine(
      (event) => event.recording_id === event.payload.upload.chunk.recording_id,
    ),
  z
    .object({
      ...eventBase,
      event_type: z.literal('devices'),
      payload: z.object({ devices: z.array(deviceSchema).max(100) }).strict(),
    })
    .strict(),
  ...(
    [
      'recording.started',
      'recording.paused',
      'recording.resumed',
      'recording.stopped',
      'recording.status',
    ] as const
  ).map((event_type) =>
    z
      .object({
        ...eventBase,
        event_type: z.literal(event_type),
        payload: statePayload,
      })
      .strict(),
  ),
  ...(['recording.inspected', 'recording.recovered'] as const).map(
    (event_type) =>
      z
        .object({
          ...eventBase,
          event_type: z.literal(event_type),
          payload: recoverySchema,
        })
        .strict(),
  ),
  z
    .object({
      ...eventBase,
      event_type: z.literal('error'),
      payload: z
        .object({
          code: z.string().min(1).max(80),
          message: z.string().min(1).max(512),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

export type AudioRequest = z.infer<typeof audioRequestSchema>;
export type AudioEvent = z.infer<typeof audioEventSchema>;
export type Track = z.infer<typeof trackSchema>;

export function encodeFrame(value: AudioRequest | AudioEvent): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_CONTROL_BYTES) {
    throw new Error('Control message exceeds the protocol limit.');
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);
  private failed = false;

  push(bytes: Uint8Array): unknown[] {
    if (this.failed)
      throw new Error('Decoder is closed after a protocol error.');
    const messages: unknown[] = [];
    let input: Buffer<ArrayBufferLike> = Buffer.from(bytes);
    try {
      while (input.length > 0) {
        const target =
          this.pending.length < 4 ? 4 : 4 + this.pending.readUInt32LE(0);
        const take = Math.min(target - this.pending.length, input.length);
        this.pending = Buffer.concat([this.pending, input.subarray(0, take)]);
        input = input.subarray(take);
        if (this.pending.length < 4) continue;
        const length = this.pending.readUInt32LE(0);
        if (length === 0 || length > MAX_CONTROL_BYTES) {
          throw new Error('Invalid control frame length.');
        }
        if (this.pending.length === length + 4) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(
            this.pending.subarray(4),
          );
          messages.push(JSON.parse(text) as unknown);
          this.pending = Buffer.alloc(0);
        }
      }
      return messages;
    } catch (error) {
      this.failed = true;
      this.pending = Buffer.alloc(0);
      throw error;
    }
  }

  finish(): void {
    if (this.failed || this.pending.length !== 0) {
      throw new Error(
        'Control stream ended with an incomplete or invalid frame.',
      );
    }
  }
}
