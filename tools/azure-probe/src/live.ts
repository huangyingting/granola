import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadAzureConfig, type AzureConfig } from '@windows-ai-notes/ai/config';
import {
  createAzureRealtimeProvider,
  type RealtimeSession,
} from '@windows-ai-notes/ai/realtime';
import { validateWav } from '@windows-ai-notes/ai/wav';
import {
  locale as speechLocale,
  ServiceError,
} from '@windows-ai-notes/contracts/server';
import {
  SEGMENTED_LIVE_PROFILE,
  SEGMENTED_LIVE_LIMITS,
} from '@windows-ai-notes/contracts/realtime';

const syntheticSpeechFixtures = {
  'en-US': {
    voice: 'en-US-JennyNeural',
    short: 'Orion launch approved.',
    long: 'Orion launch planning brings the research team and the engineering team together to review the mission timeline and confirm every readiness requirement while the operations group checks the remaining instrumentation and the communications group prepares clear messages for the control room so every participant can understand the expected sequence and complete the final review before the scheduled launch',
    subject: [/orion/i, /launch/i],
  },
  'zh-CN': {
    voice: 'zh-CN-XiaoxiaoNeural',
    short: '猎户座发射计划已获批准。',
    long: '猎户座发射规划让研究团队和工程团队共同检查任务时间安排并确认每项准备要求同时运营小组检查仪器状态而通信小组为控制中心准备清晰的信息让每位参与者了解预期顺序并在计划发射之前完成最后检查',
    subject: [/猎户座/u, /发射/u],
  },
};

async function readSyntheticWav(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ServiceError(
      'synthetic_audio_missing',
      'Synthetic speech returned no audio.',
      502,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        next.value.fill(0);
        await reader.cancel();
        throw new ServiceError(
          'synthetic_audio_too_large',
          'Synthetic speech exceeded the controlled input limit.',
          502,
        );
      }
      chunks.push(next.value);
    }
    const wav = Buffer.concat(chunks, size);
    validateWav(wav);
    return wav;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

