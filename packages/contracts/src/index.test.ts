import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  audioEventSchema,
  audioRequestSchema,
  encodeFrame,
  FrameDecoder,
  MAX_CONTROL_BYTES,
  type AudioRequest,
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
});
