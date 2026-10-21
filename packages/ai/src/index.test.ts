import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAzureProviders, readAzureResponse } from './index.js';
import {
  loadAzureConfig,
  loadAzureSpeechConfig,
  type AzureConfig,
} from './config.js';
import { makeSilentWav, validateWav } from './wav.js';
import {
  validateSummary,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';

const config: AzureConfig = {
  AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
  AZURE_OPENAI_API_KEY: 'not-a-real-openai-key',
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
  AZURE_OPENAI_DEPLOYMENT: 'configured-deployment',
  AZURE_SPEECH_KEY: 'not-a-real-speech-key',
  AZURE_SPEECH_REGION: 'westus',
};
const snapshot: SummarySnapshot = {
  document_id: randomUUID(),
  note_revision: 2,
  transcript_revision: 1,
  notes: 'Mira will send the checklist.',
  language: 'en',
  segments: [
    {
      id: randomUUID(),
      start_ms: 0,
      end_ms: 500,
      text: 'The launch was approved.',
    },
  ],
};
function summary() {
  return {
    overview: {
      text: 'Launch planning',
      citations: [{ source: 'note', id: snapshot.document_id, revision: 2 }],
    },
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
  };
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });

describe('Azure configuration boundaries', () => {
  it('imports only six Azure fields and allows explicit environment overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notes-env-test-'));
    try {
      const path = join(root, 'config.env');
      await writeFile(
        path,
        Object.entries({
          ...config,
          AZURE_AD_CLIENT_SECRET: 'must-not-propagate',
          DATABASE_URL: 'must-not-propagate',
        })
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
      const loaded = loadAzureConfig({
        AZURE_ENV_FILE: path,
        AZURE_OPENAI_DEPLOYMENT: 'override',
      });
      expect(loaded.AZURE_OPENAI_DEPLOYMENT).toBe('override');
      expect(Object.keys(loaded)).toHaveLength(6);
      expect(JSON.stringify(loaded)).not.toContain('must-not-propagate');
      const speech = loadAzureSpeechConfig({
        AZURE_ENV_FILE: path,
        AZURE_SPEECH_REGION: 'eastus',
        AZURE_OPENAI_API_KEY: 'invalid-and-not-required',
      });
      expect(speech).toEqual({
        AZURE_SPEECH_KEY: config.AZURE_SPEECH_KEY,
        AZURE_SPEECH_REGION: 'eastus',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    'http://fixture.openai.azure.com/',
    'https://example.com/',
    'https://fixture.openai.azure.com/?key=secret',
    'https://fixture.openai.azure.com/openai/',
    'https://name:password@fixture.openai.azure.com/',
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() =>
      loadAzureConfig({ ...config, AZURE_OPENAI_ENDPOINT: endpoint }),
    ).toThrow('resource origin');
  });
  it('does not include invalid credentials in configuration errors', () => {
    expect(() =>
      loadAzureConfig({ ...config, AZURE_OPENAI_API_KEY: 'sensitive' }),
    ).toThrow('AZURE_OPENAI_API_KEY');
    try {
      loadAzureConfig({ ...config, AZURE_OPENAI_API_KEY: 'sensitive' });
    } catch (error) {
      expect(String(error)).not.toContain('sensitive');
    }
  });
  it('requires only Speech fields and never logs invalid Speech secrets', () => {
    expect(
      loadAzureSpeechConfig({
        AZURE_SPEECH_KEY: config.AZURE_SPEECH_KEY,
        AZURE_SPEECH_REGION: config.AZURE_SPEECH_REGION,
      }),
    ).toEqual({
      AZURE_SPEECH_KEY: config.AZURE_SPEECH_KEY,
      AZURE_SPEECH_REGION: config.AZURE_SPEECH_REGION,
    });
    expect(() => loadAzureSpeechConfig({ AZURE_SPEECH_KEY: 'secret' })).toThrow(
      'Invalid Azure Speech configuration fields: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION',
    );
  });
});

