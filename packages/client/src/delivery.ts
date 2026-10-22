import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import {
  presentationSchema,
  type Presentation,
} from '@windows-ai-notes/contracts/presentation';
import { boundedTelemetry } from '@windows-ai-notes/contracts/telemetry';

type Context = {
  scope: number;
  document: string;
  kind: Presentation['kind'];
  operation_id: string | null;
  revision?: number;
  offset?: number;
};
export type DeliveryHandle = { readonly id: string };
type Capture =
  | { earliest: number; latest: number }
  | 'native_clock_unavailable'
  | 'audio_anchor_unavailable';
type Observation = Context &
  DeliveryHandle & {
    started: number;
    received?: number;
    origin?: 'event' | 'snapshot' | 'native' | 'network' | 'synchronization';
    capture?: Capture;
  };
type Outcome =
  | 'acknowledged'
  | 'superseded'
  | 'cancelled'
  | 'expired'
  | 'capacity'
  | 'closed';

export class DesktopDelivery {
  private readonly pending = new Map<string, Observation>();
  private readonly telemetry;
  private readonly timer;
  private closed = false;
  private ignored = 0n;
  constructor(
    output: Writable = process.stdout,
    private readonly now = () => performance.now(),
  ) {
    this.telemetry = boundedTelemetry(output, 'desktop_delivery');
    this.timer = setInterval(() => this.prune(), 15_000);
    this.timer.unref();
  }
  begin(context: Context, started = this.now()): DeliveryHandle {
    const handle = { id: randomUUID() };
    if (this.closed) return handle;
    if (
      !presentationSchema.shape.token.safeParse(context.document).success ||
      !presentationSchema.shape.operation_id.safeParse(context.operation_id)
        .success ||
      !presentationSchema.shape.kind.safeParse(context.kind).success ||
      !presentationSchema.shape.revision.safeParse(context.revision).success ||
      !presentationSchema.shape.offset.safeParse(context.offset).success ||
      !Number.isFinite(started) ||
      started > this.now() ||
      !Number.isSafeInteger(context.scope) ||
      context.scope < 1
    ) {
      this.telemetry.emit({
        code: 'desktop_delivery_invalid',
        finished_at: new Date().toISOString(),
      });
      return handle;
    }
    this.prune();
    if (this.pending.size >= 32)
      this.finish(this.pending.values().next().value!, 'capacity');
    const observation: Observation = { ...context, id: handle.id, started };
    if (!this.closed) this.pending.set(observation.id, observation);
    return { id: observation.id };
  }
  identify(handle: DeliveryHandle | undefined, operation: string) {
    const value = handle && this.pending.get(handle.id);
    if (
      value &&
      value.received === undefined &&
      presentationSchema.shape.operation_id.safeParse(operation).success
    )
      value.operation_id = operation;
  }
  private fields(value: Observation, at: number, presented: boolean) {
    const elapsed = (from: number) => Math.max(0, Math.round(at - from));
    return {
      observation_id: value.id,
      kind: value.kind,
      operation_id: value.operation_id,
      ...(value.revision === undefined ? {} : { revision: value.revision }),
      ...(value.offset === undefined ? {} : { offset: value.offset }),
      origin: value.origin ?? null,
      elapsed_after_start_ms: elapsed(value.started),
      received_after_start_ms:
        value.received === undefined
          ? null
          : Math.max(0, Math.round(value.received - value.started)),
      presentation_ack_after_receive_ms:
        !presented || value.received === undefined
          ? null
          : elapsed(value.received),
      capture_clock:
        typeof value.capture === 'object'
          ? 'native_interval'
          : (value.capture ?? null),
      capture_to_receive_lower_ms:
        typeof value.capture === 'object' && value.received !== undefined
          ? Math.round(value.received - value.capture.latest)
          : null,
      capture_to_receive_upper_ms:
        typeof value.capture === 'object' && value.received !== undefined
          ? Math.round(value.received - value.capture.earliest)
          : null,
      capture_to_ack_lower_ms:
        presented && typeof value.capture === 'object'
          ? elapsed(value.capture.latest)
          : null,
      capture_to_ack_upper_ms:
        presented && typeof value.capture === 'object'
          ? elapsed(value.capture.earliest)
          : null,
    };
  }
  private emit(value: Observation, code: string, outcome: string, at: number) {
    this.telemetry.emit({
      code,
      finished_at: new Date().toISOString(),
      outcome,
      ...this.fields(value, at, outcome === 'acknowledged'),
    });
  }
  offer(
    handle: DeliveryHandle | undefined,
    origin: NonNullable<Observation['origin']>,
    capture?: Capture,
  ): Presentation | undefined {
    if (!handle) return;
    this.prune();
    const value = this.pending.get(handle.id);
    if (!value) return;
    if (value.received === undefined) {
      value.received = this.now();
      value.origin = origin;
      if (capture !== undefined) value.capture = capture;
      this.emit(
        value,
        'desktop_delivery_received',
        'validated_in_main',
        value.received,
      );
    }
    return this.marker(handle);
  }
  marker(handle: DeliveryHandle | undefined): Presentation | undefined {
    if (!handle) return;
    this.prune();
    const value = this.pending.get(handle.id);
    return value?.received === undefined
      ? undefined
      : {
          token: value.id,
          kind: value.kind,
          operation_id: value.operation_id,
          ...(value.revision === undefined ? {} : { revision: value.revision }),
          ...(value.offset === undefined ? {} : { offset: value.offset }),
        };
  }
  markers(scope: number, document: string | null): Presentation[] {
    this.prune();
    return [...this.pending.values()]
      .filter(
        (value) =>
          value.scope === scope &&
          value.document === document &&
          value.received !== undefined,
      )
      .flatMap((value) => this.marker(value) ?? [])
      .slice(-8);
  }
  present(scope: number, document: string, token: string): boolean {
    this.prune();
    const value = this.pending.get(token);
    if (
      !value ||
      value.scope !== scope ||
      value.document !== document ||
      value.received === undefined
    ) {
      this.ignored++;
      return false;
    }
    this.finish(value, 'acknowledged');
    return true;
  }
  cancel(
    handle: DeliveryHandle | undefined,
    reason: 'superseded' | 'cancelled' = 'cancelled',
  ) {
    const value = handle && this.pending.get(handle.id);
    if (value) this.finish(value, reason);
  }
  cancelAll() {
    for (const value of this.pending.values()) this.finish(value, 'cancelled');
  }
  private finish(value: Observation, outcome: Outcome) {
    this.pending.delete(value.id);
    this.emit(value, 'desktop_delivery_finished', outcome, this.now());
  }
  private prune() {
    const now = this.now();
    for (const value of this.pending.values())
      if (
        now - value.started > 900_000 ||
        (value.received !== undefined && now - value.received > 30_000)
      )
        this.finish(value, 'expired');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const value of this.pending.values()) this.finish(value, 'closed');
    this.telemetry.emit({
      code: 'desktop_delivery_closed',
      finished_at: new Date().toISOString(),
      ignored_acknowledgments: this.ignored.toString(),
    });
    this.telemetry.close();
  }
}

