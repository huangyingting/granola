import websocket from '@fastify/websocket';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import { z } from 'zod';
import {
  liveClientMessageSchema,
  liveServerMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
  type LiveRecognitionEvent,
  type LiveSource,
} from '@windows-ai-notes/contracts/realtime';
import { ServiceError, resourceId } from '@windows-ai-notes/contracts/server';
import type {
  RealtimeProvider,
  RealtimeSession,
  RealtimeProgress,
} from '@windows-ai-notes/ai/realtime';
import {
  withAuditContext,
  type Database,
  type LiveClaim,
  type Transaction,
} from '@windows-ai-notes/db';
import { principal, type Principal } from './auth.js';
import { parse } from './parse.js';

const MAX_SOCKETS = 16;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_RESULTS = 8;
const LIVE_PATH = '/v1/documents/:id/live';
const paramsSchema = z.strictObject({ id: resourceId });
type Result = Extract<
  LiveServerMessage,
  { event_type: `transcript.${string}` | 'live.progress' }
>;
const error = (code: string, retryable = false) =>
  new ServiceError(
    code,
    'Live preview stopped. Saved local audio can still be processed into a final transcript.',
    409,
    retryable,
  );
const sameSource = (a: LiveSource, b: LiveSource) =>
  a.recording_id === b.recording_id &&
  a.preview_id === b.preview_id &&
  a.track_id === b.track_id &&
  a.capture_epoch === b.capture_epoch;
const report = (code: string, requestId: string) =>
  console.error(JSON.stringify({ code, request_id: requestId }));
function transaction<T>(
  db: Database,
  operation: (tx: Transaction) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout='1500ms'");
    await tx.query("SET LOCAL lock_timeout='1000ms'");
    return operation(tx);
  });
}

