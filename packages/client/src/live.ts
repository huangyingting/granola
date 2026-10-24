import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import {
  liveClientMessageSchema,
  liveServerMessageSchema,
  SEGMENTED_LIVE_LIMITS,
  type LiveSpeechProfile,
  type LiveSource,
  type LiveServerMessage,
} from '@windows-ai-notes/contracts/realtime';
import { ClientError } from './errors.js';
import { cancellableWait } from './lifecycle.js';

type Ready = Extract<LiveServerMessage, { event_type: 'live.ready' }>;
type Accepted = Extract<LiveServerMessage, { event_type: 'live.accepted' }>;
type Closed = Extract<LiveServerMessage, { event_type: 'live.closed' }>;
type Start = Extract<
  ReturnType<typeof liveClientMessageSchema.parse>,
  { event_type: 'live.start' }
>;
export interface LiveConnectionOptions {
  source: LiveSource;
  locale: 'en-US' | 'zh-CN';
  consent: true;
  signal: AbortSignal;
  authorize: () => void;
  onEvent: (event: LiveServerMessage) => undefined;
}
export interface LiveConnection {
  readonly ready: Ready;
  readonly completion: Promise<Closed>;
  readonly closed: Promise<void>;
  readonly unfinalizedSamples: number;
  write(frames: readonly LivePcmFrame[]): Promise<Accepted>;
  finish(): Promise<Closed>;
  cancel(): Promise<void>;
}

// The legacy five-second budget reserves 2.5 seconds for native capture and
// one 0.5-second read in Main; the negotiated profile keeps that reservation.
export const LIVE_CLIENT_WINDOW_SAMPLES = 32_000;
const MAX_BYTES = 32_768;
const sameSource = (a: LiveSource, b: LiveSource) =>
  a.recording_id === b.recording_id &&
  a.preview_id === b.preview_id &&
  a.track_id === b.track_id &&
  a.capture_epoch === b.capture_epoch;
const failure = (code: string, message: string, retryable = false) =>
  new ClientError(code, message, 0, retryable);
const invalidResponse = () =>
  failure(
    'invalid_live_response',
    'The live service returned inconsistent data.',
  );
function checkAuthorization(options: LiveConnectionOptions) {
  const returned: unknown = options.authorize();
  if (returned !== undefined) {
    if (returned instanceof Promise) returned.catch(() => undefined);
    throw failure(
      'invalid_live_authorizer',
      'Live preview requires a synchronous account authorization guard.',
    );
  }
}

interface PendingWrite {
  text: string;
  samples: number;
  sequence: number;
  sample: number;
  clock: number;
  firstSample: number;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Accepted) => void;
  reject: (error: ClientError) => void;
}

class SocketLiveConnection implements LiveConnection {
  readonly completion: Promise<Closed>;
  readonly closed: Promise<void>;
  private resolveCompletion!: (value: Closed) => void;
  private rejectCompletion!: (error: ClientError) => void;
  private resolveClosed!: () => void;
  private resolveReady!: () => void;
  private rejectReady!: (error: ClientError) => void;
  private readonly initialized: Promise<void>;
  private readonly socket: WebSocket;
  private phase: 'starting' | 'streaming' | 'finishing' | 'closed' = 'starting';
  private readyValue: Ready | undefined;
  private pending: PendingWrite | undefined;
  private sentSamples = 0;
  private finalizedSamples = 0;
  private readonly wallEndsAt = performance.now() + 80_000;
  private baseSample: number | undefined;
  private nextSequence: number | undefined;
  private nextSample: number | undefined;
  private lastClock: number | undefined;
  private deadline: ReturnType<typeof setTimeout>;
  private lifetime: ReturnType<typeof setTimeout>;
  private termination: ReturnType<typeof setTimeout> | undefined;
  private readonly sendTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly aborted = () =>
    this.fail(failure('live_cancelled', 'Live preview was cancelled.'));

