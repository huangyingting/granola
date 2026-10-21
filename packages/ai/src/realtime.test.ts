import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAzureRealtimeProvider,
  type RealtimeSession,
} from '@windows-ai-notes/ai/realtime';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import type {
  LiveRecognitionEvent,
  LiveSource,
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
const source = (): LiveSource => ({
  recording_id: randomUUID(),
  preview_id: randomUUID(),
  track_id: randomUUID(),
  capture_epoch: randomUUID(),
});
function frame(source: LiveSource, sequence = 0): LivePcmFrame {
  return {
    ...source,
    format_version: 1,
    sequence,
    sample_start: 12_345 + sequence * 800,
    sample_count: 800,
    sample_rate: 16_000,
    channels: 1,
    bits_per_sample: 16,
    clock_start_ms: sequence * 50,
    clock_end_ms: (sequence + 1) * 50,
    data_base64: Buffer.alloc(1600, 0x3b).toString('base64'),
  };
}
const owned: RealtimeSession[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((session) => session.cancel()));
  vi.useRealTimers();
});
async function open(
  mode = 'normal',
  results: Record<number, unknown[]> = {},
  emit?: (event: LiveRecognitionEvent) => undefined,
) {
  const selected = source();
  const events: LiveRecognitionEvent[] = [];
  let worker!: Worker;
  const provider = createAzureRealtimeProvider(config, () => {
    worker = new Worker(
      new URL('../fixtures/live-worker.mjs', import.meta.url),
      {
        workerData: { mode, results },
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
      },
    );
    return worker;
  });
  const controller = new AbortController();
  const session = await provider.open(
    selected,
    'en-US',
    controller.signal,
    emit ??
      ((event) => {
        events.push(event);
        return undefined;
      }),
  );
  owned.push(session);
  return { session, worker, selected, events, controller };
}

