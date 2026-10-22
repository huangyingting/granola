import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { liveObservability, LiveMeasurements } from './live-observability.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function collector() {
  const rows: Record<string, unknown>[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { rows, output };
}

it('measures actual upgraded sockets until close, isolates gateway instances and periodically refreshes gauges', async () => {
  vi.useFakeTimers();
  const first = collector();
  const second = collector();
  const app = Fastify();
  const other = Fastify();
  const gateway = liveObservability(app, first.output);
  const nextGateway = liveObservability(other, second.output);
  try {
    const a = gateway.open(randomUUID());
    const b = gateway.open(randomUUID());
    const c = nextGateway.open(randomUUID());
    a.terminal('finished', false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.rows.at(-1)).toMatchObject({
      code: 'live_gateway_snapshot',
      open_sockets: 2,
      upgraded_sockets: '2',
      closed_sockets: '0',
    });
    a.close();
    a.close();
    b.close();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.rows.at(-1)).toMatchObject({
      open_sockets: 0,
      upgraded_sockets: '2',
      closed_sockets: '2',
    });
    expect(second.rows.at(-1)).toMatchObject({ open_sockets: 1 });
    expect(first.rows[0]!.gateway_instance_id).not.toBe(
      second.rows[0]!.gateway_instance_id,
    );
    c.close();
    expect(second.rows.at(-1)).toMatchObject({ outcome: 'disconnected' });
  } finally {
    await app.close();
    await other.close();
  }
  const count = first.rows.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(first.rows).toHaveLength(count);
  expect(first.output.listenerCount('error')).toBe(0);
});

it('reports exact observed frame/gap/pressure peaks and monotonic gateway timings without content fields', () => {
  vi.useFakeTimers();
  const rows: object[] = [];
  const measured = new LiveMeasurements((row) => rows.push(row));
  measured.providerOpening();
  vi.advanceTimersByTime(25);
  measured.providerReady();
  measured.received(4);
  measured.input(3);
  measured.input(1);
  measured.authorized(3, { sample_start: 800, sample_end: 2400 });
  measured.authorized(1, null);
  measured.forwarding();
  measured.forwarded(800, 0);
  measured.forwarded(1600, 0);
  measured.forwarded(2400, 1600);
  measured.queued(2, 1000);
  measured.queued(1, 500);
  measured.output(1600);
  measured.output(800);
  vi.advanceTimersByTime(40);
  measured.recognition();
  vi.advanceTimersByTime(100);
  measured.recognition();
  measured.discontinuity();
  measured.pressure('input');
  measured.pressure('result');
  measured.pressure('output');
  measured.terminal('cancelled', true);
  measured.close();
  expect(rows).toEqual([
    {
      outcome: 'failed',
      socket_duration_ms: 165,
      received_audio_frames: 4,
      authorized_audio_frames: 4,
      forwarded_audio_frames: 3,
      authorized_gap_batches: 1,
      authorized_gap_ms: 100,
      rejected_discontinuities: 1,
      input_inflight_frames_peak: 3,
      result_queue_messages_peak: 2,
      result_queue_bytes_peak: 1000,
      socket_buffered_bytes_peak: 1600,
      forwarded_unfinalized_ms_peak: 100,
      input_backpressure_failures: 1,
      result_backpressure_failures: 1,
      output_backpressure_failures: 1,
      provider_startup_ms: 25,
      first_recognition_after_forward_ms: 40,
    },
  ]);
});

it('does not turn absent startup/recognition or a failed provider write into zero latency or forwarded media', () => {
  const rows: object[] = [];
  const measured = new LiveMeasurements((row) => rows.push(row));
  measured.providerOpening();
  measured.forwarding();
  measured.close();
  expect(rows).toEqual([
    expect.objectContaining({
      provider_startup_ms: null,
      first_recognition_after_forward_ms: null,
      forwarded_audio_frames: 0,
    }),
  ]);
});

it('bounds a blocked live sink, reports dropped records and recovers with a fresh exact gauge', async () => {
  const rows: Record<string, unknown>[] = [];
  const callbacks: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      callbacks.push(done);
    },
  });
  const app = Fastify();
  const gateway = liveObservability(app, output);
  try {
    const measured = gateway.open(randomUUID());
    measured.close();
    expect(rows).toHaveLength(1);
    expect(output.writableLength).toBeLessThan(1024);
    callbacks.shift()!();
    await vi.waitFor(() => expect(rows).toHaveLength(2));
    expect(rows[1]).toMatchObject({
      code: 'live_gateway_telemetry_dropped',
      count: '2',
    });
    callbacks.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const next = gateway.open(randomUUID());
    expect(rows.at(-1)).toMatchObject({
      code: 'live_socket_opened',
      open_sockets: 1,
    });
    callbacks.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    next.close();
  } finally {
    for (const done of callbacks) done();
    await app.close();
  }
});

it('reports failed output without leaking sink exceptions or interrupting socket accounting', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('private-live-sink-configuration'));
    },
  });
  const app = Fastify();
  const gateway = liveObservability(app, output);
  try {
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    gateway.open(randomUUID()).close();
  } finally {
    await app.close();
  }
  const rows = log.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(rows).toContainEqual(
    expect.objectContaining({
      code: 'live_gateway_telemetry_unavailable',
    }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({
      code: 'live_gateway_telemetry_dropped',
      count: '2',
    }),
  );
  expect(JSON.stringify(rows)).not.toContain('private-');
});
