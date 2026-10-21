import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  livePcmFrameSchema,
  type LivePcmFrame,
} from '@windows-ai-notes/contracts';
import {
  liveSourceSchema,
  liveRecognitionEventSchema,
  type LiveSource,
  type LiveRecognitionEvent,
} from '@windows-ai-notes/contracts/realtime';
import { ServiceError, type Usage } from '@windows-ai-notes/contracts/server';
import { z } from 'zod';
import type { AzureConfig } from './config.js';
import {
  LIVE_START_MS,
  LIVE_STALL_MS,
  MAX_PENDING_SAMPLES,
  MAX_SESSION_SAMPLES,
  speechWorkerEventSchema,
  type SpeechWorkerResult,
} from './realtime-protocol.js';

export interface RealtimeCompletion {
  provider_epoch: string;
  samples: number;
  usage: Usage;
}
export interface RealtimeSession {
  readonly providerEpoch: string;
  readonly completion: Promise<RealtimeCompletion>;
  write(frame: LivePcmFrame): void;
  finish(): Promise<RealtimeCompletion>;
  cancel(): Promise<void>;
}
export type SpeechWorkerFactory = (locale: 'en-US' | 'zh-CN') => Worker;
export const AZURE_REALTIME_CAPABILITIES = Object.freeze({
  languages: ['en-US', 'zh-CN'] as const,
  sample_rate: 16_000,
  channels: 1,
  bits_per_sample: 16,
  max_unfinalized_ms: 5000,
  max_session_ms: 600_000,
  automatic_reconnect: false,
  speaker_identity: false,
});
export function createAzureRealtimeProvider(
  config: AzureConfig,
  launch: SpeechWorkerFactory = (locale) =>
    new Worker(new URL('./realtime-worker.js', import.meta.url), {
      workerData: {
        key: config.AZURE_SPEECH_KEY,
        region: config.AZURE_SPEECH_REGION,
        locale,
      },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
      },
    }),
) {
  return {
    provider: 'azure' as const,
    configurationVersion: createHash('sha256')
      .update(
        JSON.stringify([
          config.AZURE_SPEECH_REGION,
          'speech-sdk-1.52.0',
          'bounded-live-v1',
        ]),
      )
      .digest('hex')
      .slice(0, 16),
    capabilities: AZURE_REALTIME_CAPABILITIES,
    async open(
      source: LiveSource,
      locale: 'en-US' | 'zh-CN',
      signal: AbortSignal,
      emit: (event: LiveRecognitionEvent) => undefined,
    ): Promise<RealtimeSession> {
      const selected = liveSourceSchema.safeParse(source);
      if (
        !selected.success ||
        !z.enum(['en-US', 'zh-CN']).safeParse(locale).success
      )
        throw new ServiceError(
          'invalid_live_source',
          'Select a valid live source and supported language.',
          400,
        );
      if (signal.aborted)
        throw new ServiceError(
          'live_cancelled',
          'Live recognition was cancelled.',
          409,
        );
      let worker: Worker;
      try {
        worker = launch(locale);
      } catch {
        throw new ServiceError(
          'provider_unavailable',
          'The isolated speech worker could not start.',
          503,
          true,
        );
      }
      const session = new SpeechSession(selected.data, signal, emit, worker);
      try {
        await session.ready;
      } catch (error) {
        await session.cancel();
        throw error;
      }
      return session;
    },
  };
}

class SpeechSession implements RealtimeSession {
  readonly providerEpoch = randomUUID();
  readonly completion: Promise<RealtimeCompletion>;
  readonly ready: Promise<void>;
  private resolve!: (value: RealtimeCompletion) => void;
  private reject!: (error: Error) => void;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private terminal = false;
  private started = false;
  private finishing = false;
  private error: ServiceError | undefined;
  private closing: Promise<void> | undefined;
  private samples = 0;
  private credited = 0;
  private base: number | undefined;
  private nextSequence: number | undefined;
  private resultSequence = 0;
  private readonly pending: { end: number; at: number }[] = [];
  private readonly finals = new Map<
    number,
    { id: string; version: number; hash: string }
  >();
  private partial:
    { id: string; version: number; offset: number; end: number } | undefined;
  private closedTicks = 0;
  private startTimer: NodeJS.Timeout;
  private stallTimer: NodeJS.Timeout | undefined;
  private finishTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly lifetime: NodeJS.Timeout;
  private readonly abort = () => this.fail('live_cancelled');

