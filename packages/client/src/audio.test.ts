import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
