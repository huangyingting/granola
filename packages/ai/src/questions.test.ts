import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAzureProviders } from './index.js';
import { answerPreview, overviewPreview } from './stream.js';
import {
  QUESTION_VERSION,
  QUESTION_RETRIEVAL_VERSION,
  type QuestionEvidence,
} from '@windows-ai-notes/contracts/questions';
import type { AzureConfig } from './config.js';

const config: AzureConfig = {
  AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
  AZURE_OPENAI_API_KEY: 'synthetic-not-a-secret',
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
  AZURE_OPENAI_DEPLOYMENT: 'configured-deployment',
  AZURE_SPEECH_KEY: 'synthetic-not-a-secret',
  AZURE_SPEECH_REGION: 'westus',
};
const document = randomUUID();
const sampleText = 'Mira owns the checklist.';
const evidence: QuestionEvidence = {
  document_id: document,
  note_revision: 1,
  transcript_revision: 0,
  language: 'en',
  question: 'Who owns the checklist?',
  mode: 'full',
  version: QUESTION_VERSION,
  retrieval_version: QUESTION_RETRIEVAL_VERSION,
  units: [
    {
      citation: { source: 'note', id: document, revision: 1 },
      text: sampleText,
      text_start: 0,
      text_end: sampleText.length,
      start_ms: null,
      end_ms: null,
      overlap: false,
    },
  ],
};
const answer = () => ({
  answer: {
    text: 'Mira owns the checklist.',
    citations: [evidence.units[0]!.citation],
  },
  status: 'answered',
});
const usage = { prompt_tokens: 25, completion_tokens: 12 };
const receipt = { input_tokens: 25, output_tokens: 12, audio_ms: 0 };
function response(value: unknown, finish = 'stop') {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: finish, message: { content: JSON.stringify(value) } },
      ],
      usage,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
function streamed(value: unknown) {
  const content = JSON.stringify(value);
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: { content: content.slice(0, 30) },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { content: content.slice(30) },
          finish_reason: 'stop',
        },
      ],
    },
    { choices: [], usage },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const signal = () => new AbortController().signal;

describe('read-only Azure current-meeting answers', () => {
  it('uses only configured deployment and immutable evidence with no model tools', async () => {
    let url = '',
      body: Record<string, unknown> = {};
    const provider = createAzureProviders(config, async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.redirect).toBe('error');
      return response(answer());
    });
    const report = vi.fn(async () => {});
    const result = await provider.answer!(evidence, signal(), report);
    expect(result).toEqual({ answer: answer(), usage: receipt });
    expect(url).toContain(
      '/openai/deployments/configured-deployment/chat/completions',
    );
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('stream');
    expect(body.max_completion_tokens).toBe(4096);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[1]!.content)).toEqual(evidence);
    expect(messages[0]!.content).toContain('insufficient_evidence');
    expect(messages[0]!.content).toContain('UNTRUSTED DATA');
    expect(messages[0]!.content).toContain(
      'never claim absence from the whole meeting',
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(receipt);
  });
  it('streams only plain answer text and validates the completed answer after accounting', async () => {
    const report = vi.fn(async () => {});
    const previews: string[] = [];
    const provider = createAzureProviders(config, async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      return streamed(answer());
    });
    const result = await provider.answer!(
      evidence,
      signal(),
      report,
      async (text) => {
        previews.push(text);
      },
    );
    expect(result.answer).toEqual(answer());
    expect(previews.at(-1)).toBe(answer().answer.text);
    expect(
      previews.some((text) => text.includes('citations') || text.includes('{')),
    ).toBe(false);
    expect(report).toHaveBeenCalledExactlyOnceWith(receipt);
  });
  it.each([false, true])(
    'retains known usage when citation validation fails, streaming=%s',
    async (stream) => {
      const foreign = answer();
      foreign.answer.citations[0] = {
        source: 'note',
        id: randomUUID(),
        revision: 1,
      };
      const report = vi.fn(async () => {});
      const provider = createAzureProviders(config, async () =>
        stream ? streamed(foreign) : response(foreign),
      );
      await expect(
        provider.answer!(
          evidence,
          signal(),
          report,
          stream ? async () => {} : undefined,
        ),
      ).rejects.toMatchObject({ code: 'invalid_citation' });
      expect(report).toHaveBeenCalledExactlyOnceWith(receipt);
    },
  );
  it('does not send an empty evidence package to a paid model', async () => {
    const transport = vi.fn(async () => response(answer()));
    const provider = createAzureProviders(config, transport);
    const report = vi.fn(async () => {});
    const result = await provider.answer!(
      { ...evidence, units: [], language: 'zh', mode: 'retrieved' },
      signal(),
      report,
    );
    expect(result.answer.status).toBe('insufficient_evidence');
    expect(result.answer.answer.citations).toEqual([]);
    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      audio_ms: 0,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
  it('accepts an explicit insufficient-evidence answer rather than inventing meeting knowledge', async () => {
    const value = {
      answer: {
        text: 'No deadline is present in the supplied evidence.',
        citations: [],
      },
      status: 'insufficient_evidence',
    };
    const provider = createAzureProviders(config, async () => response(value));
    expect((await provider.answer!(evidence, signal())).answer).toEqual(value);
  });
  it.each([
    { answer: { text: 'Invented owner.', citations: [] }, status: 'answered' },
    { answer: { text: 'Wrong.', citations: [] }, status: 'unknown' },
    { ...answer(), tool: 'https://example.com' },
  ])(
    'rejects invalid answers %# without another paid request',
    async (value) => {
      const transport = vi.fn(async () => response(value));
      const provider = createAzureProviders(config, transport);
      await expect(provider.answer!(evidence, signal())).rejects.toMatchObject({
        code: 'invalid_model_output',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('does not dispatch after cancellation or accept truncated answers', async () => {
    const transport = vi.fn(async () => response(answer(), 'length'));
    const provider = createAzureProviders(config, transport);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.answer!(evidence, controller.signal),
    ).rejects.toMatchObject({ code: 'job_cancelled' });
    expect(transport).not.toHaveBeenCalled();
    await expect(provider.answer!(evidence, signal())).rejects.toMatchObject({
      code: 'invalid_model_output',
    });
  });
  it('isolates answer and summary projections and safely withholds incomplete escapes', () => {
    const partial = '{"answer":{"text":"中文\\uD83D';
    expect(answerPreview(partial)).toBe('中文');
    expect(overviewPreview(partial)).toBeNull();
    expect(answerPreview('{"overview":{"text":"summary')).toBeNull();
    expect(
      answerPreview('{"status":"answered","answer":{"text":"later"}}'),
    ).toBeNull();
    expect(
      answerPreview(
        '{"answer":{"text":"plain\\ntext\\uD83D\\uDE00","citations":[',
      ),
    ).toBe('plain\ntext😀');
  });
});
