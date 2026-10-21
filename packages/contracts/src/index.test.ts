import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  audioEventSchema,
  audioRequestSchema,
  encodeFrame,
  FrameDecoder,
  MAX_CONTROL_BYTES,
  liveAudioBatchSchema,
  type AudioRequest,
  uploadChunkSchema,
} from './index.js';

const request: AudioRequest = {
  protocol_version: 1,
  request_id: randomUUID(),
  command: 'list_devices',
};

describe('AudioHost framing', () => {
  it('handles fragmented headers, payloads, and multiple frames', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(request);
    const bytes = Buffer.concat([frame, frame]);
    const received: unknown[] = [];
    for (const byte of bytes)
      received.push(...decoder.push(Buffer.from([byte])));
    expect(received).toEqual([request, request]);
    decoder.finish();
  });

  it.each([0, MAX_CONTROL_BYTES + 1, 0xffffffff])(
    'rejects length %i before buffering a body',
    (length) => {
      const decoder = new FrameDecoder();
      const header = Buffer.alloc(4);
      header.writeUInt32LE(length);
      expect(() => decoder.push(header)).toThrow('length');
      expect(() => decoder.push(encodeFrame(request))).toThrow('closed');
    },
  );

  it('rejects truncated, malformed, and invalid UTF-8 frames', () => {
    const truncated = new FrameDecoder();
    truncated.push(encodeFrame(request).subarray(0, -1));
    expect(() => truncated.finish()).toThrow('incomplete');
    for (const body of [Buffer.from('{'), Buffer.from([0xff])]) {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      expect(() =>
        new FrameDecoder().push(Buffer.concat([length, body])),
      ).toThrow();
    }
  });
});