  constructor(
    destination: URL,
    headers: Record<string, string>,
    private readonly start: Start,
    private readonly options: LiveConnectionOptions,
  ) {
    this.initialized = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    // These remain rejecting public promises, including before open completes.
    this.initialized.catch(() => undefined);
    this.completion.catch(() => undefined);
    try {
      this.socket = new WebSocket(destination, {
        headers,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: MAX_BYTES,
        handshakeTimeout: 15_000,
        autoPong: false,
      });
    } catch {
      throw failure(
        'live_connection_failed',
        'The live connection could not be created.',
        true,
      );
    }
    this.deadline = setTimeout(
      () =>
        this.fail(
          failure('live_start_timeout', 'Live preview did not start.', true),
        ),
      15_000,
    );
    this.lifetime = setTimeout(
      () =>
        this.fail(
          failure(
            'live_time_limit',
            'This live preview reached its time limit.',
          ),
        ),
      80_000,
    );
    this.socket.on('open', () => {
      try {
        this.authorize();
        this.send(JSON.stringify(this.start));
      } catch (error) {
        this.fail(this.authorizationFailure(error));
      }
    });
    this.socket.on('message', (data, binary) => this.receive(data, binary));
    this.socket.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      request.destroy();
      this.fail(
        new ClientError(
          status >= 300 && status < 400
            ? 'service_redirect_rejected'
            : status === 401
              ? 'live_authentication_required'
              : status === 403
                ? 'live_access_denied'
                : status === 404
                  ? 'live_not_available'
                  : status === 429
                    ? 'live_rate_limited'
                    : 'live_handshake_failed',
          'The service did not authorize a live connection. No redirect was followed.',
          status,
          status === 429 || status >= 500,
        ),
      );
    });
    this.socket.on('error', () =>
      this.fail(
        failure(
          'live_connection_failed',
          'Live preview lost its connection. Check account usage before retrying.',
          true,
        ),
      ),
    );
    this.socket.on('ping', () => this.fail(invalidResponse()));
    this.socket.on('close', () => {
      if (this.phase !== 'closed')
        this.fail(
          failure(
            'live_connection_lost',
            'Live preview closed without confirmation. Check account usage before retrying.',
            true,
          ),
        );
      clearTimeout(this.termination);
      this.resolveClosed();
    });
    options.signal.addEventListener('abort', this.aborted, { once: true });
    if (options.signal.aborted) this.aborted();
  }
  async open(): Promise<LiveConnection> {
    await this.initialized;
    return this;
  }
  get ready(): Ready {
    if (!this.readyValue)
      throw failure('live_not_ready', 'Live preview has not started.');
    return structuredClone(this.readyValue);
  }
  get unfinalizedSamples() {
    return this.sentSamples - this.finalizedSamples;
  }
  private authorize() {
    try {
      if (this.options.signal.aborted)
        throw failure('live_cancelled', 'Live preview was cancelled.');
      if (performance.now() >= this.wallEndsAt)
        throw failure(
          'live_time_limit',
          'This live preview reached its time limit.',
        );
      checkAuthorization(this.options);
    } catch (error) {
      const safe = this.authorizationFailure(error);
      this.fail(safe);
      throw safe;
    }
  }
  private authorizationFailure(error: unknown): ClientError {
    return error instanceof ClientError
      ? error
      : failure(
          'live_authorization_lost',
          'The account or workspace can no longer use this live preview.',
        );
  }
  private send(text: string) {
    if (
      this.phase === 'closed' ||
      this.socket.readyState !== WebSocket.OPEN ||
      Buffer.byteLength(text) + this.socket.bufferedAmount > MAX_BYTES
    ) {
      this.fail(
        failure(
          'live_output_backpressure',
          'The live connection could not drain its bounded audio buffer.',
          true,
        ),
      );
      return;
    }
    const timer = setTimeout(
      () =>
        this.fail(
          failure(
            'live_send_timeout',
            'The live connection did not send its bounded message.',
            true,
          ),
        ),
      5000,
    );
    this.sendTimers.add(timer);
    try {
      this.socket.send(text, (error) => {
        clearTimeout(timer);
        this.sendTimers.delete(timer);
        if (error)
          this.fail(
            failure(
              'live_send_failed',
              'Live audio delivery could not be confirmed. Check account usage before retrying.',
              true,
            ),
          );
      });
    } catch {
      this.fail(
        failure(
          'live_send_failed',
          'Live audio delivery could not be confirmed. Check account usage before retrying.',
          true,
        ),
      );
    }
  }
  private publish(value: LiveServerMessage) {
    try {
      const returned: unknown = this.options.onEvent(value);
      if (returned !== undefined) {
        if (returned instanceof Promise) returned.catch(() => undefined);
        throw invalidResponse();
      }
    } catch {
      throw failure(
        'live_consumer_failed',
        'The live preview could not consume its bounded results.',
      );
    }
  }
  private receive(data: RawData, binary: boolean) {
    if (this.phase === 'closed') return;
    try {
      this.authorize();
      if (binary || !Buffer.isBuffer(data) || data.length > MAX_BYTES)
        throw invalidResponse();
      const parsed = liveServerMessageSchema.safeParse(
        JSON.parse(data.toString('utf8')) as unknown,
      );
      if (!parsed.success) throw invalidResponse();
      const value = parsed.data;
      if ('source' in value && !sameSource(value.source, this.start.source))
        throw invalidResponse();
      if (value.event_type === 'live.error') {
        this.publish(value);
        this.fail(
          new ClientError(value.code, value.message, 0, value.retryable),
        );
        return;
      }
      if (value.event_type === 'live.ready') {
        if (
          this.phase !== 'starting' ||
          ('profile' in value ? value.profile : undefined) !==
            this.start.profile
        )
          throw invalidResponse();
        this.readyValue = structuredClone(value);
        this.phase = 'streaming';
        clearTimeout(this.deadline);
        this.publish(value);
        this.resolveReady();
        return;
      }
      if (
        !this.readyValue ||
        ('provider_epoch' in value &&
          value.provider_epoch !== this.readyValue.provider_epoch)
      )
        throw invalidResponse();
      if (value.event_type === 'live.closed') {
        if (
          this.phase !== 'finishing' ||
          value.reason !== 'finished' ||
          this.pending
        )
          throw invalidResponse();
        this.publish(value);
        this.resolveCompletion(value);
        this.shutdown();
        return;
      }
      if (value.event_type === 'live.accepted') {
        const pending = this.pending;
        if (
          !pending?.sent ||
          value.next_sequence !== pending.sequence ||
          value.next_sample !== pending.sample ||
          value.accepted_samples !== this.sentSamples ||
          (value.gap !== null &&
            (this.sentSamples !== pending.samples ||
              value.gap.sample_end !== pending.firstSample))
        )
          throw invalidResponse();
        this.credit(value.finalized_samples);
        this.publish(value);
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve(value);
      } else if (value.event_type === 'live.progress') {
        this.credit(value.finalized_samples);
        this.publish(value);
        this.flush();
      } else {
        if (
          (value.event_type === 'transcript.discarded' &&
            value.discard_reason === 'empty_final' &&
            !this.start.profile) ||
          this.baseSample === undefined ||
          value.sample_start < this.baseSample ||
          value.sample_end > this.baseSample + this.sentSamples
        )
          throw invalidResponse();
        this.publish(value);
      }
    } catch (error) {
      this.fail(
        error instanceof ClientError
          ? error
          : error instanceof SyntaxError
            ? invalidResponse()
            : this.authorizationFailure(error),
      );
    }
  }
  private credit(samples: number) {
    if (samples > this.sentSamples) throw invalidResponse();
    this.finalizedSamples = Math.max(this.finalizedSamples, samples);
  }
  write(frames: readonly LivePcmFrame[]): Promise<Accepted> {
    try {
      this.authorize();
      if (this.phase !== 'streaming')
        throw failure(
          'invalid_live_state',
          'Live preview is not accepting audio.',
        );
      if (this.pending)
        throw failure(
          'live_input_busy',
          'Only one bounded live audio batch may be pending.',
        );
      const parsed = liveClientMessageSchema.safeParse({
        schema_version: 1,
        event_type: 'live.audio',
        frames,
      });
      if (!parsed.success || parsed.data.event_type !== 'live.audio')
        throw failure(
          'invalid_live_audio',
          'The native live audio batch is invalid.',
        );
      const batch = parsed.data.frames;
      const first = batch[0]!;
      const last = batch.at(-1)!;
      if (
        !sameSource(first, this.start.source) ||
        (this.nextSequence !== undefined &&
          (first.sequence !== this.nextSequence ||
            first.sample_start !== this.nextSample)) ||
        // Callback wall-clock ranges may overlap; source samples stay contiguous.
        (this.lastClock !== undefined && first.clock_end_ms < this.lastClock) ||
        batch.some(
          (frame, index) =>
            index > 0 && frame.clock_end_ms < batch[index - 1]!.clock_end_ms,
        )
      )
        throw failure(
          'live_discontinuity',
          'Live audio changed source, sequence, samples or native clock.',
        );
      if (this.sentSamples + batch.length * 800 > 960_000)
        throw failure(
          'live_media_limit',
          'This preview reached its sixty-second media limit.',
        );
      return new Promise((resolve, reject) => {
        this.pending = {
          text: JSON.stringify(parsed.data),
          samples: batch.length * 800,
          sequence: last.sequence + 1,
          sample: last.sample_start + 800,
          clock: last.clock_end_ms,
          firstSample: first.sample_start,
          sent: false,
          timer: setTimeout(
            () =>
              this.fail(
                failure(
                  'live_audio_stalled',
                  'Live preview exhausted its bounded recognition or delivery window.',
                  true,
                ),
              ),
            5000,
          ),
          resolve,
          reject,
        };
        this.flush();
      });
    } catch (error) {
      return Promise.reject(
        error instanceof ClientError ? error : this.authorizationFailure(error),
      );
    }
  }
  private flush() {
    const pending = this.pending;
    if (
      !pending ||
      pending.sent ||
      this.phase !== 'streaming' ||
      this.unfinalizedSamples + pending.samples >
        (this.start.profile
          ? SEGMENTED_LIVE_LIMITS.client_window_samples
          : LIVE_CLIENT_WINDOW_SAMPLES)
    )
      return;
    try {
      this.authorize();
      pending.sent = true;
      this.baseSample ??= pending.firstSample;
      this.sentSamples += pending.samples;
      this.nextSequence = pending.sequence;
      this.nextSample = pending.sample;
      this.lastClock = pending.clock;
      const text = pending.text;
      pending.text = '';
      this.send(text);
    } catch (error) {
      this.fail(this.authorizationFailure(error));
    }
  }
  finish(): Promise<Closed> {
    try {
      this.authorize();
      if (this.phase === 'finishing') return this.completion;
      if (this.phase !== 'streaming' || this.pending)
        throw failure(
          'invalid_live_state',
          'Drain the pending audio batch before finishing live preview.',
        );
      this.phase = 'finishing';
      this.deadline = setTimeout(
        () =>
          this.fail(
            failure(
              'live_finish_timeout',
              'Live preview did not confirm its final usage. Check account usage before retrying.',
              true,
            ),
          ),
        10_000,
      );
      this.send(
        JSON.stringify({ schema_version: 1, event_type: 'live.finish' }),
      );
      return this.completion;
    } catch (error) {
      return Promise.reject(this.authorizationFailure(error));
    }
  }
  cancel(): Promise<void> {
    if (this.phase !== 'closed') {
      if (this.socket.readyState === WebSocket.OPEN)
        this.send(
          JSON.stringify({ schema_version: 1, event_type: 'live.cancel' }),
        );
      this.aborted();
    }
    return this.closed;
  }
  private fail(error: ClientError) {
    if (this.phase === 'closed') return;
    this.rejectReady(error);
    this.rejectCompletion(error);
    this.pending?.reject(error);
    this.shutdown();
  }
  private shutdown() {
    this.phase = 'closed';
    clearTimeout(this.deadline);
    clearTimeout(this.lifetime);
    clearTimeout(this.pending?.timer);
    this.pending = undefined;
    for (const timer of this.sendTimers) clearTimeout(timer);
    this.sendTimers.clear();
    this.options.signal.removeEventListener('abort', this.aborted);
    this.termination = setTimeout(() => this.socket.terminate(), 1000);
    this.socket.close();
  }
}

