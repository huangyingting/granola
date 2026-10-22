import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LivePcmFrame } from '@windows-ai-notes/contracts';
import { presentationSchema } from '@windows-ai-notes/contracts/presentation';
import { DesktopDelivery, CaptureDeliveryClock } from './delivery.js';

const owners: DesktopDelivery[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  vi.restoreAllMocks();
});
function fixture() {
  let time = 100;
  const records: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      records.push(JSON.parse(String(chunk)));
      done();
    },
  });
  const metrics = new DesktopDelivery(sink, () => time);
  owners.push(metrics);
  const context = {
    scope: 1,
    document: randomUUID(),
    kind: 'summary_preview' as const,
    operation_id: randomUUID(),
  };
  return {
    metrics,
    context,
    records,
    set: (value: number) => {
      time = value;
    },
  };
}
describe('bounded, private desktop delivery observations', () => {
  it('measures validated receipt and one scoped presentation without exposing lookup identity', () => {
    const f = fixture(),
      handle = f.metrics.begin(f.context);
    expect(f.metrics.present(1, f.context.document, handle.id)).toBe(false);
    f.set(140);
    const marker = f.metrics.offer(handle, 'event');
    expect(presentationSchema.parse(marker)).toEqual({
      token: handle.id,
      kind: 'summary_preview',
      operation_id: f.context.operation_id,
    });
    f.set(175);
    expect(f.metrics.present(2, f.context.document, handle.id)).toBe(false);
    expect(f.metrics.present(1, randomUUID(), handle.id)).toBe(false);
    expect(f.metrics.present(1, f.context.document, randomUUID())).toBe(false);
    expect(f.metrics.offer(handle, 'snapshot')).toEqual(marker);
    expect(f.metrics.present(1, f.context.document, handle.id)).toBe(true);
    expect(f.metrics.present(1, f.context.document, handle.id)).toBe(false);
    expect(f.records).toHaveLength(2);
    expect(f.records[1]).toMatchObject({
      outcome: 'acknowledged',
      elapsed_after_start_ms: 75,
      received_after_start_ms: 40,
      presentation_ack_after_receive_ms: 35,
      capture_clock: null,
      capture_to_ack_lower_ms: null,
      capture_to_receive_lower_ms: null,
    });
    expect(JSON.stringify(f.records)).not.toContain(f.context.document);
    f.metrics.close();
    expect(f.records.at(-1)).toMatchObject({ ignored_acknowledgments: '5' });
  });
  it.each(['cancelled', 'superseded'] as const)(
    'does not invent presentation for %s work',
    (outcome) => {
      const f = fixture(),
        handle = f.metrics.begin(f.context);
      f.set(120);
      f.metrics.offer(handle, 'native', { earliest: 90, latest: 100 });
      f.set(150);
      f.metrics.cancel(handle, outcome);
      expect(f.records[0]).toMatchObject({
        capture_clock: 'native_interval',
        capture_to_receive_lower_ms: 20,
        capture_to_receive_upper_ms: 30,
        capture_to_ack_lower_ms: null,
        presentation_ack_after_receive_ms: null,
      });
      expect(f.records[1]).toMatchObject({
        outcome,
        presentation_ack_after_receive_ms: null,
        capture_to_ack_upper_ms: null,
      });
      expect(f.metrics.present(1, f.context.document, handle.id)).toBe(false);
    },
  );
  it('reports native uncertainty bounds at presentation, not a cross-process point estimate', () => {
    const f = fixture(),
      handle = f.metrics.begin({
        ...f.context,
        kind: 'live_caption',
        operation_id: null,
      });
    const operation = randomUUID();
    f.metrics.identify(handle, operation);
    f.set(160);
    f.metrics.offer(handle, 'native', { earliest: 95, latest: 105 });
    f.metrics.identify(handle, randomUUID());
    f.set(180);
    expect(f.metrics.present(1, f.context.document, handle.id)).toBe(true);
    expect(f.records[1]).toMatchObject({
      operation_id: operation,
      capture_to_receive_lower_ms: 55,
      capture_to_receive_upper_ms: 65,
      capture_to_ack_lower_ms: 75,
      capture_to_ack_upper_ms: 85,
    });
  });
  it('expires pending and received tokens, bounds capacity and hides other selected scopes', () => {
    const f = fixture(),
      waiting = f.metrics.begin(f.context);
    f.set(900_101);
    expect(f.metrics.offer(waiting, 'event')).toBeUndefined();
    expect(f.records.at(-1)).toMatchObject({
      outcome: 'expired',
      received_after_start_ms: null,
    });
    const offered = f.metrics.begin(f.context);
    f.metrics.offer(offered, 'event');
    f.set(930_102);
    expect(f.metrics.marker(offered)).toBeUndefined();
    expect(f.records.at(-1)).toMatchObject({
      outcome: 'expired',
      presentation_ack_after_receive_ms: null,
    });
    const handles = Array.from({ length: 33 }, () =>
      f.metrics.begin(f.context),
    );
    expect(f.records.at(-1)).toMatchObject({ outcome: 'capacity' });
    expect(f.metrics.offer(handles[0], 'event')).toBeUndefined();
    for (const handle of handles.slice(1)) f.metrics.offer(handle, 'event');
    expect(f.metrics.markers(1, f.context.document)).toHaveLength(8);
    expect(f.metrics.markers(2, f.context.document)).toEqual([]);
    expect(f.metrics.markers(1, randomUUID())).toEqual([]);
    f.metrics.cancelAll();
    expect(f.metrics.markers(1, f.context.document)).toEqual([]);
  });
  it('rejects invalid metadata without logging its content and is inert after close', () => {
    const f = fixture();
    for (const context of [
      { ...f.context, document: 'private body' },
      { ...f.context, operation_id: 'Bearer secret' },
      { ...f.context, revision: 0 },
      { ...f.context, offset: -1 },
      { ...f.context, scope: 0 },
    ]) {
      const handle = f.metrics.begin(context);
      expect(f.metrics.offer(handle, 'event')).toBeUndefined();
    }
    f.metrics.begin(f.context, 101);
    expect(f.records).toHaveLength(6);
    expect(JSON.stringify(f.records)).not.toMatch(/private body|Bearer secret/);
    f.metrics.close();
    const count = f.records.length;
    f.metrics.offer(f.metrics.begin(f.context), 'event');
    f.metrics.close();
    expect(f.records).toHaveLength(count);
  });
  it('does not buffer unbounded diagnostics or break presentation when the sink stalls or fails', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = new Writable({ highWaterMark: 1, write() {} }),
      metrics = new DesktopDelivery(sink);
    owners.push(metrics);
    for (let i = 0; i < 1000; i++) {
      const document = randomUUID(),
        handle = metrics.begin({
          scope: 1,
          document,
          kind: 'chat_preview',
          operation_id: randomUUID(),
        });
      metrics.offer(handle, 'event');
      expect(metrics.present(1, document, handle.id)).toBe(true);
    }
    expect(sink.writableLength).toBeLessThan(2048);
    sink.emit('error', new Error('private sink credential'));
    const handle = metrics.begin({
      scope: 1,
      document: randomUUID(),
      kind: 'transcript_page',
      operation_id: null,
      revision: 1,
      offset: 0,
    });
    expect(() => metrics.offer(handle, 'network')).not.toThrow();
    metrics.close();
    expect(JSON.stringify(report.mock.calls)).toContain(
      'desktop_delivery_telemetry_unavailable',
    );
    expect(JSON.stringify(report.mock.calls)).toContain(
      'desktop_delivery_telemetry_dropped',
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      'private sink credential',
    );
    sink.destroy();
  });
});
function frame(index = 0): LivePcmFrame {
  return {
    format_version: 1,
    recording_id: randomUUID(),
    preview_id: randomUUID(),
    track_id: randomUUID(),
    capture_epoch: randomUUID(),
    sequence: index,
    sample_start: index * 800,
    sample_count: 800,
    sample_rate: 16_000,
    channels: 1,
    bits_per_sample: 16,
    clock_start_ms: index * 50,
    clock_end_ms: (index + 1) * 50,
    data_base64: Buffer.alloc(1600).toString('base64'),
  };
}
describe('native sample cursor to Main monotonic intervals', () => {
  it('uses the native snapshot age and full IPC bracket, including an interior frame cursor', () => {
    const clock = new CaptureDeliveryClock();
    clock.add([frame()], 100, 1000, 1010);
    expect(clock.at(800)).toEqual({ earliest: 950, latest: 960 });
    expect(clock.at(400)).toEqual({ earliest: 925, latest: 935 });
    expect(clock.at(0)).toBe('audio_anchor_unavailable');
    expect(clock.at(801)).toBe('audio_anchor_unavailable');
  });
  it('distinguishes missing native support from inconsistent or aged-out anchors', () => {
    const clock = new CaptureDeliveryClock();
    clock.add([frame()], undefined, 1000, 1010);
    expect(clock.at(800)).toBe('native_clock_unavailable');
    clock.add([frame()], 25, 1000, 1010);
    expect(clock.at(800)).toBe('audio_anchor_unavailable');
    clock.add([frame()], 100, 1010, 1000);
    expect(clock.at(800)).toBe('audio_anchor_unavailable');
    clock.add([frame()], Number.NaN, 1000, 1010);
    expect(clock.at(800)).toBe('audio_anchor_unavailable');
    for (let i = 0; i < 129; i++)
      clock.add([frame(i)], (i + 1) * 50, 1000 + i * 50, 1010 + i * 50);
    expect(clock.at(800)).toBe('audio_anchor_unavailable');
    expect(clock.at(129 * 800)).toEqual({ earliest: 7400, latest: 7410 });
    expect(clock.at(Number.NaN)).toBe('audio_anchor_unavailable');
  });
});
