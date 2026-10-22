import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type { Writable } from 'node:stream';
import type { z } from 'zod';
import {
  providerContextSchema,
  providerEventSchema,
  type ProviderContext,
  type ProviderEvent,
} from '@windows-ai-notes/contracts/observability';
import { boundedTelemetry } from './telemetry.js';

const events = channel('windows-ai-notes.provider-calls');
const contexts = new AsyncLocalStorage<ProviderContext>();
const calls = new AsyncLocalStorage<ProviderCall>();
const system = providerContextSchema.parse({});
type Operation = ProviderEvent['operation'];

export function withProviderContext<T>(
  context: z.input<typeof providerContextSchema>,
  operation: () => T,
) {
  return contexts.run(providerContextSchema.parse(context), operation);
}

export function registerProviderTelemetry(output: Writable = process.stdout) {
  const telemetry = boundedTelemetry(output, 'provider');
  const listener = (message: unknown) => {
    const parsed = providerEventSchema.safeParse(message);
    if (!parsed.success) {
      console.error(
        JSON.stringify({ code: 'provider_telemetry_invalid_event' }),
      );
      return;
    }
    telemetry.emit(parsed.data);
  };
  events.subscribe(listener);
  return () => {
    events.unsubscribe(listener);
    telemetry.close();
  };
}

export class ProviderCall {
  readonly clientRequestId = randomUUID();
  private readonly context = { ...(contexts.getStore() ?? system) };
  private readonly started = performance.now();
  private dispatchedAt: number | null = null;
  private headersMs: number | null = null;
  private contentMs: number | null = null;
  private bodyMs: number | null = null;
  private status: number | null = null;
  private responseId: string | null = null;
  private responseIdStatus: 'missing' | 'accepted' | 'rejected' = 'missing';
  timedOut = false;

  constructor(private readonly operation: Operation) {}

  private base() {
    return {
      version: 1 as const,
      observed_at: new Date().toISOString(),
      ...this.context,
      client_request_id: this.clientRequestId,
      operation: this.operation,
    };
  }
  dispatch() {
    if (this.dispatchedAt !== null)
      throw new Error('A provider operation cannot dispatch twice.');
    this.dispatchedAt = performance.now();
    events.publish({
      ...this.base(),
      code: 'provider_request_started',
    } satisfies ProviderEvent);
  }
  private elapsed() {
    if (this.dispatchedAt === null)
      throw new Error('Provider timing has no dispatched request.');
    return Math.round(performance.now() - this.dispatchedAt);
  }
  headers(response: Response) {
    this.headersMs = this.elapsed();
    this.status = response.status || null;
    const raw =
      response.headers.get('apim-request-id') ??
      response.headers.get('x-request-id') ??
      response.headers.get('x-ms-request-id');
    if (raw !== null) {
      const normalized = /^[0-9a-f]{32}$/i.test(raw)
        ? raw
        : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              raw,
            )
          ? raw.replaceAll('-', '')
          : null;
      this.responseId = normalized?.toLowerCase() ?? null;
      this.responseIdStatus = normalized === null ? 'rejected' : 'accepted';
    }
  }
  firstContent() {
    this.contentMs ??= this.elapsed();
  }
  bodyComplete() {
    this.bodyMs = this.elapsed();
  }
  finish(outcome: 'returned' | 'failed' | 'cancelled' | 'timed_out') {
    events.publish({
      ...this.base(),
      code: 'provider_call_completed',
      dispatched: this.dispatchedAt !== null,
      outcome,
      duration_ms: Math.round(performance.now() - this.started),
      response_headers_ms: this.headersMs,
      first_content_ms: this.contentMs,
      response_body_ms: this.bodyMs,
      http_status: this.status,
      provider_response_id: this.responseId,
      provider_response_id_status: this.responseIdStatus,
    } satisfies ProviderEvent);
  }
}

export function currentProviderCall() {
  const call = calls.getStore();
  if (!call) throw new Error('The provider call context is missing.');
  return call;
}

export function observedProvider<Result>(
  operation: Operation,
  signal: AbortSignal,
  invoke: () => Promise<Result>,
) {
  const call = new ProviderCall(operation);
  return calls.run(call, async () => {
    let outcome: 'returned' | 'failed' | 'cancelled' | 'timed_out' = 'failed';
    try {
      const result = await invoke();
      outcome = 'returned';
      return result;
    } catch (error) {
      outcome = signal.aborted
        ? 'cancelled'
        : call.timedOut
          ? 'timed_out'
          : 'failed';
      throw error;
    } finally {
      call.finish(outcome);
    }
  });
}
