import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readAzureStream, overviewPreview } from './stream.js';
import { createAzureProviders } from './index.js';
const wire = (
  content: string | null,
  finish: string | null = null,
  refusal?: string,
) => ({
  choices: [
    {
      index: 0,
      delta: { content, ...(refusal ? { refusal } : {}) },
      finish_reason: finish,
    },
  ],
});
const receipt = {
  choices: [],
  usage: { prompt_tokens: 17, completion_tokens: 11 },
};
function response(values: unknown[], done = true) {
  return new Response(
    values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') +
      (done ? 'data: [DONE]\n\n' : ''),
    {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    },
  );
}
describe('bounded Azure streamed structured output', () => {
  it('projects only the overview string without unfinished escapes, raw JSON or unmatched surrogates', () => {
    expect(
      overviewPreview(
        '{"overview":{"text":"A \\"quoted\\" choice\\n\\u4e2d\\u6587\\uD83D',
      ),
    ).toBe('A "quoted" choice\n中文');
    expect(overviewPreview('{"overview":{"text":"A\\u4e')).toBe('A');
    expect(overviewPreview('{"overview":{"text":"A\\q')).toBeNull();
    expect(overviewPreview('{"topics":[]')).toBeNull();
    expect(
      overviewPreview('{"overview":{"text":"<script>literal text</script>"'),
    ).toBe('<script>literal text</script>');
  });
  it('retains final usage and content, and awaits projection before reading further', async () => {
    const preview = vi.fn(async (_text: string) => {}),
      report = vi.fn(async () => {});
    const value = await readAzureStream(
      response([
        wire('{"overview":{"text":"First'),
        wire(' second"}}', 'stop'),
        receipt,
      ]),
      new AbortController().signal,
      preview,
      report,
    );
    expect(value.choices[0]?.message.content).toBe(
      '{"overview":{"text":"First second"}}',
    );
    expect(preview.mock.calls.map((args) => args[0])).toEqual([
      'First',
      'First second',
    ]);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      input_tokens: 17,
      output_tokens: 11,
      audio_ms: 0,
    });
  });
  it.each(['length', 'refusal', 'missing terminator'] as const)(
    'records known usage before rejecting %s',
    async (failure) => {
      const report = vi.fn(async () => {});
      await expect(
        readAzureStream(
          response(
            [
              wire(
                '{"overview":{"text":"Unverified"}}',
                failure === 'length' ? 'length' : 'stop',
                failure === 'refusal' ? 'refused' : undefined,
              ),
              receipt,
            ],
            failure !== 'missing terminator',
          ),
          new AbortController().signal,
          async () => {},
          report,
        ),
      ).rejects.toMatchObject({ code: 'invalid_model_output' });
      expect(report).toHaveBeenCalledTimes(1);
    },
  );
  it('requires usage and refuses an unsupported response type instead of silently downgrading', async () => {
    const report = vi.fn(async () => {});
    await expect(
      readAzureStream(
        response([wire('{}', 'stop')]),
        new AbortController().signal,
        async () => {},
        report,
      ),
    ).rejects.toMatchObject({ code: 'invalid_model_output' });
    expect(report).not.toHaveBeenCalled();
    await expect(
      readAzureStream(
        new Response('{}'),
        new AbortController().signal,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'invalid_model_output' });
  });
  it('uses explicit streaming options on the original configured deployment and still validates original citations', async () => {
    const snapshot = {
      document_id: randomUUID(),
      notes: 'Synthetic evidence.',
      segments: [],
      note_revision: 1,
      transcript_revision: 0,
      language: 'en' as const,
    };
    const summary = {
      overview: {
        text: 'Synthetic streamed answer.',
        citations: [{ source: 'note', id: snapshot.document_id, revision: 1 }],
      },
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
    };
    const transport = vi.fn<typeof fetch>(async (_url, options) => {
      expect(JSON.parse(String(options?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      return response([wire(JSON.stringify(summary), 'stop'), receipt]);
    });
    const provider = createAzureProviders(
      {
        AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
        AZURE_OPENAI_API_KEY: 'synthetic-openai-key',
        AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
        AZURE_OPENAI_DEPLOYMENT: 'configured-deployment',
        AZURE_SPEECH_KEY: 'synthetic-speech-key',
        AZURE_SPEECH_REGION: 'westus',
      },
      transport,
    );
    const preview = vi.fn(async (_text: string) => {}),
      report = vi.fn(async () => {});
    expect(
      (
        await provider.summarize(
          snapshot,
          new AbortController().signal,
          report,
          preview,
        )
      ).summary,
    ).toEqual(summary);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('Synthetic streamed answer.');
  });
});