describe('Azure summary adapter', () => {
  it('uses the configured deployment, strict output schema, bounded tokens and no tools', async () => {
    let body = '';
    const providers = createAzureProviders(config, async (input, init) => {
      expect(String(input)).toContain(
        '/openai/deployments/configured-deployment/chat/completions',
      );
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('api-key')).toBe(
        config.AZURE_OPENAI_API_KEY,
      );
      body = String(init?.body);
      return response({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify(summary()) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });
    const result = await providers.summarize(
      snapshot,
      new AbortController().signal,
    );
    expect(result.summary.overview.text).toBe('Launch planning');
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      audio_ms: 0,
    });
    expect(body).toContain('UNTRUSTED DATA');
    expect(body).toContain('"strict":true');
    expect(body).toContain('"max_completion_tokens":4096');
    expect(body).not.toContain('"tools"');
    expect(body).not.toContain(config.AZURE_OPENAI_API_KEY);
  });
  it('rejects invented references and wrong immutable revisions', () => {
    for (const citation of [
      { source: 'note', id: randomUUID(), revision: 2 },
      { source: 'note', id: snapshot.document_id, revision: 3 },
      { source: 'transcript', id: snapshot.segments[0]!.id, revision: 2 },
    ]) {
      expect(() =>
        validateSummary(
          {
            ...summary(),
            overview: { text: 'Unfounded', citations: [citation] },
          },
          snapshot,
        ),
      ).toThrow('frozen input');
    }
  });
  it('rejects truncated and malformed model output instead of returning a partial summary', async () => {
    for (const [finish, content] of [
      ['length', JSON.stringify(summary())],
      ['stop', '{'],
    ]) {
      const providers = createAzureProviders(config, async () =>
        response({
          choices: [{ finish_reason: finish, message: { content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
      await expect(
        providers.summarize(snapshot, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'invalid_model_output' });
    }
  });
  it('rejects empty or oversized context before making a paid request', async () => {
    const providers = createAzureProviders(config, async () => {
      throw new Error('Must not call Azure');
    });
    await expect(
      providers.summarize(
        { ...snapshot, notes: '', segments: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'empty_context' });
    await expect(
      providers.summarize(
        { ...snapshot, notes: '字'.repeat(30_000) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'context_too_large' });
  });
  it.each(['length', 'invalid-json', 'bad-citation'])(
    'reports known usage before rejecting %s output',
    async (kind) => {
      const output = summary();
      if (kind === 'bad-citation') output.overview.citations[0]!.revision++;
      const providers = createAzureProviders(config, async () =>
        response({
          choices: [
            {
              finish_reason: kind === 'length' ? 'length' : 'stop',
              message: {
                content: kind === 'invalid-json' ? '{' : JSON.stringify(output),
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
      );
      const report = vi.fn(async () => {});
      await expect(
        providers.summarize(snapshot, new AbortController().signal, report),
      ).rejects.toBeInstanceOf(Error);
      expect(report).toHaveBeenCalledExactlyOnceWith({
        input_tokens: 11,
        output_tokens: 22,
        audio_ms: 0,
      });
    },
  );
});

describe('Azure Speech fast transcription', () => {
  it('uploads bounded WAV bytes inline and normalizes stable timestamped segments', async () => {
    const providers = createAzureProviders(config, async (input, init) => {
      expect(String(input)).toBe(
        'https://westus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
      );
      expect(init?.body).toBeInstanceOf(FormData);
      expect(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key')).toBe(
        config.AZURE_SPEECH_KEY,
      );
      return response({
        durationMilliseconds: 1000,
        combinedPhrases: [{ text: 'Synthetic speech.' }],
        phrases: [
          {
            text: 'Synthetic speech.',
            offsetMilliseconds: 10,
            durationMilliseconds: 500,
          },
        ],
      });
    });
    const result = await providers.transcribe(
      makeSilentWav(),
      'en-US',
      new AbortController().signal,
    );
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      text: 'Synthetic speech.',
      start_ms: 10,
      end_ms: 510,
    });
    expect(result.usage.audio_ms).toBe(1000);
  });
  it('preserves explicit empty speech results and rejects out-of-bounds phrases', async () => {
    const silent = createAzureProviders(config, async () =>
      response({
        durationMilliseconds: 1000,
        combinedPhrases: [],
        phrases: [],
      }),
    );
    expect(
      (
        await silent.transcribe(
          makeSilentWav(),
          'en-US',
          new AbortController().signal,
        )
      ).segments,
    ).toEqual([]);
    const bad = createAzureProviders(config, async () =>
      response({
        durationMilliseconds: 1000,
        combinedPhrases: [{ text: 'Wrong' }],
        phrases: [
          { text: 'Wrong', offsetMilliseconds: 900, durationMilliseconds: 900 },
        ],
      }),
    );
    await expect(
      bad.transcribe(makeSilentWav(), 'en-US', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid_transcript' });
  });
  it('validates WAV sizes, durations, container and codec without decoding arbitrary media', () => {
    expect(validateWav(makeSilentWav(60_000))).toBe(60_000);
    for (const bytes of [
      Buffer.alloc(0),
      makeSilentWav(60_001),
      Buffer.from('not WAV'),
    ]) {
      expect(() => validateWav(bytes)).toThrow('PCM16');
    }
    const stereo = makeSilentWav();
    stereo.writeUInt16LE(2, 22);
    expect(() => validateWav(stereo)).toThrow('PCM16');
  });
  it('records accepted media duration even for invalid speech output, but never treats failed requests as settled', async () => {
    const report = vi.fn(async () => {});
    const invalid = createAzureProviders(config, async () =>
      response({ phrases: 'invalid' }),
    );
    await expect(
      invalid.transcribe(
        makeSilentWav(),
        'en-US',
        new AbortController().signal,
        report,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transcript' });
    expect(report).toHaveBeenCalledExactlyOnceWith({
      input_tokens: 0,
      output_tokens: 0,
      audio_ms: 1000,
    });
    report.mockClear();
    const failed = createAzureProviders(
      config,
      async () => new Response('not-a-usage-receipt', { status: 503 }),
    );
    await expect(
      failed.transcribe(
        makeSilentWav(),
        'en-US',
        new AbortController().signal,
        report,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(report).not.toHaveBeenCalled();
  });
});

describe('provider failure handling', () => {
  it.each([
    [401, 'provider_authentication_failed', false],
    [429, 'provider_rate_limited', true],
    [503, 'provider_unavailable', true],
  ])(
    'classifies HTTP %i without leaking provider response bodies',
    async (status, code, retryable) => {
      const error = await readAzureResponse(
        new Response('private-provider-body', { status: Number(status) }),
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({ code, retryable });
      expect(String(error)).not.toContain('private-provider-body');
    },
  );
  it('rejects oversized responses', async () => {
    await expect(
      readAzureResponse(response({ huge: 'a'.repeat(100) }), 20),
    ).rejects.toMatchObject({ code: 'provider_response_too_large' });
  });
});
