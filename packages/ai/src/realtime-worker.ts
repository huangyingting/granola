import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import {
  MAX_PENDING_SAMPLES,
  MAX_SESSION_SAMPLES,
  speechResultSchema,
  speechWorkerCommandSchema,
  type SpeechWorkerEvent,
} from './realtime-protocol.js';

if (!parentPort)
  throw new Error('The speech worker requires an isolated message port.');
const port = parentPort;
let terminal = false;
let finishing = false;
let samples = 0;
let processed = 0;
let resultSequence = 0;
const pendingResults = new Set<number>();
function fail(code: Extract<SpeechWorkerEvent, { kind: 'error' }>['code']) {
  if (terminal) return;
  terminal = true;
  port.postMessage({ kind: 'error', code });
  process.exit(1);
}
const parsed = z
  .strictObject({
    key: z.string().min(16),
    region: z.string().regex(/^[a-z0-9]{2,32}$/),
    locale: z.enum(['en-US', 'zh-CN']),
  })
  .safeParse(workerData);
if (!parsed.success) fail('live_worker_protocol');
else {
  sdk.Recognizer.enableTelemetry(false);
  sdk.Diagnostics.SetLoggingLevel(sdk.LogLevel.None);
  const speech = sdk.SpeechConfig.fromSubscription(
    parsed.data.key,
    parsed.data.region,
  );
  speech.speechRecognitionLanguage = parsed.data.locale;
  speech.outputFormat = sdk.OutputFormat.Simple;
  speech.setProperty(
    sdk.PropertyId.SpeechServiceConnection_EnableAudioLogging,
    'false',
  );
  speech.setProperty(sdk.PropertyId.Recognizer_StopTimeoutMs, '2000');
  const input = sdk.AudioInputStream.createPushStream(
    sdk.AudioStreamFormat.getWaveFormatPCM(16_000, 16, 1),
  );
  const audio = sdk.AudioConfig.fromStreamInput(input);
  const recognizer = new sdk.SpeechRecognizer(speech, audio);
  const connection = sdk.Connection.fromRecognizer(recognizer);
  connection.disconnected = () => fail('live_provider_closed');
  function result(
    result: sdk.SpeechRecognitionResult,
    type: 'partial' | 'final' | 'no_match',
  ) {
    if (terminal) return;
    const value = speechResultSchema.safeParse({
      kind: 'result',
      sequence: ++resultSequence,
      result_type: type,
      result_id: result.resultId,
      offset_ticks: result.offset,
      duration_ticks: result.duration,
      text: result.text,
    });
    if (
      !value.success ||
      value.data.offset_ticks + value.data.duration_ticks > samples * 625
    ) {
      fail('live_invalid_result');
      return;
    }
    if (pendingResults.size >= 32) {
      fail('live_event_overrun');
      return;
    }
    if (type !== 'partial') {
      // The pinned SDK trims replay in 100 ms chunks before publishing final/NoMatch.
      processed = Math.max(
        processed,
        Math.floor((result.offset + result.duration) / 1_000_000) * 1600,
      );
    }
    pendingResults.add(value.data.sequence);
    port.postMessage(value.data);
  }
  recognizer.recognizing = (_, event) => result(event.result, 'partial');
  recognizer.recognized = (_, event) =>
    result(
      event.result,
      event.result.reason === sdk.ResultReason.NoMatch ? 'no_match' : 'final',
    );
  recognizer.canceled = (_, event) => {
    if (terminal) return;
    if (event.reason === sdk.CancellationReason.EndOfStream && finishing)
      return;
    fail(
      event.errorCode === sdk.CancellationErrorCode.AuthenticationFailure
        ? 'provider_authentication_failed'
        : event.errorCode === sdk.CancellationErrorCode.TooManyRequests ||
            event.errorCode === sdk.CancellationErrorCode.Forbidden
          ? 'provider_rate_limited'
          : 'provider_unavailable',
    );
  };
  recognizer.sessionStopped = () => {
    if (terminal) return;
    if (!finishing) {
      fail('live_provider_closed');
      return;
    }
    terminal = true;
    port.postMessage({ kind: 'stopped', samples });
    process.exit(0);
  };
  port.on('message', (value) => {
    if (terminal) return;
    const parsed = speechWorkerCommandSchema.safeParse(value);
    if (!parsed.success) {
      fail('live_worker_protocol');
      return;
    }
    const command = parsed.data;
    if (command.kind === 'ack') {
      if (!pendingResults.delete(command.sequence))
        fail('live_worker_protocol');
    } else if (command.kind === 'end') {
      if (finishing) {
        fail('live_worker_protocol');
        return;
      }
      finishing = true;
      input.close();
    } else {
      if (finishing || command.sequence !== samples / 800) {
        fail('live_worker_protocol');
        return;
      }
      if (
        samples + 800 > MAX_SESSION_SAMPLES ||
        samples + 800 - processed > MAX_PENDING_SAMPLES
      ) {
        fail('live_audio_overrun');
        return;
      }
      samples += 800;
      input.write(command.pcm);
      new Uint8Array(command.pcm).fill(0);
    }
  });
  recognizer.startContinuousRecognitionAsync(
    () => {
      if (!terminal) port.postMessage({ kind: 'ready' });
    },
    () => fail('provider_unavailable'),
  );
}
