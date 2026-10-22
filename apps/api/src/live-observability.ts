import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { boundedTelemetry } from '@windows-ai-notes/ai/telemetry';

export function liveObservability(
  app: FastifyInstance,
  output: Writable = process.stdout,
) {
  const gateway = randomUUID();
  const telemetry = boundedTelemetry(output, 'live_gateway');
  let active = 0;
  let opened = 0n;
  let closed = 0n;
  const record = (
    code: 'live_gateway_snapshot' | 'live_socket_opened' | 'live_socket_closed',
    fields: object,
  ) =>
    telemetry.emit({
      code,
      finished_at: new Date().toISOString(),
      gateway_instance_id: gateway,
      ...fields,
    });
  const snapshot = () =>
    record('live_gateway_snapshot', {
      open_sockets: active,
      upgraded_sockets: opened.toString(),
      closed_sockets: closed.toString(),
    });
  const timer = setInterval(snapshot, 15_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    telemetry.close();
  });
  snapshot();
  return {
    open(requestId: string) {
      active++;
      opened++;
      record('live_socket_opened', {
        request_id: requestId,
        open_sockets: active,
      });
      return new LiveMeasurements((fields) => {
        active--;
        closed++;
        record('live_socket_closed', {
          request_id: requestId,
          open_sockets: active,
          ...fields,
        });
      });
    },
  };
}

export class LiveMeasurements {
  private readonly openedAt = performance.now();
  private closed = false;
  private outcome: 'disconnected' | 'finished' | 'cancelled' | 'failed' =
    'disconnected';
  private receivedFrames = 0;
  private authorizedFrames = 0;
  private forwardedFrames = 0;
  private gapBatches = 0;
  private gapSamples = 0;
  private discontinuities = 0;
  private inputPeak = 0;
  private resultPeak = 0;
  private resultBytesPeak = 0;
  private outputBytesPeak = 0;
  private unfinalizedSamplesPeak = 0;
  private inputPressure = 0;
  private resultPressure = 0;
  private outputPressure = 0;
  private providerStartedAt: number | null = null;
  private providerStartupMs: number | null = null;
  private firstForwardAt: number | null = null;
  private firstRecognitionMs: number | null = null;

  constructor(private readonly report: (fields: object) => void) {}

  received(frames: number) {
    this.receivedFrames += frames;
  }
  input(frames: number) {
    this.inputPeak = Math.max(this.inputPeak, frames);
  }
  authorized(
    frames: number,
    gap: { sample_start: number; sample_end: number } | null,
  ) {
    this.authorizedFrames += frames;
    if (gap) {
      this.gapBatches++;
      this.gapSamples += gap.sample_end - gap.sample_start;
    }
  }
  discontinuity() {
    this.discontinuities++;
  }
  forwarding() {
    this.firstForwardAt ??= performance.now();
  }
  forwarded(samples: number, finalized: number) {
    this.forwardedFrames++;
    this.unfinalizedSamplesPeak = Math.max(
      this.unfinalizedSamplesPeak,
      samples - finalized,
    );
  }
  queued(results: number, bytes: number) {
    this.resultPeak = Math.max(this.resultPeak, results);
    this.resultBytesPeak = Math.max(this.resultBytesPeak, bytes);
  }
  output(bytes: number) {
    this.outputBytesPeak = Math.max(this.outputBytesPeak, bytes);
  }
  pressure(kind: 'input' | 'result' | 'output') {
    if (kind === 'input') this.inputPressure++;
    else if (kind === 'result') this.resultPressure++;
    else this.outputPressure++;
  }
  providerOpening() {
    this.providerStartedAt = performance.now();
  }
  providerReady() {
    if (this.providerStartedAt !== null)
      this.providerStartupMs = Math.round(
        performance.now() - this.providerStartedAt,
      );
  }
  recognition() {
    if (this.firstForwardAt !== null && this.firstRecognitionMs === null)
      this.firstRecognitionMs = Math.round(
        performance.now() - this.firstForwardAt,
      );
  }
  terminal(reason: 'finished' | 'cancelled', failed: boolean) {
    this.outcome = failed ? 'failed' : reason;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.report({
      outcome: this.outcome,
      socket_duration_ms: Math.round(performance.now() - this.openedAt),
      received_audio_frames: this.receivedFrames,
      authorized_audio_frames: this.authorizedFrames,
      forwarded_audio_frames: this.forwardedFrames,
      authorized_gap_batches: this.gapBatches,
      authorized_gap_ms: this.gapSamples / 16,
      rejected_discontinuities: this.discontinuities,
      input_inflight_frames_peak: this.inputPeak,
      result_queue_messages_peak: this.resultPeak,
      result_queue_bytes_peak: this.resultBytesPeak,
      socket_buffered_bytes_peak: this.outputBytesPeak,
      forwarded_unfinalized_ms_peak: this.unfinalizedSamplesPeak / 16,
      input_backpressure_failures: this.inputPressure,
      result_backpressure_failures: this.resultPressure,
      output_backpressure_failures: this.outputPressure,
      provider_startup_ms: this.providerStartupMs,
      first_recognition_after_forward_ms: this.firstRecognitionMs,
    });
  }
}
