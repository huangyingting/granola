import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadAzureConfig } from '@windows-ai-notes/ai/config';
import {
  createAzureRealtimeProvider,
  type RealtimeSession,
} from '@windows-ai-notes/ai/realtime';
import { validateWav } from '@windows-ai-notes/ai/wav';
import { ServiceError } from '@windows-ai-notes/contracts/server';

async function readSyntheticWav(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Synthetic speech returned no audio.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 128_044) {
        next.value.fill(0);
        await reader.cancel();
        throw new Error(
          'Synthetic speech exceeded the four-second input limit.',
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

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } });
  if (process.env.NODE_ENV === 'production')
    throw new Error('Synthetic probe is disabled in production mode.');
  const config = loadAzureConfig({
    ...process.env,
    ...(values['env-file'] ? { AZURE_ENV_FILE: values['env-file'] } : {}),
  });
  const signal = AbortSignal.timeout(30_000);
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
      body: '<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural">Orion launch approved.</voice></speak>',
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
  const wav = await readSyntheticWav(response);
  const pcm = Buffer.alloc(Math.ceil((wav.length - 44) / 1600) * 1600 + 32_000);
  wav.copy(pcm, 0, 44);
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
  let session: RealtimeSession | undefined;
  try {
    session = await createAzureRealtimeProvider(config).open(
      source,
      'en-US',
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
          throw new Error(
            'Invalid synthetic recognition identity or sample range.',
          );
        }
        versions.set(event.segment_id, event.version);
        if (event.event_type === 'transcript.partial') partials++;
        if (event.event_type === 'transcript.final') {
          finals++;
          subject ||= /orion/i.test(event.text) && /launch/i.test(event.text);
        }
        return undefined;
      },
    );
    const started = performance.now();
    for (let sequence = 0; sequence < pcm.length / 1600; sequence++) {
      const wait = sequence * 50 - (performance.now() - started);
      if (wait > 0) await delay(wait, undefined, { signal });
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
    }
    const completed = await session.finish();
    if (
      !subject ||
      !finals ||
      completed.samples !== samples ||
      completed.usage.audio_ms !== samples / 16 ||
      completed.provider_epoch !== session.providerEpoch
    )
      throw new Error(
        'Synthetic live recognition or measured receipt was incomplete.',
      );
    console.log(
      JSON.stringify({
        live_speech: 'passed',
        partial_events: partials,
        final_events: finals,
        source_identity_validated: true,
        measured_audio_ms: completed.usage.audio_ms,
        credentials_logged: false,
      }),
    );
  } finally {
    await session?.cancel();
    wav.fill(0);
    pcm.fill(0);
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof ServiceError
      ? `${error.code}: ${error.message}`
      : 'Azure live probe failed. Check the streaming service and Azure configuration; credentials and provider bodies were not logged.',
  );
  process.exitCode = 1;
});