export async function openLiveConnection(
  base: string,
  document: string,
  headers: () => Promise<Record<string, string>>,
  options: LiveConnectionOptions,
  negotiate?: (
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<LiveSpeechProfile | undefined>,
): Promise<LiveConnection> {
  const parsed = liveClientMessageSchema.safeParse({
    schema_version: 1,
    event_type: 'live.start',
    request_id: randomUUID(),
    source: options.source,
    locale: options.locale,
    consent: options.consent,
  });
  if (!parsed.success || parsed.data.event_type !== 'live.start')
    throw failure(
      'invalid_live_request',
      'Live preview requires a valid source, locale and separate consent.',
    );
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]);
  const cancelled = () =>
    failure('live_cancelled', 'Live preview was cancelled or timed out.');
  if (signal.aborted) throw cancelled();
  checkAuthorization(options);
  const credentials = await cancellableWait(headers, signal, cancelled);
  if (signal.aborted) throw cancelled();
  checkAuthorization(options);
  const profile = negotiate
    ? await cancellableWait(
        () => negotiate(credentials, signal),
        signal,
        cancelled,
      )
    : undefined;
  if (signal.aborted) throw cancelled();
  checkAuthorization(options);
  const start = liveClientMessageSchema.parse({
    ...parsed.data,
    ...(profile ? { profile } : {}),
  });
  if (start.event_type !== 'live.start') throw invalidResponse();
  const destination = new URL(`/v1/documents/${document}/live`, base);
  destination.protocol = destination.protocol === 'https:' ? 'wss:' : 'ws:';
  return await new SocketLiveConnection(
    destination,
    credentials,
    start,
    options,
  ).open();
}
