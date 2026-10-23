import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import {
  liveSpeechProfileSchema,
  SEGMENTED_LIVE_LIMITS,
} from '@windows-ai-notes/contracts/realtime';
import {
  MAX_PENDING_SAMPLES,
  MAX_SESSION_SAMPLES,
  speechResultSchema,
  speechWorkerCommandSchema,
  speechSessionIdentity,
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
let identitySent = false;
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
    profile: liveSpeechProfileSchema.optional(),
  })
  .safeParse(workerData);
if (!parsed.success) fail('live_worker_protocol');
else {
  const profile = parsed.data.profile;
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
  const maxPendingSamples = profile
    ? SEGMENTED_LIVE_LIMITS.provider_window_ms * 16
    : MAX_PENDING_SAMPLES;
  if (profile) {
    speech.setProperty(sdk.PropertyId.Speech_SegmentationStrategy, 'Time');
    speech.setProperty(
      sdk.PropertyId.Speech_SegmentationMaximumTimeMs,
      String(SEGMENTED_LIVE_LIMITS.phrase_ms),
    );
    speech.setProperty(
      sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
      String(SEGMENTED_LIVE_LIMITS.silence_ms),
    );
    speech.setProperty(
      sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      String(SEGMENTED_LIVE_LIMITS.initial_silence_ms),
    );
  }
  const input = sdk.AudioInputStream.createPushStream(
    sdk.AudioStreamFormat.getWaveFormatPCM(16_000, 16, 1),
  );
  const audio = sdk.AudioConfig.fromStreamInput(input);
  const recognizer = new sdk.SpeechRecognizer(speech, audio);
  const connection = sdk.Connection.fromRecognizer(recognizer);
  connection.disconnected = () => fail('live_provider_closed');
  recognizer.sessionStarted = (_, event) => {
    if (terminal || identitySent) return;
    identitySent = true;
    port.postMessage(speechSessionIdentity(event.sessionId));
  };
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
      text: type === 'no_match' ? '' : result.text,
    });
    if (!value.success) {
      fail('live_invalid_result');
      return;
    }
    const beyondInput =
      value.data.offset_ticks + value.data.duration_ticks > samples * 625;
    const nonSpeechReason =
      type === 'no_match'
        ? ('no_match' as const)
        : type === 'final' && profile && !value.data.text.trim()
          ? ('empty_final' as const)
          : undefined;
    if (beyondInput && !(profile && finishing && nonSpeechReason)) {
      fail('live_invalid_result');
      return;
    }
    if (pendingResults.size >= 32) {
      fail('live_event_overrun');
      return;
    }
    if (type !== 'partial' && !beyondInput) {
      // The pinned SDK trims replay in 100 ms chunks before publishing final/NoMatch.
      processed = Math.max(
        processed,
        Math.floor((result.offset + result.duration) / 1_000_000) * 1600,
      );
    }
    pendingResults.add(value.data.sequence);
    // Azure may pad terminal non-speech past EOF; it must never grant audio credit.
    port.postMessage(
      beyondInput
        ? {
            kind: 'eof_non_speech',
            sequence: value.data.sequence,
            result_id: value.data.result_id,
            reason: nonSpeechReason,
          }
        : value.data,
    );
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
        samples + 800 - processed > maxPendingSamples
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