export class CaptureDeliveryClock {
  private readonly anchors: {
    start: number;
    end: number;
    duration: number;
    earliest: number;
    latest: number;
  }[] = [];
  private supported = false;
  add(
    frames: readonly LivePcmFrame[],
    observed: number | undefined,
    sent: number,
    received: number,
  ) {
    if (observed === undefined) return;
    this.supported = true;
    for (const frame of frames) {
      const age = observed - frame.clock_end_ms;
      if (
        !Number.isFinite(age) ||
        age < 0 ||
        !Number.isFinite(sent) ||
        !Number.isFinite(received) ||
        received < sent
      )
        continue;
      this.anchors.push({
        start: frame.sample_start,
        end: frame.sample_start + frame.sample_count,
        duration: frame.clock_end_ms - frame.clock_start_ms,
        earliest: sent - age,
        latest: received - age,
      });
    }
    if (this.anchors.length > 128)
      this.anchors.splice(0, this.anchors.length - 128);
  }
  at(sampleEnd: number): Capture {
    const value = this.anchors.findLast(
      (anchor) => sampleEnd > anchor.start && sampleEnd <= anchor.end,
    );
    const remaining = value
      ? ((value.end - sampleEnd) / (value.end - value.start)) * value.duration
      : 0;
    return value
      ? {
          earliest: value.earliest - remaining,
          latest: value.latest - remaining,
        }
      : this.supported
        ? 'audio_anchor_unavailable'
        : 'native_clock_unavailable';
  }
}
