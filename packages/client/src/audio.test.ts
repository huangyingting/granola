import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MAX_AUDIO_RANGE_BYTES } from '@windows-ai-notes/contracts';
import { AudioHostClient, audioHostEnvironment } from './audio.js';

const fixture = fileURLToPath(
  new URL('../fixtures/audio-host.mjs', import.meta.url),
);
const recording = '75048e79-2b45-440f-8609-b80a37635b4a';
const track = 'ece5191a-347b-40a2-8d09-82565aa396a1';
const open = (mode: string, events: string[] = []) =>
  new AudioHostClient(process.execPath, [fixture, mode], (event) =>
    events.push(event.event_type),
  );
const captureTrack = {
  track_id: track,
  kind: 'microphone',
  capture_scope: 'endpoint',
  device_selection_policy: 'default',
  device_id: 'default',
} as const;
async function live(client: AudioHostClient) {
  await client.request({
    command: 'start_recording',
    recording_id: recording,
    tracks: [captureTrack],
  });
  const event = await client.request({
    command: 'start_live_preview',
    recording_id: recording,
  });
  if (event.event_type !== 'recording.live_started')
    throw new Error('No synthetic live preview.');
  return event.payload.preview_id;
}
async function descriptor(client: AudioHostClient) {
  const event = await client.request({
    command: 'list_recording_chunks',
    recording_id: recording,
    track_id: track,
    sequence_start: 0,
  });
  if (event.event_type !== 'recording.chunks' || !event.payload.chunks[0])
    throw new Error('No synthetic chunk descriptor.');
  return event.payload.chunks[0];
}