describe('bounded isolated streaming speech sessions', () => {
  it('publishes stable partial/final revisions with immutable source sample identity and a known completion receipt', async () => {
    const { session, selected, events, worker } = await open('scripted', {
      0: [{ result_type: 'partial', duration_ticks: 500_000, text: 'Orion' }],
      1: [{ duration_ticks: 1_000_000 }],
      2: [{ duration_ticks: 1_000_000 }],
      3: [
        {
          result_type: 'partial',
          offset_ticks: 1_000_000,
          duration_ticks: 1_000_000,
          text: 'Next',
        },
      ],
      4: [{ duration_ticks: 1_000_000, text: 'Orion approved' }],
      5: [
        {
          offset_ticks: 1_000_000,
          duration_ticks: 2_000_000,
          text: 'Next item',
        },
      ],
    });
    for (let sequence = 0; sequence < 6; sequence++)
      session.write(frame(selected, sequence));
    const completed = await session.finish();
    expect(
      events.map((event) => [event.event_type, event.version, event.text]),
    ).toEqual([
      ['transcript.partial', 1, 'Orion'],
      ['transcript.final', 2, 'Orion launch'],
      ['transcript.partial', 1, 'Next'],
      ['transcript.final', 3, 'Orion approved'],
      ['transcript.final', 2, 'Next item'],
    ]);
    expect(events[0]!.segment_id).toBe(events[1]!.segment_id);
    expect(events[0]!.segment_id).toBe(events[3]!.segment_id);
    expect(events[2]!.segment_id).toBe(events[4]!.segment_id);
    expect(events[0]).toMatchObject({
      source: selected,
      sample_start: 12_345,
      sample_end: 13_145,
      provider_epoch: session.providerEpoch,
    });
    expect(completed).toMatchObject({
      samples: 4800,
      usage: { input_tokens: 0, output_tokens: 0, audio_ms: 300 },
    });
    expect(worker.threadId).toBe(-1);
  });
  it('holds partial-only audio inside the strict five-second limit and never treats partial recognition as free queue credit', async () => {
    const { session, selected, worker } = await open('partials');
    for (let sequence = 0; sequence < 100; sequence++)
      session.write(frame(selected, sequence));
    expect(() => session.write(frame(selected, 100))).toThrow();
    await expect(session.completion).rejects.toMatchObject({
      code: 'live_audio_overrun',
    });
    expect(worker.threadId).toBe(-1);
  });
  it('credits only validated final/NoMatch progress at the pinned SDK replay-chunk boundary', async () => {
    const { session, selected, events, worker } = await open('progress');
    for (let sequence = 0; sequence < 120; sequence += 2) {
      const progress = once(worker, 'message');
      session.write(frame(selected, sequence));
      session.write(frame(selected, sequence + 1));
      expect((await progress)[0]).toMatchObject({ result_type: 'no_match' });
    }
    expect((await session.finish()).usage.audio_ms).toBe(6000);
    expect(events).toEqual([]);
  });
  it.each(['recording_id', 'preview_id', 'track_id', 'capture_epoch'] as const)(
    'fences changed %s before forwarding it to the provider',
    async (key) => {
      const { session, selected } = await open();
      expect(() =>
        session.write({ ...frame(selected), [key]: randomUUID() }),
      ).toThrow();
      await expect(session.completion).rejects.toMatchObject({
        code: 'live_source_mismatch',
      });
    },
  );
  it.each(['duplicate', 'sample-jump', 'sequence-jump', 'malformed'] as const)(
    'rejects %s frames without a second billable send',
    async (change) => {
      const { session, selected } = await open('scripted');
      session.write(frame(selected));
      const second =
        change === 'duplicate'
          ? frame(selected)
          : {
              ...frame(selected, 1),
              ...(change === 'sample-jump' ? { sample_start: 14_000 } : {}),
              ...(change === 'sequence-jump' ? { sequence: 2 } : {}),
              ...(change === 'malformed' ? { data_base64: 'invalid' } : {}),
            };
      expect(() => session.write(second)).toThrow();
      await expect(session.completion).rejects.toMatchObject({
        code:
          change === 'malformed'
            ? 'invalid_live_frame'
            : 'live_frame_discontinuity',
      });
    },
  );
  it.each([
    ['crash', 'provider_unavailable'],
    ['diagnostics', 'live_provider_diagnostics'],
    ['invalid', 'live_worker_protocol'],
    ['error', 'provider_authentication_failed'],
    ['wrong-receipt', 'live_provider_closed'],
  ])(
    'redacts %s failure and refuses to manufacture a successful receipt',
    async (mode, code) => {
      const { session, selected, worker } = await open(mode);
      session.write(frame(selected));
      const completion = session.finish();
      await expect(completion).rejects.toMatchObject({ code });
      await expect(completion).rejects.not.toThrow(
        'sensitive-synthetic-provider-body',
      );
      expect(worker.threadId).toBe(-1);
    },
  );
  it('terminates a busy SDK worker on abort and fences every late result', async () => {
    const { session, selected, events, controller, worker } =
      await open('busy');
    session.write(frame(selected));
    controller.abort();
    await expect(session.completion).rejects.toMatchObject({
      code: 'live_cancelled',
    });
    expect(events).toEqual([]);
    expect(worker.threadId).toBe(-1);
  });
  it.each(['stalled', 'idle'])(
    'bounds %s input even when no additional frame arrives',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { session, selected } = await open('scripted');
      if (mode === 'stalled') session.write(frame(selected));
      await vi.advanceTimersByTimeAsync(5001);
      await expect(session.completion).rejects.toMatchObject({
        code: mode === 'stalled' ? 'live_provider_stalled' : 'live_input_idle',
      });
    },
  );
  it('bounds startup and drains a zero-audio finish without inventing recognized speech', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rejected = expect(open('never-start')).rejects.toMatchObject({
      code: 'live_start_timeout',
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    const live = await open();
    expect((await live.session.finish()).usage.audio_ms).toBe(0);
    expect(live.events).toEqual([]);
  });
  it('terminates a provider that never acknowledges the end of input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session, worker } = await open('never-finish');
    const completed = session.finish();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(completed).rejects.toMatchObject({
      code: 'live_finish_timeout',
    });
    expect(worker.threadId).toBe(-1);
  });
  it('explicitly discards a NoMatch hypothesis and fences late partials instead of leaving stale text visible', async () => {
    const { session, selected, events } = await open('scripted', {
      0: [
        { result_type: 'partial', duration_ticks: 500_000, text: 'Uncertain' },
      ],
      1: [{ result_type: 'no_match', duration_ticks: 1_000_000, text: '' }],
      2: [
        { result_type: 'partial', duration_ticks: 500_000, text: 'Stale' },
        {
          result_type: 'partial',
          offset_ticks: 1_000_000,
          duration_ticks: 500_000,
          text: 'Next',
        },
      ],
      3: [
        { result_type: 'no_match', duration_ticks: 1_000_000, text: '' },
        {
          offset_ticks: 1_000_000,
          duration_ticks: 1_000_000,
          text: 'Next item',
        },
      ],
    });
    for (let sequence = 0; sequence < 4; sequence++)
      session.write(frame(selected, sequence));
    await session.finish();
    expect(
      events.map((event) => [event.event_type, event.version, event.text]),
    ).toEqual([
      ['transcript.partial', 1, 'Uncertain'],
      ['transcript.discarded', 2, ''],
      ['transcript.partial', 1, 'Next'],
      ['transcript.final', 2, 'Next item'],
    ]);
    expect(events[1]).toMatchObject({
      segment_id: events[0]!.segment_id,
      discard_reason: 'no_match',
    });
    expect(events[2]!.segment_id).not.toBe(events[0]!.segment_id);
    expect(events[2]!.segment_id).toBe(events[3]!.segment_id);
  });
  it('fails closed if the result consumer throws, without emitting more content', async () => {
    const observer = vi.fn((): undefined => {
      throw new Error('private-consumer-error');
    });
    const { session, selected } = await open('normal', {}, observer);
    session.write(frame(selected));
    await expect(session.finish()).rejects.toMatchObject({
      code: 'live_consumer_failed',
    });
    expect(observer).toHaveBeenCalledOnce();
  });
  it('rejects an asynchronous JavaScript consumer without leaking its rejected promise or private error', async () => {
    const observer = async () => {
      throw new Error('private-async-consumer-error');
    };
    // @ts-expect-error Deliberately exercise a JavaScript caller bypassing the synchronous contract.
    const { session, selected } = await open('normal', {}, observer);
    session.write(frame(selected));
    await expect(session.finish()).rejects.toMatchObject({
      code: 'live_consumer_failed',
    });
  });
  it('redacts worker launch exceptions before a session or provider request is created', async () => {
    const provider = createAzureRealtimeProvider(config, () => {
      throw new Error('private-worker-launch-error');
    });
    const attempted = provider.open(
      source(),
      'en-US',
      new AbortController().signal,
      () => undefined,
    );
    await expect(attempted).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    await expect(attempted).rejects.not.toThrow('private-worker-launch-error');
  });
  it('does not launch any worker after an already cancelled request or invalid source', async () => {
    const launch = vi.fn((): Worker => {
      throw new Error('should-not-run');
    });
    const provider = createAzureRealtimeProvider(config, launch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.open(source(), 'en-US', controller.signal, () => undefined),
    ).rejects.toMatchObject({ code: 'live_cancelled' });
    await expect(
      provider.open(
        { ...source(), recording_id: 'invalid' },
        'en-US',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'invalid_live_source' });
    expect(launch).not.toHaveBeenCalled();
  });
});
