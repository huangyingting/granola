import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { createAzureProviders, factsSummaryPromptVersion } from './index.js';
import type { AzureConfig } from './config.js';
import {
  SUMMARY_FACTS_PROMPT,
  summaryFactsInputSchema,
  type SummaryEvidenceChunk,
} from '@windows-ai-notes/contracts/evidence';

const config: AzureConfig = {
  AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
  AZURE_OPENAI_API_KEY: 'synthetic-openai-key',
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
  AZURE_OPENAI_DEPLOYMENT: 'configured-deployment',
  AZURE_SPEECH_KEY: 'synthetic-speech-key',
  AZURE_SPEECH_REGION: 'westus',
};
const citation = {
  source: 'transcript' as const,
  id: randomUUID(),
  revision: 2,
};
const text = 'Synthetic confirmed decision.';
const chunk: SummaryEvidenceChunk = {
  document_id: randomUUID(),
  note_revision: 1,
  transcript_revision: 2,
  language: 'zh',
  template_id: 'decisions-actions-v1',
  version: 'meeting-evidence-v1',
  index: 0,
  units: [
    {
      citation,
      text,
      text_start: 0,
      text_end: text.length,
      start_ms: 100,
      end_ms: 900,
      overlap: false,
    },
  ],
};
const fact = {
  category: 'decision' as const,
  text,
  citations: [citation],
  owner: null,
  due_date: null,
};
const input = summaryFactsInputSchema.parse({
  document_id: chunk.document_id,
  note_revision: 1,
  transcript_revision: 2,
  language: 'zh',
  template_id: 'decisions-actions-v1',
  version: 'meeting-facts-input-v1',
  facts: [fact],
});
const summary = {
  overview: { text, citations: [citation] },
  topics: [],
  decisions: [],
  action_items: [],
  open_questions: [],
};
const wireSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  max_completion_tokens: z.number(),
  response_format: z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      strict: z.literal(true),
      schema: z.record(z.string(), z.unknown()),
    }),
  }),
});
const response = (
  value: unknown,
  finish = 'stop',
  content = JSON.stringify(value),
) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message: { content } }],
      usage: { prompt_tokens: 17, completion_tokens: 11 },
    }),
  );
describe('Azure long-meeting structured generation', () => {
  it('uses bounded extraction/merge schemas and a distinct cited final prompt on the same configured deployment', async () => {
    const requests: z.infer<typeof wireSchema>[] = [];
    const provider = createAzureProviders(config, async (url, init) => {
      expect(String(url)).toContain(
        '/openai/deployments/configured-deployment/chat/completions',
      );
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('api-key')).toBe(
        config.AZURE_OPENAI_API_KEY,
      );
      const request = wireSchema.parse(JSON.parse(String(init?.body)));
      requests.push(request);
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('tools');
      return response(
        request.response_format.json_schema.name === 'meeting_summary'
          ? summary
          : { facts: [fact] },
      );
    });
    const report = vi.fn(async () => {});
    const signal = new AbortController().signal;
    expect((await provider.extract!(chunk, signal, report)).facts).toEqual([
      fact,
    ]);
    expect((await provider.merge!(input, signal, report)).facts).toEqual([
      fact,
    ]);
    expect(
      (await provider.summarizeFacts!(input, signal, report)).summary,
    ).toEqual(summary);
    expect(report).toHaveBeenCalledTimes(3);
    for (const request of requests) {
      expect(request.max_completion_tokens).toBe(4096);
      expect(request.messages[0]!.content).toContain('UNTRUSTED DATA');
      expect(request.messages[0]!.content).toContain('Chinese');
      expect(request.response_format.json_schema.schema).toMatchObject({
        additionalProperties: false,
      });
      expect(request.response_format.json_schema.schema).not.toHaveProperty(
        '$schema',
      );
    }
    expect(requests[0]!.messages[0]!.content).toContain('Overlap is context');
    expect(JSON.parse(requests[0]!.messages[1]!.content)).toEqual(chunk);
    expect(requests[1]!.messages[0]!.content).toContain(
      'Merge and deduplicate',
    );
    expect(requests[2]!.messages[0]!.content).toContain(
      'Emphasize confirmed decisions',
    );
    expect(JSON.parse(requests[2]!.messages[1]!.content)).not.toHaveProperty(
      'notes',
    );
    expect(factsSummaryPromptVersion(input)).toBe(
      `${SUMMARY_FACTS_PROMPT}:decisions-actions-v1`,
    );
  });
  it.each(['citation', 'owner', 'bytes', 'truncated', 'json'])(
    'reports known usage before rejecting invalid %s output',
    async (failure) => {
      const facts =
        failure === 'citation'
          ? [{ ...fact, citations: [{ ...citation, id: randomUUID() }] }]
          : failure === 'owner'
            ? [{ ...fact, owner: 'Invented owner' }]
            : failure === 'bytes'
              ? Array.from({ length: 6 }, () => ({
                  ...fact,
                  text: 'x'.repeat(2000),
                }))
              : [fact];
      const report = vi.fn(async () => {});
      const provider = createAzureProviders(config, async () =>
        response(
          { facts },
          failure === 'truncated' ? 'length' : 'stop',
          failure === 'json' ? '{invalid' : JSON.stringify({ facts }),
        ),
      );
      await expect(
        provider.extract!(chunk, new AbortController().signal, report),
      ).rejects.toMatchObject({
        code:
          failure === 'citation' ? 'invalid_citation' : 'invalid_model_output',
      });
      expect(report).toHaveBeenCalledWith({
        input_tokens: 17,
        output_tokens: 11,
        audio_ms: 0,
      });
    },
  );
  it('never broadens final citation scope beyond the merged input facts', async () => {
    const report = vi.fn(async () => {});
    const provider = createAzureProviders(config, async () =>
      response({
        ...summary,
        overview: { text, citations: [{ ...citation, revision: 3 }] },
      }),
    );
    await expect(
      provider.summarizeFacts!(input, new AbortController().signal, report),
    ).rejects.toMatchObject({ code: 'invalid_citation' });
    expect(report).toHaveBeenCalledOnce();
  });
  it('rejects oversized merge input and absent final evidence before transport', async () => {
    const transport = vi.fn(async () => response(summary));
    const provider = createAzureProviders(config, transport);
    const signal = new AbortController().signal;
    await expect(
      provider.merge!(
        {
          ...input,
          facts: Array.from({ length: 64 }, () => ({
            ...fact,
            text: 'x'.repeat(2000),
          })),
        },
        signal,
      ),
    ).rejects.toThrow();
    await expect(
      provider.summarizeFacts!({ ...input, facts: [] }, signal),
    ).rejects.toMatchObject({ code: 'insufficient_evidence' });
    expect(transport).not.toHaveBeenCalled();
  });
});
