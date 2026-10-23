import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import {
  createAzureRealtimeProvider,
  type RealtimeIdentity,
} from '@windows-ai-notes/ai/realtime';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import {
  SEGMENTED_LIVE_PROFILE,
  type LiveSpeechProfile,
  type LiveRecognitionEvent,
} from '@windows-ai-notes/contracts/realtime';
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
    | 'speech'
    | 'silence'
    | 'initial-silence'
    | 'eof-no-match'
    | 'invalid-no-match'
    | 'empty-final'
    | 'eof-empty-final'
    | 'eof-final'
    | 'invalid'
    | 'disconnect'
    | 'partial-only'
    | 'long-phrase' = 'speech',
  profile?: LiveSpeechProfile,
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
  const connectionIds = new Set<string>();
  const identities: RealtimeIdentity[] = [];
  const contexts: unknown[] = [];
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
  server.on('connection', (socket, request) => {
    connections++;
    const connectionId = new URL(
      request.url!,
      'http://127.0.0.1',
    ).searchParams.get('X-ConnectionId');
    if (connectionId) connectionIds.add(connectionId.toLowerCase());
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
      if (fields.get('path')?.toLowerCase() === 'speech.context')
        contexts.push(JSON.parse(bytes.subarray(length + 4).toString()));
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
        if (
          mode === 'eof-no-match' ||
          mode === 'eof-empty-final' ||
          mode === 'eof-final'
        )
          send(socket, 'speech.phrase', request, {
            Id: randomUUID(),
            RecognitionStatus:
              mode === 'eof-no-match' ? 'InitialSilenceTimeout' : 'Success',
            ...(mode === 'eof-empty-final'
              ? { DisplayText: '' }
              : mode === 'eof-final'
                ? { DisplayText: 'Orion launch' }
                : {}),
            Offset: 0,
            Duration: (mediaBytes / 2) * 625 + 300_000,
          });
        send(socket, 'turn.end', request, {});
        return;
      }
      pcmValid &&= body.every((byte) => byte === 0x3b);
      const offset = (mediaBytes / 2) * 625;
      mediaBytes += body.length;
      if (mode === 'long-phrase') {
        if (mediaBytes === 640_000)
          send(socket, 'speech.phrase', request, {
            Id: randomUUID(),
            RecognitionStatus: 'Success',
            DisplayText: 'Orion launch',
            Offset: 0,
            Duration: 200_000_000,
          });
        else if (mediaBytes > 640_000)
          send(socket, 'speech.phrase', request, {
            Id: randomUUID(),
            RecognitionStatus: 'Success',
            DisplayText: 'Orion launch',
            Offset: offset,
            Duration: (body.length / 2) * 625,
          });
        return;
      }
      if (mode === 'disconnect') {
        socket.terminate();
        return;
      }
      if (mode !== 'silence' && mode !== 'initial-silence')
        send(socket, 'speech.hypothesis', request, {
          Id: randomUUID(),
          Text: 'Orion',
          Offset: offset,
          Duration: (body.length / 2) * 625,
        });
      if (
        mode !== 'partial-only' &&
        mode !== 'eof-no-match' &&
        mode !== 'eof-empty-final' &&
        mode !== 'eof-final'
      )
        send(socket, 'speech.phrase', request, {
          Id: randomUUID(),
          RecognitionStatus:
            mode === 'initial-silence' || mode === 'invalid-no-match'
              ? 'InitialSilenceTimeout'
              : mode === 'silence'
                ? 'NoMatch'
                : 'Success',
          ...(mode === 'initial-silence' || mode === 'invalid-no-match'
            ? {}
            : {
                DisplayText:
                  mode === 'silence' || mode === 'empty-final'
                    ? ''
                    : 'Orion launch',
              }),
          Offset:
            mode === 'invalid' || mode === 'invalid-no-match'
              ? 20_000_000
              : offset,
          Duration: (body.length / 2) * 625,
        });
    });
  });
  let worker!: Worker;
  const provider = createAzureRealtimeProvider(config, (locale, profile) => {
    worker = new Worker(
      new URL('../dist/realtime-worker.js', import.meta.url),
      {
        workerData: {
          key: config.AZURE_SPEECH_KEY,
          region: config.AZURE_SPEECH_REGION,
          locale,
          profile,
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
    .open(
      selected,
      'en-US',
      new AbortController().signal,
      (event) => {
        events.push(event);
        return undefined;
      },
      undefined,
      (identity) => {
        identities.push(identity);
        return undefined;
      },
      profile,
    )
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
    identities,
    connectionIds,
    contexts,
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
  it('uses supported time segmentation and consumes a complete twenty-second phrase before final credit, with no replay', async () => {
    const live = await fixture('long-phrase', SEGMENTED_LIVE_PROFILE);
    try {
      for (let batch = 0; batch < 20; batch++) {
        expect(live.session.finalizedSamples).toBe(0);
        for (let index = 0; index < 20; index++) live.write(batch * 20 + index);
        if (batch < 19) await delay(1000);
      }
      await expect
        .poll(() => live.session.finalizedSamples, {
          timeout: 2000,
          interval: 25,
        })
        .toBe(320_000);
      expect(live.events).toHaveLength(1);
      expect(live.events[0]).toMatchObject({
        event_type: 'transcript.final',
        sample_start: 1234,
        sample_end: 321_234,
      });
      expect(live.contexts).toContainEqual(
        expect.objectContaining({
          phraseDetection: expect.objectContaining({
            initialSilenceTimeout: 1000,
            conversation: expect.objectContaining({
              segmentation: expect.objectContaining({
                mode: 'Custom',
                segmentationForcedTimeoutMs: 20_000,
                segmentationSilenceTimeoutMs: 500,
              }),
            }),
          }),
        }),
      );
      for (let pair = 0; pair < 60; pair++) {
        live.write(400 + pair * 2);
        live.write(401 + pair * 2);
        await expect
          .poll(() => live.session.finalizedSamples, {
            timeout: 1000,
            interval: 5,
          })
          .toBe(320_000 + (pair + 1) * 1600);
      }
      expect((await live.session.finish()).usage.audio_ms).toBe(26_000);
      expect(live.stats()).toEqual({
        connections: 1,
        mediaBytes: 832_000,
        pcmValid: true,
        eof: true,
        thread: -1,
      });
    } finally {
      await live.close();
    }
  }, 30_000);
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
      expect(live.identities).toEqual([
        {
          provider_epoch: live.session.providerEpoch,
          status: 'accepted',
          session_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      ]);
      expect([...live.connectionIds]).toContain(live.identities[0]!.session_id);
    } finally {
      await live.close();
    }
  }, 15_000);
  it.each(['silence', 'initial-silence'] as const)(
    'credits explicit %s progress without fabricating transcript text',
    async (mode) => {
      const live = await fixture(mode);
      try {
        for (let pair = 0; pair < 60; pair++) {
          const progress = live.nextResult();
          live.write(pair * 2);
          live.write(pair * 2 + 1);
          expect((await progress)[0]).toMatchObject({
            result_type: 'no_match',
          });
        }
        expect((await live.session.finish()).usage.audio_ms).toBe(6000);
        expect(live.events).toEqual([]);
        expect(live.stats().pcmValid).toBe(true);
      } finally {
        await live.close();
      }
    },
    15_000,
  );
  it.each(['eof-no-match', 'eof-empty-final'] as const)(
    'discards a provisional hypothesis on padded terminal %s without inventing source audio or finalization credit',
    async (mode) => {
      const live = await fixture(mode, SEGMENTED_LIVE_PROFILE);
      try {
        live.write(0);
        live.write(1);
        await expect.poll(() => live.events.length).toBe(1);
        expect((await live.session.finish()).usage.audio_ms).toBe(100);
        expect(live.session.finalizedSamples).toBe(0);
        expect(live.events).toHaveLength(2);
        expect(live.events[1]).toMatchObject({
          event_type: 'transcript.discarded',
          sample_start: 1234,
          sample_end: 2834,
          text: '',
          discard_reason: mode === 'eof-no-match' ? 'no_match' : 'empty_final',
          version: 2,
          segment_id: live.events[0]!.segment_id,
        });
        expect(live.stats().thread).toBe(-1);
      } finally {
        await live.close();
      }
    },
  );
  it('handles a validated empty provider final as an explicit discard only on the negotiated profile', async () => {
    const live = await fixture('empty-final', SEGMENTED_LIVE_PROFILE);
    try {
      live.write(0);
      live.write(1);
      await expect.poll(() => live.events.length).toBe(2);
      expect(live.session.finalizedSamples).toBe(1600);
      expect(live.events[1]).toMatchObject({
        event_type: 'transcript.discarded',
        discard_reason: 'empty_final',
        text: '',
      });
      expect((await live.session.finish()).usage.audio_ms).toBe(100);
    } finally {
      await live.close();
    }
    const legacy = await fixture('empty-final');
    try {
      legacy.write(0);
      legacy.write(1);
      await expect(legacy.session.completion).rejects.toMatchObject({
        code: 'live_invalid_result',
      });
    } finally {
      await legacy.close();
    }
  });
  it.each(['eof-no-match', 'eof-empty-final'] as const)(
    'preserves strict legacy EOF range validation for %s',
    async (mode) => {
      const live = await fixture(mode);
      try {
        live.write(0);
        live.write(1);
        await expect.poll(() => live.events.length).toBe(1);
        await expect(live.session.finish()).rejects.toMatchObject({
          code: 'live_invalid_result',
        });
        expect(live.session.finalizedSamples).toBe(0);
      } finally {
        await live.close();
      }
    },
  );
  it('still rejects nonempty speech beyond input after EOF on the negotiated profile', async () => {
    const live = await fixture('eof-final', SEGMENTED_LIVE_PROFILE);
    try {
      live.write(0);
      live.write(1);
      await expect.poll(() => live.events.length).toBe(1);
      await expect(live.session.finish()).rejects.toMatchObject({
        code: 'live_invalid_result',
      });
      expect(live.session.finalizedSamples).toBe(0);
    } finally {
      await live.close();
    }
  });
  it.each(['invalid', 'invalid-no-match'] as const)(
    'rejects %s provider phrases outside submitted samples and terminates SDK resources',
    async (mode) => {
      const live = await fixture(mode);
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
    },
  );
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