export async function prepareRealtimeRoutes(
  app: FastifyInstance,
  db: Database,
  provider: RealtimeProvider | null,
) {
  if (!provider) return () => undefined;
  const connections = new Set<LiveConnection>();
  await app.register(websocket, {
    options: { maxPayload: 32_768, perMessageDeflate: false, autoPong: false },
    errorHandler: (_error, socket, request) => {
      report('live_socket_failed', request.id);
      socket.terminate();
    },
    preClose: async () => {
      await Promise.all(
        [...connections].map((connection) => connection.stop('cancelled')),
      );
      for (const socket of app.websocketServer.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        app.websocketServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  });
  app.addHook('onRequest', async (request) => {
    if (request.ws && request.routeOptions.url !== LIVE_PATH)
      throw new ServiceError(
        'invalid_live_upgrade',
        'Only the live source endpoint accepts WebSocket upgrades.',
        400,
      );
  });
  return () =>
    app.get(
      LIVE_PATH,
      {
        websocket: true,
        preValidation: async (request) => {
          const { id } = parse(paramsSchema, request.params);
          parse(z.strictObject({}), request.query);
          if (
            !request.ws ||
            request.headers.origin !== undefined ||
            request.headers['sec-websocket-protocol'] !== undefined
          )
            throw new ServiceError(
              'invalid_live_upgrade',
              'Use a native-client WebSocket with header authentication and no query parameters, browser origin or subprotocol.',
              400,
            );
          const identity = principal(request);
          await transaction(db, (tx) =>
            db.lockDocument(principal(request).userId, id, tx),
          );
          if (identity.expiresAt <= Date.now())
            throw new ServiceError(
              'unauthorized',
              'The access token expired before the live upgrade completed.',
              401,
            );
        },
      },
      (socket, request) => {
        const identity = principal(request);
        const { id } = parse(paramsSchema, request.params);
        const available =
          connections.size < MAX_SOCKETS &&
          [...connections].filter(
            (connection) => connection.owner === identity.userId,
          ).length < 2;
        const connection = new LiveConnection(
          socket,
          db,
          provider,
          identity,
          id,
          request.id,
          () => connections.delete(connection),
        );
        connections.add(connection);
        if (!available) connection.fail(error('live_capacity', true));
      },
    );
}

class LiveConnection {
  readonly owner: string;
  private phase:
    | 'waiting'
    | 'starting'
    | 'streaming'
    | 'finishing'
    | 'settling'
    | 'terminal' = 'waiting';
  private readonly abort = new AbortController();
  private claim: LiveClaim | undefined;
  private reservation: string | undefined;
  private session: RealtimeSession | undefined;
  private input: Promise<void> | undefined;
  private publishing: Promise<void> | undefined;
  private checking: Promise<void> | undefined;
  private receipt: Promise<void> | undefined;
  private cleanup: Promise<void> | undefined;
  private readonly results: { value: Result; at: number; bytes: number }[] = [];
  private resultBytes = 0;
  private accepted = 0;
  private forwarded = 0;
  private base: number | undefined;
  private finalized = 0;
  private settled = false;
  private closeReason: 'cancelled' | 'failed' = 'cancelled';
  private heartbeat: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout;
  private readonly deadline: NodeJS.Timeout;
  private readonly deadlineAt: number;
  private closing: NodeJS.Timeout | undefined;
  private readonly sends = new Set<NodeJS.Timeout>();

  constructor(
    private readonly socket: WebSocket,
    private readonly db: Database,
    private readonly provider: RealtimeProvider,
    identity: Principal,
    private readonly document: string,
    private readonly requestId: string,
    private readonly release: () => void,
  ) {
    this.owner = identity.userId;
    this.accessExpiresAt = identity.expiresAt;
    this.deadlineAt =
      performance.now() + Math.min(80_000, identity.expiresAt - Date.now());
    this.idle = setTimeout(() => this.fail(error('live_start_timeout')), 5000);
    this.deadline = setTimeout(
      () => this.fail(error('live_session_expired')),
      Math.max(1, Math.min(80_000, identity.expiresAt - Date.now())),
    );
    socket.on('message', (data, binary) => this.message(data, binary));
    socket.on('error', () => this.fail(error('live_socket_failed', true)));
    socket.once('close', () => {
      if (this.closing) clearTimeout(this.closing);
      void this.stop('cancelled');
    });
  }
  private readonly accessExpiresAt: number;

  private transaction<T>(operation: (tx: Transaction) => Promise<T>) {
    return this.attributed(() => transaction(this.db, operation));
  }
  private attributed<T>(operation: () => T) {
    return withAuditContext(
      {
        source: 'api',
        actor_id: this.owner,
        request_id: this.requestId,
      },
      operation,
    );
  }
  private authorize() {
    if (!this.claim) throw error('live_lease_lost');
    return this.transaction((tx) => this.db.live.authorize(this.claim!, tx));
  }
  private isTerminal() {
    return this.phase === 'terminal';
  }
  private armIdle(ms: number, code: string) {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fail(error(code)), ms);
  }
  private renew() {
    if (this.isTerminal()) return;
    this.checking = this.authorize()
      .then(() => undefined)
      .catch((err) => this.fail(err))
      .finally(() => {
        this.checking = undefined;
        if (!this.isTerminal() && this.phase !== 'settling')
          this.heartbeat = setTimeout(() => this.renew(), 1000);
      });
  }
  private message(data: RawData, binary: boolean) {
    if (this.isTerminal()) return;
    let message: LiveClientMessage;
    try {
      if (binary) throw error('invalid_live_message');
      const value: unknown = JSON.parse(data.toString());
      const parsed = liveClientMessageSchema.safeParse(value);
      if (!parsed.success) throw error('invalid_live_message');
      message = parsed.data;
    } catch {
      this.fail(error('invalid_live_message'));
      return;
    }
    if (message.event_type === 'live.cancel') {
      void this.stop('cancelled');
      return;
    }
    if (this.input) {
      this.fail(error('live_input_backpressure'));
      return;
    }
    this.input = this.process(message)
      .catch((err) => this.fail(err))
      .finally(() => {
        this.input = undefined;
      });
  }
  private async process(
    message: Exclude<LiveClientMessage, { event_type: 'live.cancel' }>,
  ) {
    if (message.event_type === 'live.start') {
      if (this.phase !== 'waiting') throw error('invalid_live_state');
      this.phase = 'starting';
      this.armIdle(15_000, 'live_start_timeout');
      const reserved = await this.transaction(async (tx) => {
        if (this.isTerminal()) throw error('live_cancelled');
        const claim = await this.db.live.open(
          this.owner,
          this.document,
          {
            source: message.source,
            locale: message.locale,
            consent: message.consent,
            provider: this.provider.provider,
            configurationVersion: this.provider.configurationVersion,
          },
          message.request_id,
          this.accessExpiresAt,
          tx,
        );
        const configuration = await this.db.live.authorize(claim, tx);
        if (
          configuration.provider !== this.provider.provider ||
          configuration.configuration_version !==
            this.provider.configurationVersion
        )
          throw error('live_configuration_changed');
        const call = await this.db.usage.startLive(claim, tx);
        if (this.isTerminal()) throw error('live_cancelled');
        return { claim, call };
      });
      this.claim = reserved.claim;
      this.reservation = reserved.call;
      if (this.isTerminal()) return;
      this.renew();
      const session = await this.provider.open(
        this.claim.source,
        message.locale,
        this.abort.signal,
        (event) => {
          this.recognition(event);
          return undefined;
        },
        (progress) => {
          this.progress(progress);
          return undefined;
        },
      );
      this.session = session;
      this.receipt = this.observeReceipt(session);
      if (this.isTerminal()) return;
      await this.authorize();
      if (this.isTerminal()) return;
      this.phase = 'streaming';
      this.armIdle(5000, 'live_input_idle');
      this.send({
        schema_version: 1,
        event_type: 'live.ready',
        source: this.claim.source,
        provider_epoch: session.providerEpoch,
        canonical: false,
        continuity: 'unverified',
        max_media_ms: 60_000,
        max_unfinalized_ms: 5000,
      });
      return;
    }
    if (this.phase !== 'streaming' || !this.claim || !this.session)
      throw error('invalid_live_state');
    if (message.event_type === 'live.finish') {
      await this.authorize();
      if (this.isTerminal()) return;
      this.phase = 'finishing';
      this.armIdle(10_000, 'live_finish_timeout');
      void this.session.finish().catch((err) => this.fail(err));
      return;
    }
    const first = message.frames[0]!;
    if (!sameSource(first, this.claim.source))
      throw error('live_source_mismatch');
    const accepted = await this.transaction((tx) =>
      this.db.live.accept(
        this.claim!,
        {
          sequence: first.sequence,
          sample_start: first.sample_start,
          frame_count: message.frames.length,
        },
        tx,
      ),
    );
    this.accepted = accepted.accepted_samples;
    if (this.isTerminal()) return;
    this.base ??= first.sample_start;
    for (const frame of message.frames) {
      this.checkDeadline();
      this.forwarded += 800;
      this.session.write(frame);
    }
    if (this.isTerminal()) return;
    this.armIdle(5000, 'live_input_idle');
    this.send({
      schema_version: 1,
      event_type: 'live.accepted',
      source: this.claim.source,
      provider_epoch: this.session.providerEpoch,
      acknowledgment: 'authorization_only',
      next_sequence: first.sequence + message.frames.length,
      next_sample: first.sample_start + message.frames.length * 800,
      accepted_samples: this.accepted,
      finalized_samples: this.session.finalizedSamples,
      gap: accepted.gap,
    });
  }
  private recognition(value: LiveRecognitionEvent) {
    this.enqueue(value);
  }
  private progress(value: RealtimeProgress) {
    if (!this.claim) return this.fail(error('live_invalid_result'));
    this.enqueue({
      schema_version: 1,
      event_type: 'live.progress',
      source: this.claim.source,
      provider_epoch: value.provider_epoch,
      finalized_samples: value.finalized_samples,
      acknowledgment: 'provider_finalization_only',
    });
  }
  private enqueue(value: Result) {
    if (this.isTerminal()) return;
    const parsed = liveServerMessageSchema.safeParse(value);
    if (
      !parsed.success ||
      !this.session ||
      !this.claim ||
      this.phase === 'settling' ||
      !sameSource(value.source, this.claim.source) ||
      value.provider_epoch !== this.session.providerEpoch
    )
      return this.fail(error('live_invalid_result'));
    if (value.event_type === 'live.progress') {
      if (
        value.finalized_samples > this.forwarded ||
        value.finalized_samples < this.finalized
      )
        return this.fail(error('live_invalid_result'));
      this.finalized = value.finalized_samples;
    } else if (
      this.base === undefined ||
      value.sample_start < this.base ||
      value.sample_end > this.base + this.forwarded
    ) {
      return this.fail(error('live_invalid_result'));
    }
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.results.length >= MAX_RESULTS || this.resultBytes + bytes > 32_768)
      return this.fail(error('live_result_backpressure'));
    this.results.push({ value, at: performance.now(), bytes });
    this.resultBytes += bytes;
    this.startPublishing();
  }
  private startPublishing() {
    if (this.publishing || this.isTerminal() || !this.results.length) return;
    this.publishing = this.publish()
      .catch((err) => this.fail(err))
      .finally(() => {
        this.publishing = undefined;
        this.startPublishing();
      });
  }
  private async publish() {
    while (this.results.length && !this.isTerminal()) {
      const next = this.results[0]!;
      await this.authorize();
      if (this.isTerminal()) return;
      if (performance.now() - next.at > 5000)
        throw error('live_result_stalled');
      this.send(next.value);
      if (this.isTerminal()) return;
      this.results.shift();
      this.resultBytes -= next.bytes;
    }
  }
  private async observeReceipt(session: RealtimeSession) {
    let known = false;
    try {
      const receipt = await session.completion;
      known = true;
      const finishing = this.phase === 'finishing';
      if (
        receipt.provider_epoch !== session.providerEpoch ||
        !Number.isSafeInteger(receipt.samples) ||
        receipt.samples < 0 ||
        receipt.samples !== this.forwarded ||
        receipt.usage.input_tokens !== 0 ||
        receipt.usage.output_tokens !== 0 ||
        receipt.usage.audio_ms !== receipt.samples / 16 ||
        receipt.samples > this.accepted
      )
        throw error('live_invalid_receipt');
      while (this.publishing && !this.isTerminal()) await this.publishing;
      if (!this.isTerminal()) this.phase = 'settling';
      if (this.heartbeat) clearTimeout(this.heartbeat);
      if (this.checking) await this.checking;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.transaction((tx) =>
            this.db.usage.settle(this.reservation!, receipt.usage, tx),
          );
          break;
        } catch (err) {
          if (attempt >= 2 || err instanceof ServiceError) throw err;
          await delay(100 * (attempt + 1));
        }
      }
      this.settled = true;
      if (this.isTerminal()) return;
      if (!finishing) throw error('live_provider_closed');
      if (!this.isTerminal()) void this.stop('finished');
    } catch (err) {
      if (known && !this.settled)
        report(
          err instanceof ServiceError && err.code === 'live_invalid_receipt'
            ? 'live_invalid_receipt'
            : 'live_usage_settlement_failed',
          this.requestId,
        );
      if (!this.isTerminal()) this.fail(err);
    }
  }
  private send(value: LiveServerMessage) {
    if (this.isTerminal()) return;
    this.checkDeadline();
    const encoded = JSON.stringify(liveServerMessageSchema.parse(value));
    if (
      this.socket.readyState !== 1 ||
      this.sends.size >= 16 ||
      this.socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES
    )
      return this.fail(error('live_output_backpressure'));
    const timer = setTimeout(
      () => this.fail(error('live_output_stalled')),
      5000,
    );
    this.sends.add(timer);
    try {
      this.socket.send(encoded, (err) => {
        clearTimeout(timer);
        this.sends.delete(timer);
        if (err) this.fail(error('live_socket_failed', true));
      });
    } catch {
      clearTimeout(timer);
      this.sends.delete(timer);
      this.fail(error('live_socket_failed', true));
    }
  }
  private checkDeadline() {
    if (
      Date.now() >= this.accessExpiresAt ||
      performance.now() >= this.deadlineAt
    )
      throw error('live_session_expired');
  }
  fail(value: unknown) {
    if (this.isTerminal()) return;
    if (!(value instanceof ServiceError))
      report('live_gateway_failed', this.requestId);
    const safe =
      value instanceof ServiceError && /^[a-z][a-z0-9_]{0,79}$/.test(value.code)
        ? value
        : error('live_unavailable', true);
    void this.stop('cancelled', safe);
  }
  stop(
    reason: 'finished' | 'cancelled',
    failure?: ServiceError,
  ): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.phase = 'terminal';
    this.closeReason = failure ? 'failed' : 'cancelled';
    clearTimeout(this.deadline);
    clearTimeout(this.idle);
    if (this.heartbeat) clearTimeout(this.heartbeat);
    for (const timer of this.sends) clearTimeout(timer);
    this.sends.clear();
    this.results.length = 0;
    this.resultBytes = 0;
    this.abort.abort();
    const terminal: LiveServerMessage = failure
      ? {
          schema_version: 1,
          event_type: 'live.error',
          code: failure.code,
          message: error(failure.code).message,
          retryable: failure.retryable,
          request_id: this.requestId,
          canonical: false,
          continuity: 'unverified',
          usage_status: 'check_account',
        }
      : {
          schema_version: 1,
          event_type: 'live.closed',
          reason,
          canonical: false,
          continuity: 'unverified',
          usage_status: this.settled ? 'settled' : 'check_account',
        };
    this.closeSocket(
      terminal,
      failure ? (failure.status >= 500 ? 1011 : 1008) : 1000,
    );
    this.cleanup = this.dispose().finally(this.release);
    return this.cleanup;
  }
  private closeSocket(value: LiveServerMessage, code: number) {
    if (this.socket.readyState !== 1) {
      this.socket.terminate();
      return;
    }
    const encoded = JSON.stringify(value);
    this.closing = setTimeout(() => this.socket.terminate(), 1000);
    if (
      this.socket.bufferedAmount + Buffer.byteLength(encoded) >
      MAX_OUTPUT_BYTES
    ) {
      this.socket.terminate();
      return;
    }
    try {
      this.socket.send(encoded, (err) => {
        if (err) this.socket.terminate();
        else this.socket.close(code);
      });
    } catch {
      report('live_socket_close_failed', this.requestId);
      this.socket.terminate();
    }
  }
  private async dispose() {
    await Promise.all([this.input, this.publishing, this.checking]);
    if (this.session) {
      try {
        await this.session.cancel();
      } catch {
        report('live_provider_cleanup_failed', this.requestId);
      }
    }
    if (this.receipt) await this.receipt;
    if (this.claim && this.reservation) {
      try {
        await this.attributed(() =>
          this.db.live.close(this.claim!, this.closeReason),
        );
      } catch {
        report('live_lease_cleanup_failed', this.requestId);
      }
    }
  }
}