describe('capture boundaries', () => {
  it('bounds request-only live PCM batches and refuses mixed preview, source, format or sample identity', () => {
    const recording = randomUUID();
    const preview = randomUUID();
    const epoch = randomUUID();
    const source = randomUUID();
    const frame = {
      format_version: 1,
      recording_id: recording,
      preview_id: preview,
      track_id: source,
      capture_epoch: epoch,
      sequence: 0,
      sample_start: 16_000,
      sample_count: 800,
      sample_rate: 16_000,
      channels: 1,
      bits_per_sample: 16,
      clock_start_ms: 0,
      clock_end_ms: 50,
      data_base64: Buffer.alloc(1600, 0x3b).toString('base64'),
    };
    const batch = {
      preview_id: preview,
      capture_epoch: epoch,
      state: 'active',
      code: null,
      tracks: [{ track_id: source, sample_end: 16_800, buffered_samples: 0 }],
      frames: [frame],
    };
    const event = {
      protocol_version: 1,
      request_id: randomUUID(),
      recording_id: recording,
      event_type: 'recording.live_audio',
      payload: batch,
    };
    expect(audioEventSchema.safeParse(event).success).toBe(true);
    for (const invalid of [
      { ...event, request_id: null },
      { ...event, recording_id: randomUUID() },
      { ...event, event_type: 'recording.live_started' },
      { ...event, event_type: 'recording.live_stopped' },
      ...[
        { ...batch, preview_id: randomUUID() },
        { ...batch, capture_epoch: randomUUID() },
        { ...batch, state: 'failed', code: 'live_overrun' },
        {
          ...batch,
          tracks: [{ ...batch.tracks[0], buffered_samples: 80_001 }],
        },
        { ...batch, tracks: [{ ...batch.tracks[0], sample_end: 16_799 }] },
        { ...batch, tracks: [...batch.tracks, ...batch.tracks] },
        { ...batch, frames: [frame, frame] },
        ...[
          { ...frame, track_id: randomUUID() },
          { ...frame, sequence: -1 },
          { ...frame, sample_count: 801 },
          { ...frame, sample_rate: 48_000 },
          { ...frame, channels: 2 },
          { ...frame, data_base64: Buffer.alloc(1599).toString('base64') },
          { ...frame, data_base64: `${frame.data_base64.slice(0, -3)}x==` },
          { ...frame, clock_end_ms: -1 },
        ].map((frame) => ({ ...batch, frames: [frame] })),
      ].map((payload) => ({ ...event, payload })),
    ])
      expect(audioEventSchema.safeParse(invalid).success).toBe(false);
    expect(
      liveAudioBatchSchema.safeParse({
        ...batch,
        state: 'failed',
        code: 'live_overrun',
        frames: [],
      }).success,
    ).toBe(true);
    expect(
      audioEventSchema.safeParse({
        ...event,
        event_type: 'recording.live_started',
        payload: { ...batch, frames: [] },
      }).success,
    ).toBe(true);
    expect(
      audioEventSchema.safeParse({
        ...event,
        event_type: 'recording.live_stopped',
        payload: {
          ...batch,
          state: 'stopped',
          code: 'preview_stopped',
          frames: [],
        },
      }).success,
    ).toBe(true);
    expect(
      liveAudioBatchSchema.safeParse({
        ...batch,
        frames: Array.from({ length: 11 }, (_, sequence) => ({
          ...frame,
          sequence,
          sample_start: 16_000 + sequence * 800,
        })),
        tracks: [{ track_id: source, sample_end: 24_800, buffered_samples: 0 }],
      }).success,
    ).toBe(false);
  });
  it('agrees with the native process on shared request vectors', () => {
    const vectors: { valid: boolean; request: unknown }[] = JSON.parse(
      readFileSync(
        new URL('../fixtures/requests.json', import.meta.url),
        'utf8',
      ),
    );
    for (const vector of vectors) {
      expect(audioRequestSchema.safeParse(vector.request).success).toBe(
        vector.valid,
      );
    }
  });
  const track = {
    track_id: randomUUID(),
    kind: 'loopback',
    capture_scope: 'endpoint',
    device_selection_policy: 'default',
    device_id: 'default',
  };
  const start = {
    protocol_version: 1,
    request_id: randomUUID(),
    recording_id: randomUUID(),
    command: 'start_recording',
    tracks: [track],
  };

  it('accepts endpoint capture and rejects implied process isolation', () => {
    expect(audioRequestSchema.safeParse(start).success).toBe(true);
    expect(
      audioRequestSchema.safeParse({
        ...start,
        tracks: [{ ...track, capture_scope: 'process_tree' }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate tracks, mismatched device policy, unknown fields and versions', () => {
    for (const invalid of [
      { ...start, tracks: [track, track] },
      { ...start, tracks: [{ ...track, device_selection_policy: 'explicit' }] },
      { ...start, path: '../../outside' },
      { ...start, protocol_version: 2 },
      { ...start, recording_id: '../../outside' },
    ]) {
      expect(audioRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('validates error responses instead of accepting arbitrary payloads', () => {
    expect(
      audioEventSchema.safeParse({
        protocol_version: 1,
        request_id: request.request_id,
        recording_id: null,
        event_type: 'error',
        payload: {
          code: 'device_unavailable',
          message: 'Select an active endpoint.',
          retryable: true,
        },
      }).success,
    ).toBe(true);
    expect(
      audioEventSchema.safeParse({ event_type: 'recording.started' }).success,
    ).toBe(false);
  });

  it('bounds unsolicited level previews and distinguishes absent frames from measured silence', () => {
    const level = { samples: 800, peak: 0.5, rms: 0.25, clock_ms: 50 };
    const event = {
      protocol_version: 1,
      request_id: null,
      recording_id: randomUUID(),
      event_type: 'recording.levels',
      payload: {
        capture_epoch: randomUUID(),
        clock_ms: 100,
        tracks: [{ track_id: track.track_id, level }],
      },
    };
    expect(audioEventSchema.safeParse(event).success).toBe(true);
    for (const reading of [null, { ...level, peak: 0, rms: 0 }])
      expect(
        audioEventSchema.safeParse({
          ...event,
          payload: {
            ...event.payload,
            tracks: [{ track_id: track.track_id, level: reading }],
          },
        }).success,
      ).toBe(true);
    for (const invalid of [
      { ...event, request_id: randomUUID() },
      { ...event, recording_id: null },
      { ...event, payload: { ...event.payload, tracks: [] } },
      {
        ...event,
        payload: {
          ...event.payload,
          tracks: [event.payload.tracks[0], event.payload.tracks[0]],
        },
      },
      ...[
        { ...level, samples: 16_001 },
        { ...level, peak: Number.NaN },
        { ...level, peak: 1.01 },
        { ...level, rms: 0.51 },
        { ...level, clock_ms: 101 },
        { ...level, pcm_base64: 'not-for-the-renderer' },
      ].map((reading) => ({
        ...event,
        payload: {
          ...event.payload,
          tracks: [{ track_id: track.track_id, level: reading }],
        },
      })),
    ])
      expect(audioEventSchema.safeParse(invalid).success).toBe(false);
  });

  it('binds bounded media replies to canonical WAV sizes, recording identity and final markers', () => {
    const recording = randomUUID();
    const chunk = {
      format_version: 1,
      recording_id: recording,
      track_id: randomUUID(),
      chunk_id: randomUUID(),
      capture_epoch: randomUUID(),
      sequence: 0,
      sample_start: 0,
      sample_count: 16,
      sample_rate: 16_000,
      channels: 1,
      bits_per_sample: 16,
      clock_start_ms: 0,
      clock_end_ms: 1,
      pcm_sha256: '0'.repeat(64),
    };
    const upload = { chunk, size_bytes: 76, sha256: '1'.repeat(64) };
    expect(uploadChunkSchema.safeParse(upload).success).toBe(true);
    expect(
      uploadChunkSchema.safeParse({ ...upload, size_bytes: 32 }).success,
    ).toBe(false);
    const event = {
      protocol_version: 1,
      request_id: randomUUID(),
      recording_id: recording,
      event_type: 'recording.chunk_range',
      payload: {
        upload,
        offset: 0,
        data_base64: Buffer.alloc(76).toString('base64'),
        end_of_chunk: true,
      },
    };
    expect(audioEventSchema.safeParse(event).success).toBe(true);
    for (const bad of [
      { ...event, recording_id: randomUUID() },
      { ...event, payload: { ...event.payload, offset: 1 } },
      { ...event, payload: { ...event.payload, end_of_chunk: false } },
      { ...event, payload: { ...event.payload, data_base64: '!invalid!' } },
    ])
      expect(audioEventSchema.safeParse(bad).success).toBe(false);
  });
});