describe('bounded main-process native audio transport', () => {
  it('passes only OS/runtime location variables, never model keys, login credentials or startup hooks', () => {
    expect(
      audioHostEnvironment({
        SystemRoot: 'synthetic-system',
        Path: 'synthetic-path',
        TEMP: 'synthetic-temp',
        DOTNET_ROOT: 'synthetic-runtime',
        AZURE_OPENAI_API_KEY: 'synthetic-model-key',
        AUTHORIZATION: 'synthetic-access-token',
        DATABASE_URL: 'synthetic-database',
        NODE_OPTIONS: '--require=synthetic-hook',
        DOTNET_STARTUP_HOOKS: 'synthetic-hook',
      }),
    ).toEqual({
      SystemRoot: 'synthetic-system',
      Path: 'synthetic-path',
      TEMP: 'synthetic-temp',
      DOTNET_ROOT: 'synthetic-runtime',
    });
  });
  it('delivers request-bound live PCM only to its awaiting reader, preserving source clocks without forwarding audio to observers', async () => {
    const events: string[] = [];
    const client = open('capture-live', events);
    try {
      const preview = await live(client);
      for (let sequence = 0; sequence < 2; sequence++) {
        const event = await client.request({
          command: 'read_live_audio',
          recording_id: recording,
          preview_id: preview,
        });
        if (event.event_type !== 'recording.live_audio')
          throw new Error('No synthetic PCM.');
        expect(event.payload.frames).toHaveLength(1);
        const frame = event.payload.frames[0]!;
        expect(frame).toMatchObject({
          recording_id: recording,
          preview_id: preview,
          track_id: track,
          sample_start: 16_000 + sequence * 800,
          sequence,
          sample_count: 800,
          clock_start_ms: sequence * 50,
          clock_end_ms: (sequence + 1) * 50,
        });
        expect(Buffer.from(frame.data_base64, 'base64')).toEqual(
          Buffer.alloc(1600, 0x3b),
        );
      }
      const stopped = await client.request({
        command: 'stop_live_preview',
        recording_id: recording,
        preview_id: preview,
      });
      expect(stopped).toMatchObject({
        event_type: 'recording.live_stopped',
        payload: { state: 'stopped', frames: [] },
      });
      expect(events).toEqual([
        'recording.started',
        'recording.live_started',
        'recording.live_stopped',
      ]);
      await expect(
        client.request({
          command: 'stop_recording',
          recording_id: recording,
        }),
      ).resolves.toMatchObject({ payload: { state: 'sealed' } });
    } finally {
      await client.close();
    }
  });
  it('reports bounded preview failure without failing healthy capture control or emitting raw PCM to observers', async () => {
    const events: string[] = [];
    const client = open('capture-live-overrun', events);
    try {
      const preview = await live(client);
      await expect(
        client.request({
          command: 'read_live_audio',
          recording_id: recording,
          preview_id: preview,
        }),
      ).resolves.toMatchObject({
        payload: { state: 'failed', code: 'live_overrun', frames: [] },
      });
      await expect(
        client.request({
          command: 'pause_recording',
          recording_id: recording,
        }),
      ).resolves.toMatchObject({ payload: { state: 'paused' } });
      await expect(
        client.request({
          command: 'resume_recording',
          recording_id: recording,
        }),
      ).resolves.toMatchObject({ payload: { state: 'recording' } });
      await expect(
        client.request({
          command: 'stop_recording',
          recording_id: recording,
        }),
      ).resolves.toMatchObject({ payload: { state: 'sealed' } });
      expect(events).not.toContain('recording.live_audio');
    } finally {
      await client.close();
    }
  });
  it('stops a preview on capture pause and rejects stale preview IDs without poisoning valid capture commands', async () => {
    const client = open('capture-live');
    try {
      const preview = await live(client);
      await client.request({
        command: 'pause_recording',
        recording_id: recording,
      });
      await expect(
        client.request({
          command: 'read_live_audio',
          recording_id: recording,
          preview_id: preview,
        }),
      ).resolves.toMatchObject({
        payload: { state: 'stopped', code: 'capture_paused', frames: [] },
      });
      await expect(
        client.request({
          command: 'read_live_audio',
          recording_id: recording,
          preview_id: track,
        }),
      ).rejects.toMatchObject({ code: 'live_preview_not_found' });
      await expect(
        client.request({
          command: 'stop_recording',
          recording_id: recording,
        }),
      ).resolves.toMatchObject({ payload: { state: 'sealed' } });
    } finally {
      await client.close();
    }
  });
  it.each(['wrong-preview', 'wrong-track'])(
    'rejects live %s before forwarding it to any status observer',
    async (change) => {
      const events: string[] = [];
      const client = open(`capture-live-${change}`, events);
      const preview = await live(client);
      await expect(
        client.request({
          command: 'read_live_audio',
          recording_id: recording,
          preview_id: preview,
        }),
      ).rejects.toThrow();
      expect(events).toEqual(['recording.started', 'recording.live_started']);
      await expect(client.close()).rejects.toThrow();
    },
  );
  it('streams deterministic WAV ranges and verifies the upload checksum without forwarding media to event observers', async () => {
    const events: string[] = [];
    const client = open('range', events);
    try {
      const upload = await descriptor(client);
      const chunks: Buffer[] = [];
      for await (const bytes of client.readChunk(recording, upload)) {
        expect(bytes.length).toBeLessThanOrEqual(MAX_AUDIO_RANGE_BYTES);
        chunks.push(bytes);
      }
      const wav = Buffer.concat(chunks);
      expect(chunks.map((bytes) => bytes.length)).toEqual([32_768, 32_768, 44]);
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.readUInt32LE(24)).toBe(16_000);
      expect(createHash('sha256').update(wav).digest('hex')).toBe(
        upload.sha256,
      );
      expect(events).toEqual(['recording.chunks']);
    } finally {
      await client.close();
    }
  });
  it.each(['before-first', 'between-ranges', 'after-response'] as const)(
    'checks source availability %s without requesting or yielding a disallowed range',
    async (point) => {
      const client = open('range');
      let stream: ReturnType<AudioHostClient['readChunk']> | undefined;
      const failure = new Error('Synthetic local audio access expired.');
      let denied = point === 'before-first';
      const check = vi.fn(() => {
        if (denied) throw failure;
      });
      try {
        const upload = await descriptor(client);
        const original = client.request.bind(client);
        const request = vi
          .spyOn(client, 'request')
          .mockImplementation(async (fields) => {
            const event = await original(fields);
            if (point === 'after-response') denied = true;
            return event;
          });
        stream = client.readChunk(recording, upload, undefined, check);
        if (point === 'between-ranges') {
          const first = await stream.next();
          expect(first.done).toBe(false);
          expect(first.value.length).toBe(MAX_AUDIO_RANGE_BYTES);
          denied = true;
        }
        const next = stream.next().then((part) => ({
          done: part.done,
          bytes: part.value?.length,
        }));
        await expect(next).rejects.toBe(failure);
        expect(request).toHaveBeenCalledTimes(point === 'before-first' ? 0 : 1);
        expect(await client.request({ command: 'list_devices' })).toMatchObject(
          {
            event_type: 'devices',
          },
        );
      } finally {
        await stream?.return(undefined);
        await client.close();
      }
    },
  );
  it.each(['changed', 'wrong-offset', 'bad-hash'])(
    'rejects %s media and closes the untrusted protocol session',
    async (mode) => {
      const client = open(mode);
      const upload = await descriptor(client);
      const consume = async () => {
        for await (const bytes of client.readChunk(recording, upload))
          expect(bytes.length).toBeGreaterThan(0);
      };
      await expect(consume()).rejects.toThrow(/metadata|checksum/);
      await expect(client.close()).rejects.toThrow();
    },
  );
  it('cancels between bounded reads and reports a file error without stopping a healthy capture transport', async () => {
    const client = open('read-error');
    try {
      const upload = await descriptor(client);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        client.readChunk(recording, upload, cancelled.signal).next(),
      ).rejects.toThrow('cancelled');
      await expect(
        client.readChunk(recording, upload).next(),
      ).rejects.toMatchObject({
        code: 'chunk_unreadable',
        retryable: false,
      });
      expect(await client.request({ command: 'list_devices' })).toMatchObject({
        event_type: 'devices',
      });
      await expect(client.readChunk(track, upload).next()).rejects.toThrow(
        'different recording',
      );
    } finally {
      await client.close();
    }
  });
  it('rejects mismatched reply kinds before notifying a consumer', async () => {
    const events: string[] = [];
    const client = open('wrong-kind', events);
    await expect(descriptor(client)).rejects.toThrow(
      'different recording or response type',
    );
    expect(events).toEqual([]);
    await expect(client.close()).rejects.toThrow();
  });
  it('settles an unanswered range request when the helper closes rather than waiting for the request timeout', async () => {
    const client = open('archive-stall-read');
    const upload = await descriptor(client);
    const reading = client.readChunk(recording, upload).next();
    const rejected = expect(reading).rejects.toMatchObject({
      code: 'audio_request_cancelled',
    });
    await client.close();
    await rejected;
  });
  it('bounds outstanding commands instead of allowing unbounded control-stream buffering', async () => {
    const client = open('slow');
    try {
      const outstanding = Array.from({ length: 8 }, () =>
        client.request({ command: 'list_devices' }),
      );
      await expect(client.request({ command: 'list_devices' })).rejects.toThrow(
        'busy',
      );
      expect(await Promise.all(outstanding)).toHaveLength(8);
    } finally {
      await client.close();
    }
    await expect(client.request({ command: 'list_devices' })).rejects.toThrow(
      'closing',
    );
  });
});
