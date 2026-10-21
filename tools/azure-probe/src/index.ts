import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createAzureProviders } from '@windows-ai-notes/ai';
import { loadAzureConfig } from '@windows-ai-notes/ai/config';
import { validateWav } from '@windows-ai-notes/ai/wav';
import { Database, requireDatabaseUrl } from '@windows-ai-notes/db';
import { createServer } from '@windows-ai-notes/api/server';
import { runOnce } from '@windows-ai-notes/worker';
import {
  documentSchema,
  transcriptSchema,
  jobSchema,
  ServiceError,
} from '@windows-ai-notes/contracts/server';

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } });
  if (process.env.NODE_ENV === 'production')
    throw new Error('Synthetic probe is disabled in production mode.');
  const config = loadAzureConfig({
    ...process.env,
    ...(values['env-file'] ? { AZURE_ENV_FILE: values['env-file'] } : {}),
  });
  const providers = createAzureProviders(config);
  const url = requireDatabaseUrl();
  const admin = new Database(url);
  const schema = `azure_probe_${randomUUID().replaceAll('-', '')}`;
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  const db = new Database(scoped.href);
  const server = await createServer(db, {
    mode: 'development',
    host: '127.0.0.1',
  });
  try {
    await db.migrate();
    const subject = randomUUID();
    const { workspace_id } = await db.provision(
      'urn:windows-ai-notes:development',
      subject,
      undefined,
      'Synthetic Azure probe',
    );
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const headers = { 'X-Dev-Subject': subject };
    const created = await fetch(`${base}/v1/documents`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        workspace_id,
        title: 'Synthetic Orion meeting',
        notes:
          'Synthetic test only. Mira agreed to send the launch checklist on Friday. The team approved the Orion launch.',
      }),
    });
    if (!created.ok) throw new Error('Synthetic document creation failed.');
    const id = documentSchema.parse(await created.json()).id;
    const synthesis = await fetch(
      `https://${config.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          'Ocp-Apim-Subscription-Key': config.AZURE_SPEECH_KEY,
          'content-type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm',
          'User-Agent': 'windows-ai-notes-synthetic-probe',
        },
        body: '<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural">The team approved the Orion launch. Mira will send the launch checklist on Friday.</voice></speak>',
      },
    );
    if (!synthesis.ok)
      throw new ServiceError(
        'synthetic_audio_failed',
        `Synthetic Azure Speech audio generation returned HTTP ${synthesis.status}.`,
        502,
      );
    const wav = Buffer.from(await synthesis.arrayBuffer());
    validateWav(wav);
    const queued = await fetch(
      `${base}/v1/documents/${id}/transcription-runs?base_revision=0&locale=en-US`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'audio/wav',
          'idempotency-key': randomUUID(),
        },
        body: wav,
      },
    );
    if (!queued.ok) throw new Error('Synthetic transcription enqueue failed.');
    const transcription = jobSchema.parse(await queued.json());
    await runOnce(db, providers);
    const transcribed = jobSchema.parse(
      await (
        await fetch(`${base}/v1/jobs/${transcription.id}`, { headers })
      ).json(),
    );
    if (
      transcribed.state !== 'succeeded' ||
      transcribed.result?.kind !== 'transcription' ||
      transcribed.result.segment_count < 1
    ) {
      throw new ServiceError(
        transcribed.error?.code ?? 'transcription_probe_failed',
        transcribed.error?.message ?? 'Synthetic speech was not recognized.',
        502,
      );
    }
    const transcript = transcriptSchema.parse(
      await (
        await fetch(`${base}/v1/documents/${id}/transcript`, { headers })
      ).json(),
    );
    if (
      !transcript.segments
        .map((segment) => segment.text)
        .join(' ')
        .toLowerCase()
        .includes('launch')
    ) {
      throw new ServiceError(
        'transcription_probe_failed',
        'The generated speech was not recognized as the expected synthetic meeting.',
        502,
      );
    }
    const summaryResponse = await fetch(
      `${base}/v1/documents/${id}/summary-runs`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({
          note_revision: 1,
          transcript_revision: 1,
          language: 'en',
        }),
      },
    );
    if (!summaryResponse.ok)
      throw new Error('Synthetic summary enqueue failed.');
    const summary = jobSchema.parse(await summaryResponse.json());
    await runOnce(db, providers);
    const completed = jobSchema.parse(
      await (await fetch(`${base}/v1/jobs/${summary.id}`, { headers })).json(),
    );
    if (
      completed.state !== 'succeeded' ||
      completed.result?.kind !== 'summary'
    ) {
      throw new ServiceError(
        completed.error?.code ?? 'summary_probe_failed',
        completed.error?.message ?? 'Synthetic summary generation failed.',
        502,
      );
    }
    if (
      !JSON.stringify(completed.result.summary).toLowerCase().includes('orion')
    )
      throw new Error('Synthetic summary lost the primary meeting subject.');
    console.log(
      JSON.stringify({
        speech: 'passed',
        recognized_segments: transcribed.result.segment_count,
        summary: 'passed',
        citations_validated: true,
        usage: completed.result.usage,
        credentials_logged: false,
      }),
    );
  } finally {
    await server.close();
    await db.close();
    await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof ServiceError
      ? `${error.code}: ${error.message}`
      : 'Azure end-to-end probe failed. Check the database and Azure configuration; credentials and provider bodies were not logged.',
  );
  process.exitCode = 1;
});
