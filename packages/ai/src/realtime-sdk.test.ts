import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createAzureRealtimeProvider } from '@windows-ai-notes/ai/realtime';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import type { LiveRecognitionEvent } from '@windows-ai-notes/contracts/realtime';
import type { AzureConfig } from './config.js';

const config: AzureConfig = {
  AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
  AZURE_OPENAI_API_KEY: 'synthetic-openai-key',
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
  AZURE_OPENAI_DEPLOYMENT: 'fixture',
  AZURE_SPEECH_KEY: 'synthetic-speech-key',
  AZURE_SPEECH_REGION: 'westus',
};
async function fixture(
  mode:
    'speech' | 'silence' | 'invalid' | 'disconnect' | 'partial-only' = 'speech',
) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: 128 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (typeof address === 'string' || !address)
    throw new Error('No synthetic speech endpoint.');
  let connections = 0;
  let mediaBytes = 0;
  let pcmValid = true;
  let eof = false;
  function send(
    socket: WebSocket,
    path: string,
    request: string,
    body: unknown,
  ) {
    socket.send(
      `Path:${path}\r\nX-RequestId:${request}\r\nContent-Type:application/json\r\n\r\n${JSON.stringify(body)}`,
    );
  }
  server.on('connection', (socket) => {
    connections++;
    let started = false;
    socket.on('message', (data, binary) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const length = binary ? bytes.readUInt16BE(0) : bytes.indexOf('\r\n\r\n');
      const headers = bytes
        .subarray(binary ? 2 : 0, binary ? 2 + length : length)
        .toString('utf8');
      const fields = new Map(
        headers.split('\r\n').map((line) => {
          const index = line.indexOf(':');
          return [
            line.slice(0, index).toLowerCase(),
            line.slice(index + 1).trim(),
          ];
        }),
      );
      if (fields.get('path')?.toLowerCase() !== 'audio') return;
      const request = fields.get('x-requestid');
      if (!request) throw new Error('No synthetic speech request identity.');
      if (!started) {
        started = true;
        send(socket, 'turn.start', request, {});
      }
      const body = bytes.subarray(2 + length);
      if (body.subarray(0, 4).toString() === 'RIFF') return;
      if (!body.length) {
        eof = true;
        send(socket, 'turn.end', request, {});
        return;
      }
      pcmValid &&= body.every((byte) => byte === 0x3b);
      const offset = (mediaBytes / 2) * 625;
      mediaBytes += body.length;
      if (mode === 'disconnect') {
        socket.terminate();
        return;
      }
      if (mode !== 'silence')
        send(socket, 'speech.hypothesis', request, {
          Id: randomUUID(),
          Text: 'Orion',
          Offset: offset,
          Duration: (body.length / 2) * 625,
        });
      if (mode !== 'partial-only')
        send(socket, 'speech.phrase', request, {
          Id: randomUUID(),
          RecognitionStatus: mode === 'silence' ? 'NoMatch' : 'Success',
          DisplayText: mode === 'silence' ? '' : 'Orion launch',
          Offset: mode === 'invalid' ? 20_000_000 : offset,
          Duration: (body.length / 2) * 625,
        });
    });
  });
  let worker!: Worker;
  const provider = createAzureRealtimeProvider(config, (locale) => {
    worker = new Worker(
      new URL('../dist/realtime-worker.js', import.meta.url),
      {
        workerData: {
          key: config.AZURE_SPEECH_KEY,
          region: config.AZURE_SPEECH_REGION,
          locale,
        },
        execArgv: [
          '--import',
          new URL('../fixtures/live-sdk-preload.mjs', import.meta.url).href,
        ],
        env: {
          SYNTHETIC_SPEECH_ENDPOINT: `ws://127.0.0.1:${address.port}/speech/recognition/conversation/cognitiveservices/v1`,
        },
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
        },
      },
    );
    return worker;
  });
  const selected = {
    recording_id: randomUUID(),
    preview_id: randomUUID(),
    track_id: randomUUID(),
    capture_epoch: randomUUID(),
  };
  const events: LiveRecognitionEvent[] = [];
  const shutdown = async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  const session = await provider
    .open(selected, 'en-US', new AbortController().signal, (event) => {
      events.push(event);
      return undefined;
    })
    .catch(async (error: unknown) => {
      await shutdown();
      throw error;
    });
  function write(sequence: number) {
    const frame: LivePcmFrame = {
      ...selected,
      format_version: 1,
      sequence,
      sample_start: 1234 + sequence * 800,
      sample_count: 800,
      sample_rate: 16_000,
      channels: 1,
      bits_per_sample: 16,
      clock_start_ms: sequence * 50,
      clock_end_ms: (sequence + 1) * 50,
      data_base64: Buffer.alloc(1600, 0x3b).toString('base64'),
    };
    session.write(frame);
  }
  return {
    session,
    events,
    write,
    nextResult: () => once(worker, 'message'),
    stats: () => ({
      connections,
      mediaBytes,
      pcmValid,
      eof,
      thread: worker.threadId,
    }),
    async close() {
      await session.cancel();
      await shutdown();
    },
  };
}

