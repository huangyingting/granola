import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAzureConfig } from '@windows-ai-notes/ai/config';
import {
  createAzureRealtimeProvider,
  type RealtimeCompletion,
  type RealtimeProvider,
} from '@windows-ai-notes/ai/realtime';
import { makeSilentWav } from '@windows-ai-notes/ai/wav';
import { SEGMENTED_LIVE_PROFILE } from '@windows-ai-notes/contracts/realtime';
import { runLiveProbe } from './live.js';

const { open } = vi.hoisted(() => ({
  open: vi.fn<RealtimeProvider['open']>(),
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));
vi.mock('@windows-ai-notes/ai/config', () => ({
  loadAzureConfig: vi.fn(() => ({
    AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
    AZURE_OPENAI_API_KEY: 'synthetic-openai-key',
    AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
    AZURE_OPENAI_DEPLOYMENT: 'fixture',
    AZURE_SPEECH_KEY: 'synthetic-speech-key',
    AZURE_SPEECH_REGION: 'westus',
  })),
}));
vi.mock('@windows-ai-notes/ai/realtime', () => ({
  createAzureRealtimeProvider: vi.fn(() => ({ open })),
}));

describe('controlled bilingual live Speech probe', () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  function recognition(
    texts: string[],
    options: { corruptReceipt?: boolean; progress?: boolean } = {},
  ) {
    const cancel = vi.fn(async () => undefined);
    open.mockImplementation(
      async (source, _locale, _signal, emit, progress) => {
        const providerEpoch = randomUUID();
        let samples = 0;
        let settle!: (receipt: RealtimeCompletion) => void;
        const completion = new Promise<RealtimeCompletion>((resolve) => {
          settle = resolve;
        });
        return {
          providerEpoch,
          finalizedSamples: 0,
          completion,
          write: (frame) => {
            samples += frame.sample_count;
          },
          finish: async () => {
            for (const text of texts)
              emit({
                schema_version: 1,
                source,
                provider_epoch: providerEpoch,
                event_type: 'transcript.final',
                segment_id: randomUUID(),
                version: 1,
                sample_start: 24_000,
                sample_end: 24_000 + samples,
                text,
                discard_reason: null,
                provider_result_id: randomUUID(),
              });
            if (options.progress !== false)
              progress?.({
                provider_epoch: providerEpoch,
                finalized_samples: samples,
              });
            const receipt = {
              provider_epoch: providerEpoch,
              samples: samples + (options.corruptReceipt ? 800 : 0),
              usage: {
                audio_ms: samples / 16,
                input_tokens: 0,
                output_tokens: 0,
              },
            };
            settle(receipt);
            return receipt;
          },
          cancel,
        };
      },
    );
    return cancel;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubGlobal('fetch', fetch);
    fetch.mockImplementation(
      async () => new Response(new Uint8Array(makeSilentWav(100))),
    );
    open.mockRejectedValue(new Error('Synthetic worker deliberately stopped.'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { locale: 'en-US', voice: 'en-US-JennyNeural', subject: 'Orion' },
    { locale: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural', subject: '猎户座' },
  ])('binds the $locale voice and recognition locale', async (fixture) => {
    for (const scenario of ['short', 'long-phrase']) {
      vi.clearAllMocks();
      await expect(
        runLiveProbe(['--locale', fixture.locale, '--scenario', scenario]),
      ).rejects.toThrow('Synthetic worker deliberately stopped.');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://westus.tts.speech.microsoft.com/cognitiveservices/v1',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          signal: expect.any(AbortSignal),
        }),
      );
      const body = fetch.mock.calls[0]?.[1]?.body;
      expect(body).toContain(`xml:lang="${fixture.locale}"`);
      expect(body).toContain(`name="${fixture.voice}"`);
      expect(body).toContain(fixture.subject);
      expect(open).toHaveBeenCalledWith(
        expect.any(Object),
        fixture.locale,
        expect.any(AbortSignal),
        expect.any(Function),
        expect.any(Function),
        undefined,
        scenario === 'short' ? undefined : SEGMENTED_LIVE_PROFILE,
      );
    }
  });

  it('preserves the default English legacy scenario', async () => {
    await expect(runLiveProbe([])).rejects.toThrow(
      'Synthetic worker deliberately stopped.',
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toContain('Orion launch approved.');
    expect(open.mock.calls[0]?.[1]).toBe('en-US');
    expect(open.mock.calls[0]?.[6]).toBeUndefined();
  });

  it.each(['en-US', 'zh-CN'])(
    'sends no TTS request for %s silence',
    async (locale) => {
      await expect(
        runLiveProbe(['--locale', locale, '--scenario', 'silence']),
      ).rejects.toThrow('Synthetic worker deliberately stopped.');
      expect(fetch).not.toHaveBeenCalled();
      expect(open.mock.calls[0]?.[1]).toBe(locale);
      expect(open.mock.calls[0]?.[6]).toBe(SEGMENTED_LIVE_PROFILE);
    },
  );

  it.each(['', 'en', 'zh-TW', 'en-us', 'auto', 'zh-CN"><voice name="other'])(
    'rejects unsupported locale %j before configuration or provider access',
    async (locale) => {
      await expect(runLiveProbe(['--locale', locale])).rejects.toMatchObject({
        code: 'synthetic_locale_unsupported',
        status: 400,
      });
      expect(loadAzureConfig).not.toHaveBeenCalled();
      expect(createAzureRealtimeProvider).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported scenarios before configuration or provider access', async () => {
    await expect(
      runLiveProbe(['--locale', 'zh-CN', '--scenario', 'unbounded']),
    ).rejects.toThrow('Select a supported synthetic live scenario.');
    expect(loadAzureConfig).not.toHaveBeenCalled();
    expect(createAzureRealtimeProvider).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never falls back to another locale or dispatches STT after TTS failure', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(runLiveProbe(['--locale', 'zh-CN'])).rejects.toMatchObject({
      code: 'synthetic_audio_failed',
      status: 502,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createAzureRealtimeProvider).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: 'short', milliseconds: 4050 },
    { scenario: 'long-phrase', milliseconds: 30_050 },
  ])('preserves the Chinese $scenario TTS byte bound', async (fixture) => {
    fetch.mockResolvedValue(
      new Response(new Uint8Array(makeSilentWav(fixture.milliseconds))),
    );
    await expect(
      runLiveProbe(['--locale', 'zh-CN', '--scenario', fixture.scenario]),
    ).rejects.toThrow('Synthetic speech exceeded the controlled input limit.');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createAzureRealtimeProvider).not.toHaveBeenCalled();
  });

  it.each([
    { locale: 'en-US', text: 'Orion launch approved.' },
    { locale: 'zh-CN', text: '猎户座发射计划已获批准。' },
  ])('prints only bounded $locale success metadata', async (fixture) => {
    const cancel = recognition([fixture.text]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runLiveProbe(['--locale', fixture.locale]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    const line: unknown = output.mock.calls[0]?.[0];
    if (typeof line !== 'string')
      throw new Error('The controlled probe did not print a JSON report.');
    const report: unknown = JSON.parse(line);
    expect(report).toEqual({
      live_speech: 'passed',
      scenario: 'short',
      locale: fixture.locale,
      profile: 'legacy',
      partial_events: 0,
      final_events: 1,
      source_identity_validated: true,
      measured_audio_ms: 1100,
      maximum_unfinalized_ms: 1100,
      finalization_progress_events: 1,
      credentials_logged: false,
      real_meeting_quality_evaluated: false,
    });
    expect(output.mock.calls[0]?.[0]).not.toContain(fixture.text);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('requires a complete bounded Chinese long-phrase receipt', async () => {
    fetch.mockImplementation(
      async () => new Response(new Uint8Array(makeSilentWav(10_000))),
    );
    const cancel = recognition(['猎户座发射计划已获批准。']);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runLiveProbe(['--locale', 'zh-CN', '--scenario', 'long-phrase']);
    const line: unknown = output.mock.calls[0]?.[0];
    if (typeof line !== 'string')
      throw new Error('The controlled probe did not print a JSON report.');
    expect(JSON.parse(line)).toMatchObject({
      locale: 'zh-CN',
      profile: SEGMENTED_LIVE_PROFILE,
      measured_audio_ms: 14_000,
      maximum_unfinalized_ms: 14_000,
      real_meeting_quality_evaluated: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps an unrecognized Chinese proper name a failure without logging final text', async () => {
    const text = '不要写入日志的合成发射内容';
    const cancel = recognition([text]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runLiveProbe(['--locale', 'zh-CN'])).rejects.toMatchObject({
      code: 'synthetic_subject_missing',
      message:
        'Synthetic recognition did not finalize the expected subject (finals: 1; matched terms: 0,1; audio ms: 1100).',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not weaken the same-final subject check across separate Chinese finals', async () => {
    const cancel = recognition(['猎户座', '发射']);
    await expect(runLiveProbe(['--locale', 'zh-CN'])).rejects.toMatchObject({
      code: 'synthetic_subject_missing',
      message:
        'Synthetic recognition did not finalize the expected subject (finals: 2; matched terms: 1,1; audio ms: 1100).',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not accept short unresolved input as a long-phrase result', async () => {
    const cancel = recognition(['猎户座发射计划已获批准。']);
    await expect(
      runLiveProbe(['--locale', 'zh-CN', '--scenario', 'long-phrase']),
    ).rejects.toMatchObject({ code: 'synthetic_long_phrase_insufficient' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete measured receipts after valid Chinese recognition', async () => {
    const cancel = recognition(['猎户座发射计划已获批准。'], {
      corruptReceipt: true,
    });
    await expect(runLiveProbe(['--locale', 'zh-CN'])).rejects.toMatchObject({
      code: 'synthetic_live_receipt_invalid',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { texts: ['猎户座发射计划已获批准。'], progress: true },
    { texts: [], progress: false },
  ])('rejects invalid Chinese silence $texts/$progress', async (fixture) => {
    const cancel = recognition(fixture.texts, { progress: fixture.progress });
    await expect(
      runLiveProbe(['--locale', 'zh-CN', '--scenario', 'silence']),
    ).rejects.toMatchObject({ code: 'synthetic_silence_invalid' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts Chinese silence only with non-text progress and a complete receipt', async () => {
    const cancel = recognition([]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runLiveProbe(['--locale', 'zh-CN', '--scenario', 'silence']);
    expect(output).toHaveBeenCalledTimes(1);
    const line: unknown = output.mock.calls[0]?.[0];
    if (typeof line !== 'string')
      throw new Error('The controlled probe did not print a JSON report.');
    expect(JSON.parse(line)).toMatchObject({
      locale: 'zh-CN',
      profile: SEGMENTED_LIVE_PROFILE,
      measured_audio_ms: 8000,
      partial_events: 0,
      final_events: 0,
      finalization_progress_events: 1,
      real_meeting_quality_evaluated: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is disabled in production before configuration or provider access', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(runLiveProbe(['--locale', 'zh-CN'])).rejects.toThrow(
      'Synthetic probe is disabled in production mode.',
    );
    expect(loadAzureConfig).not.toHaveBeenCalled();
    expect(createAzureRealtimeProvider).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ['--locale', 'zh-CN"><voice name="other'],
      environment: 'test',
      code: 'synthetic_locale_unsupported',
    },
    {
      args: ['--scenario', 'unbounded'],
      environment: 'test',
      code: 'synthetic_scenario_unsupported',
    },
    {
      args: ['--locale', 'zh-CN'],
      environment: 'production',
      code: 'synthetic_probe_disabled',
    },
  ])(
    'the actual CLI reports $code without configuration or unsafe input',
    (fixture) => {
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/live.js', import.meta.url)),
          ...fixture.args,
        ],
        {
          env: { NODE_ENV: fixture.environment },
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 4096,
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);
      expect(child.stdout).toBe('');
      expect(child.stderr).toContain(`${fixture.code}: `);
      expect(child.stderr).not.toContain('<voice');
      expect(child.stderr).not.toContain('AZURE_OPENAI_API_KEY');
      expect(child.stderr).not.toContain('AZURE_SPEECH_KEY');
    },
  );
});