  constructor(
    private readonly source: LiveSource,
    private readonly signal: AbortSignal,
    private readonly emit: (event: LiveRecognitionEvent) => undefined,
    private readonly worker: Worker,
  ) {
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.completion.catch(() => undefined);
    this.ready.catch(() => undefined);
    this.startTimer = setTimeout(
      () => this.fail('live_start_timeout'),
      LIVE_START_MS,
    );
    this.lifetime = setTimeout(
      () => this.fail('live_session_expired'),
      600_000,
    );
    worker.on('message', (value) => this.message(value));
    worker.on('error', () => this.fail('provider_unavailable'));
    worker.on('exit', () => {
      if (!this.terminal) this.fail('live_provider_closed');
    });
    for (const stream of [worker.stdout, worker.stderr])
      stream?.on('data', () => this.fail('live_provider_diagnostics'));
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  private close(): Promise<void> {
    if (!this.closing) {
      clearTimeout(this.startTimer);
      clearTimeout(this.lifetime);
      if (this.stallTimer) clearTimeout(this.stallTimer);
      if (this.finishTimer) clearTimeout(this.finishTimer);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.signal.removeEventListener('abort', this.abort);
      this.pending.length = 0;
      this.finals.clear();
      this.partial = undefined;
      this.closing = this.worker.terminate().then(() => undefined);
    }
    return this.closing;
  }
  private fail(code: string): ServiceError {
    if (this.error) return this.error;
    this.error = new ServiceError(
      code,
      code === 'live_cancelled'
        ? 'Live recognition was cancelled.'
        : 'Live recognition stopped. Preserved local audio can still be processed into a final transcript.',
      code === 'live_cancelled' ? 409 : 503,
      code === 'provider_unavailable' || code === 'live_provider_closed',
    );
    if (this.terminal) return this.error;
    this.terminal = true;
    this.readyReject(this.error);
    void this.close().then(
      () => this.reject(this.error!),
      () =>
        this.reject(
          new ServiceError(
            'live_cleanup_failed',
            'The isolated speech worker did not close cleanly.',
            503,
          ),
        ),
    );
    return this.error;
  }
  private armStall() {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const oldest = this.pending[0];
    if (oldest)
      this.stallTimer = setTimeout(
        () => this.fail('live_provider_stalled'),
        Math.max(1, LIVE_STALL_MS - (performance.now() - oldest.at)),
      );
  }
  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.fail('live_input_idle'),
      LIVE_STALL_MS,
    );
  }
  write(value: LivePcmFrame) {
    if (this.error) throw this.error;
    if (this.terminal || !this.started || this.finishing)
      throw new ServiceError(
        'live_closed',
        'This live recognition session is not accepting audio.',
        409,
      );
    const parsed = livePcmFrameSchema.safeParse(value);
    if (!parsed.success) throw this.fail('invalid_live_frame');
    const frame = parsed.data;
    if (
      frame.recording_id !== this.source.recording_id ||
      frame.preview_id !== this.source.preview_id ||
      frame.track_id !== this.source.track_id ||
      frame.capture_epoch !== this.source.capture_epoch
    )
      throw this.fail('live_source_mismatch');
    if (
      (this.base !== undefined &&
        frame.sample_start !== this.base + this.samples) ||
      (this.nextSequence !== undefined && frame.sequence !== this.nextSequence)
    )
      throw this.fail('live_frame_discontinuity');
    if (this.samples + 800 > MAX_SESSION_SAMPLES)
      throw this.fail('live_session_expired');
    if (this.samples + 800 - this.credited > MAX_PENDING_SAMPLES)
      throw this.fail('live_audio_overrun');
    const pcm = Uint8Array.from(
      Buffer.from(frame.data_base64, 'base64'),
    ).buffer;
    this.base ??= frame.sample_start;
    this.nextSequence = frame.sequence + 1;
    const sequence = this.samples / 800;
    this.samples += 800;
    this.pending.push({ end: this.samples, at: performance.now() });
    try {
      this.worker.postMessage({ kind: 'audio', sequence, pcm }, [pcm]);
    } catch {
      throw this.fail('provider_unavailable');
    }
    this.armStall();
    this.armIdle();
  }
  finish() {
    if (!this.terminal && !this.finishing) {
      this.finishing = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.finishTimer = setTimeout(
        () => this.fail('live_finish_timeout'),
        LIVE_START_MS,
      );
      try {
        this.worker.postMessage({ kind: 'end' });
      } catch {
        this.fail('provider_unavailable');
      }
    }
    return this.completion;
  }
  async cancel() {
    if (!this.terminal) this.fail('live_cancelled');
    await this.close();
  }
  private message(value: unknown) {
    if (this.terminal) return;
    const parsed = speechWorkerEventSchema.safeParse(value);
    if (!parsed.success) {
      this.fail('live_worker_protocol');
      return;
    }
    const event = parsed.data;
    if (event.kind === 'ready') {
      if (this.started) {
        this.fail('live_worker_protocol');
        return;
      }
      this.started = true;
      clearTimeout(this.startTimer);
      this.armIdle();
      this.readyResolve();
    } else if (event.kind === 'error') this.fail(event.code);
    else if (event.kind === 'stopped') {
      if (!this.finishing || event.samples !== this.samples) {
        this.fail('live_provider_closed');
        return;
      }
      this.terminal = true;
      void this.close().then(
        () =>
          this.resolve({
            provider_epoch: this.providerEpoch,
            samples: this.samples,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              audio_ms: this.samples / 16,
            },
          }),
        () =>
          this.reject(
            new ServiceError(
              'live_cleanup_failed',
              'The isolated speech worker did not close cleanly.',
              503,
            ),
          ),
      );
    } else {
      if (!this.started || event.sequence !== this.resultSequence + 1) {
        this.fail('live_worker_protocol');
        return;
      }
      this.resultSequence = event.sequence;
      try {
        this.result(event);
        if (!this.terminal)
          this.worker.postMessage({ kind: 'ack', sequence: event.sequence });
      } catch {
        this.fail('live_consumer_failed');
      }
    }
  }
  private result(result: SpeechWorkerResult) {
    const endTicks = result.offset_ticks + result.duration_ticks;
    if (
      this.base === undefined &&
      this.samples === 0 &&
      result.result_type === 'no_match' &&
      endTicks === 0
    )
      return;
    if (endTicks > this.samples * 625 || this.base === undefined) {
      this.fail('live_invalid_result');
      return;
    }
    if (result.result_type !== 'partial') {
      this.closedTicks = Math.max(this.closedTicks, endTicks);
      this.credited = Math.max(
        this.credited,
        Math.floor(endTicks / 1_000_000) * 1600,
      );
      while (this.pending[0] && this.pending[0].end <= this.credited)
        this.pending.shift();
      this.armStall();
    }
    const partial =
      this.partial &&
      (this.partial.offset === result.offset_ticks ||
        Math.max(this.partial.offset, result.offset_ticks) <
          Math.min(this.partial.end, endTicks))
        ? this.partial
        : undefined;
    if (result.result_type === 'no_match') {
      if (partial) {
        this.publish(
          result,
          'transcript.discarded',
          partial.id,
          partial.version + 1,
          '',
        );
        this.partial = undefined;
      }
      return;
    }
    if (result.result_type === 'partial' && endTicks <= this.closedTicks)
      return;
    const text = result.text.trim();
    if (!text) {
      if (result.result_type === 'final') this.fail('live_invalid_result');
      return;
    }
    const previous = this.finals.get(result.offset_ticks);
    const hash = createHash('sha256')
      .update(JSON.stringify([text, endTicks]))
      .digest('hex');
    if (
      previous &&
      (result.result_type === 'partial' || previous.hash === hash)
    )
      return;
    const segment = previous ??
      (result.result_type === 'partial' ? this.partial : partial) ?? {
        id: randomUUID(),
        version: 0,
      };
    const version = segment.version + 1;
    if (version > 1_000_000) {
      this.fail('live_event_overrun');
      return;
    }
    if (result.result_type === 'final') {
      if (!previous && this.finals.size >= 6000) {
        this.fail('live_event_overrun');
        return;
      }
      this.finals.set(result.offset_ticks, { id: segment.id, version, hash });
      if (!previous && partial) this.partial = undefined;
    } else
      this.partial = {
        id: segment.id,
        version,
        offset: result.offset_ticks,
        end: endTicks,
      };
    this.publish(
      result,
      result.result_type === 'partial'
        ? 'transcript.partial'
        : 'transcript.final',
      segment.id,
      version,
      text,
    );
  }
  private publish(
    result: SpeechWorkerResult,
    type: LiveRecognitionEvent['event_type'],
    id: string,
    version: number,
    text: string,
  ) {
    const base = this.base;
    if (base === undefined) {
      this.fail('live_invalid_result');
      return;
    }
    const endTicks = result.offset_ticks + result.duration_ticks;
    const event = liveRecognitionEventSchema.parse({
      schema_version: 1,
      provider_epoch: this.providerEpoch,
      source: this.source,
      event_type: type,
      segment_id: id,
      version,
      sample_start: base + Math.floor(result.offset_ticks / 625),
      sample_end: base + Math.ceil(endTicks / 625),
      text,
      discard_reason: type === 'transcript.discarded' ? 'no_match' : null,
      provider_result_id: result.result_id,
    });
    const returned: unknown = this.emit(event);
    if (returned !== undefined) {
      this.fail('live_consumer_failed');
      void Promise.resolve(returned).catch(() => undefined);
    }
  }
}