describe('actual pinned Azure Speech SDK with an isolated synthetic service', () => {
  it('streams intact header-free PCM beyond five seconds as validated final results advance, then drains EOF before a known receipt', async () => {
    const live = await fixture();
    try {
      for (let pair = 0; pair < 60; pair++) {
        live.write(pair * 2);
        live.write(pair * 2 + 1);
        await expect
          .poll(
            () =>
              live.events.filter(
                (event) => event.event_type === 'transcript.final',
              ).length,
            { interval: 5, timeout: 1000 },
          )
          .toBe(pair + 1);
      }
      const completed = await live.session.finish();
      expect(completed.usage.audio_ms).toBe(6000);
      expect(live.stats()).toEqual({
        connections: 1,
        mediaBytes: 192_000,
        pcmValid: true,
        eof: true,
        thread: -1,
      });
      expect(live.events[0]).toMatchObject({
        event_type: 'transcript.partial',
        sample_start: 1234,
        sample_end: 2834,
      });
      expect(live.events[0]!.segment_id).toBe(live.events[1]!.segment_id);
      expect(live.events[1]!.version).toBe(2);
    } finally {
      await live.close();
    }
  }, 15_000);
  it('credits explicit NoMatch progress without fabricating transcript text', async () => {
    const live = await fixture('silence');
    try {
      for (let pair = 0; pair < 60; pair++) {
        const progress = live.nextResult();
        live.write(pair * 2);
        live.write(pair * 2 + 1);
        expect((await progress)[0]).toMatchObject({ result_type: 'no_match' });
      }
      expect((await live.session.finish()).usage.audio_ms).toBe(6000);
      expect(live.events).toEqual([]);
      expect(live.stats().pcmValid).toBe(true);
    } finally {
      await live.close();
    }
  }, 15_000);
  it('rejects provider phrases outside submitted samples and terminates SDK resources', async () => {
    const live = await fixture('invalid');
    try {
      live.write(0);
      live.write(1);
      await expect(live.session.completion).rejects.toMatchObject({
        code: 'live_invalid_result',
      });
      expect(live.stats().thread).toBe(-1);
    } finally {
      await live.close();
    }
  });
  it.each([false, true])(
    'ends the isolated SDK on a dropped connection (finishing=%s) without automatically reconnecting or replaying paid audio',
    async (finishing) => {
      const live = await fixture('disconnect');
      try {
        live.write(0);
        live.write(1);
        if (finishing) void live.session.finish();
        await expect(live.session.completion).rejects.toMatchObject({
          code: expect.stringMatching(
            /live_provider_closed|provider_unavailable/,
          ),
        });
        expect(live.stats().thread).toBe(-1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(live.stats().connections).toBe(1);
      } finally {
        await live.close();
      }
    },
  );
  it('bounds real SDK audio even when a connected service keeps producing partials without finalizing', async () => {
    const live = await fixture('partial-only');
    try {
      live.write(0);
      live.write(1);
      await expect
        .poll(() => live.events.length, { interval: 5, timeout: 1000 })
        .toBeGreaterThan(0);
      for (let sequence = 2; sequence < 100; sequence++) live.write(sequence);
      expect(() => live.write(100)).toThrow();
      await expect(live.session.completion).rejects.toMatchObject({
        code: 'live_audio_overrun',
      });
      expect(live.stats().mediaBytes).toBeLessThanOrEqual(160_000);
      expect(live.stats().thread).toBe(-1);
    } finally {
      await live.close();
    }
  });
});