async function syntheticSpeech(
  config: AzureConfig,
  signal: AbortSignal,
  long: boolean,
  locale: keyof typeof syntheticSpeechFixtures,
) {
  const fixture = syntheticSpeechFixtures[locale];
  const response = await fetch(
    `https://${config.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Ocp-Apim-Subscription-Key': config.AZURE_SPEECH_KEY,
        'content-type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm',
        'User-Agent': 'windows-ai-notes-synthetic-live-probe',
      },
      body: `<speak version="1.0" xml:lang="${locale}"><voice name="${fixture.voice}">${long ? fixture.long : fixture.short}</voice></speak>`,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(
      'synthetic_audio_failed',
      `Synthetic speech returned HTTP ${response.status}.`,
      502,
    );
  }
  return readSyntheticWav(response, long ? 960_044 : 128_044);
}

export async function runLiveProbe(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      'env-file': { type: 'string' },
      scenario: { type: 'string', default: 'short' },
      locale: { type: 'string', default: 'en-US' },
    },
  });
  if (process.env.NODE_ENV === 'production')
    throw new ServiceError(
      'synthetic_probe_disabled',
      'Synthetic probe is disabled in production mode.',
      403,
    );
  if (!['short', 'long-phrase', 'silence'].includes(values.scenario))
    throw new ServiceError(
      'synthetic_scenario_unsupported',
      'Select a supported synthetic live scenario.',
      400,
    );
  const selectedLocale = speechLocale.safeParse(values.locale);
  if (!selectedLocale.success)
    throw new ServiceError(
      'synthetic_locale_unsupported',
      'Select a supported synthetic Speech locale. Use en-US or zh-CN.',
      400,
    );
  const locale = selectedLocale.data;
  const fixture = syntheticSpeechFixtures[locale];
  const config = loadAzureConfig({
    ...process.env,
    ...(values['env-file'] ? { AZURE_ENV_FILE: values['env-file'] } : {}),
  });
  const segmented = values.scenario !== 'short';
  const silence = values.scenario === 'silence';
  const signal = AbortSignal.timeout(segmented ? 75_000 : 30_000);
  const wav = silence
    ? Buffer.alloc(0)
    : await syntheticSpeech(config, signal, segmented, locale);
  const leading = segmented ? 64_000 : 0;
  const pcm = silence
    ? Buffer.alloc(8 * 32_000)
    : Buffer.alloc(
        Math.ceil((wav.length - 44) / 1600) * 1600 +
          leading +
          (segmented ? 64_000 : 32_000),
      );
  if (!silence) wav.copy(pcm, leading, 44);
  const source = {
    recording_id: randomUUID(),
    preview_id: randomUUID(),
    track_id: randomUUID(),
    capture_epoch: randomUUID(),
  };
  const samples = pcm.length / 2;
  const base = 24_000;
  const versions = new Map<string, number>();
  let finals = 0;
  let partials = 0;
  let events = 0;
  let subject = false;
  const matchedSubjectTerms = fixture.subject.map(() => false);
  let progress = 0;
  let maximumUnfinalized = 0;
  let session: RealtimeSession | undefined;
  try {
    session = await createAzureRealtimeProvider(config).open(
      source,
      locale,
      signal,
      (event) => {
        if (
          ++events > 256 ||
          event.sample_start < base ||
          event.sample_end > base + samples ||
          event.provider_epoch !== session?.providerEpoch ||
          Object.keys(source).some(
            (key) =>
              Reflect.get(event.source, key) !== Reflect.get(source, key),
          ) ||
          event.version <= (versions.get(event.segment_id) ?? 0)
        ) {
          throw new ServiceError(
            'synthetic_live_result_invalid',
            'Invalid synthetic recognition identity or sample range.',
            502,
          );
        }
        versions.set(event.segment_id, event.version);
        if (event.event_type === 'transcript.partial') partials++;
        if (event.event_type === 'transcript.final') {
          finals++;
          const matches = fixture.subject.map((term) => term.test(event.text));
          subject ||= matches.every(Boolean);
          for (const [index, matched] of matches.entries())
            matchedSubjectTerms[index] ||= matched;
        }
        return undefined;
      },
      () => {
        progress++;
        return undefined;
      },
      undefined,
      segmented ? SEGMENTED_LIVE_PROFILE : undefined,
    );
    const started = performance.now();
    for (let sequence = 0; sequence < pcm.length / 1600; sequence++) {
      const wait = sequence * 50 - (performance.now() - started);
      if (wait > 0) await delay(wait, undefined, { signal });
      const blockedUntil = performance.now() + 2500;
      while (
        segmented &&
        (sequence + 1) * 800 - session.finalizedSamples >
          SEGMENTED_LIVE_LIMITS.client_window_samples
      ) {
        if (performance.now() >= blockedUntil)
          throw new ServiceError(
            'synthetic_live_backpressure',
            'Synthetic audio exceeded the bounded native reservation.',
            502,
          );
        await delay(25, undefined, { signal });
      }
      session.write({
        ...source,
        format_version: 1,
        sequence: sequence + 17,
        sample_start: base + sequence * 800,
        sample_count: 800,
        sample_rate: 16_000,
        channels: 1,
        bits_per_sample: 16,
        clock_start_ms: 1500 + sequence * 50,
        clock_end_ms: 1550 + sequence * 50,
        data_base64: pcm
          .subarray(sequence * 1600, (sequence + 1) * 1600)
          .toString('base64'),
      });
      maximumUnfinalized = Math.max(
        maximumUnfinalized,
        (sequence + 1) * 800 - session.finalizedSamples,
      );
    }
    const completed = await session.finish();
    if (silence && (finals !== 0 || partials !== 0 || progress === 0))
      throw new ServiceError(
        'synthetic_silence_invalid',
        'Synthetic silence produced text or no finalization progress.',
        502,
      );
    if (!silence && (!subject || !finals))
      throw new ServiceError(
        'synthetic_subject_missing',
        `Synthetic recognition did not finalize the expected subject (finals: ${finals}; matched terms: ${matchedSubjectTerms.map(Number).join(',')}; audio ms: ${samples / 16}).`,
        502,
      );
    if (values.scenario === 'long-phrase' && maximumUnfinalized <= 80_000)
      throw new ServiceError(
        'synthetic_long_phrase_insufficient',
        'Synthetic recognition did not exceed the legacy unresolved-audio bound.',
        502,
      );
    if (
      completed.samples !== samples ||
      completed.usage.audio_ms !== samples / 16 ||
      completed.provider_epoch !== session.providerEpoch
    )
      throw new ServiceError(
        'synthetic_live_receipt_invalid',
        'Synthetic recognition returned an incomplete measured receipt.',
        502,
      );
    console.log(
      JSON.stringify({
        live_speech: 'passed',
        scenario: values.scenario,
        locale,
        profile: segmented ? SEGMENTED_LIVE_PROFILE : 'legacy',
        partial_events: partials,
        final_events: finals,
        source_identity_validated: true,
        measured_audio_ms: completed.usage.audio_ms,
        maximum_unfinalized_ms: maximumUnfinalized / 16,
        finalization_progress_events: progress,
        credentials_logged: false,
        real_meeting_quality_evaluated: false,
      }),
    );
  } finally {
    await session?.cancel();
    wav.fill(0);
    pcm.fill(0);
  }
}
if (import.meta.main)
  runLiveProbe().catch((error: unknown) => {
    console.error(
      error instanceof ServiceError
        ? `${error.code}: ${error.message}`
        : 'Azure live probe failed. Check the streaming service and Azure configuration; credentials and provider bodies were not logged.',
    );
    process.exitCode = 1;
  });
