import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { desktopCommandSchema } from './desktop.js';
import {
  summaryStageKeySchema,
  summaryStageSpecSchema,
  summaryProgressSchema,
  validateEvidenceFacts,
  validatePipelineFacts,
  summaryFactsInputSchema,
  SUMMARY_PIPELINE_FACT_BYTES,
  SUMMARY_FACTS_INPUT_BYTES,
} from './evidence.js';
import {
  summarySnapshotCitations,
  validateSummary,
  jobInputSchema,
  summaryRequestSchema,
  type SummarySnapshot,
} from './server.js';

const input: SummarySnapshot = {
  document_id: randomUUID(),
  note_revision: 1,
  transcript_revision: 0,
  notes: 'Frozen evidence.',
  segments: [],
  language: 'en',
};
const citations = summarySnapshotCitations(input);
const fact = {
  category: 'decision' as const,
  text: 'Verify this decision.',
  citations,
  owner: null,
  due_date: null,
};
describe('durable summary stage contracts', () => {
  it('fits four near-limit pipeline fact outputs in a bounded merge without copying full notes', () => {
    const output = validatePipelineFacts(
      {
        facts: Array.from({ length: 4 }, () => ({
          ...fact,
          text: 'x'.repeat(1800),
        })),
      },
      citations,
    );
    expect(Buffer.byteLength(JSON.stringify(output))).toBeGreaterThan(7500);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(
      SUMMARY_PIPELINE_FACT_BYTES,
    );
    const { notes: _notes, segments: _segments, ...context } = input;
    const merged = summaryFactsInputSchema.parse({
      ...context,
      version: 'meeting-facts-input-v1',
      facts: Array.from({ length: 4 }, () => output.facts).flat(),
    });
    expect(merged.facts).toHaveLength(16);
    expect(Buffer.byteLength(JSON.stringify(merged))).toBeLessThanOrEqual(
      SUMMARY_FACTS_INPUT_BYTES,
    );
    expect(merged).not.toHaveProperty('notes');
  });
  it('keeps long-meeting consent optional without rewriting legacy request hashes', () => {
    const body = {
      note_revision: 1,
      transcript_revision: 0,
      language: 'en' as const,
    };
    expect(summaryRequestSchema.parse(body)).toEqual(body);
    expect(
      summaryRequestSchema.safeParse({ ...body, allow_long_context: false })
        .success,
    ).toBe(false);
    expect(
      summaryRequestSchema.parse({ ...body, allow_long_context: true }),
    ).toEqual({ ...body, allow_long_context: true });
  });
  it('requires indexed summaries to pin one canonical revision without a partial embedded transcript', () => {
    const indexed = {
      kind: 'summary',
      snapshot: { ...input, transcript_revision: 2 },
      source: {
        version: 'staged-evidence-v1',
        text_bytes: 5000,
        transcript: {
          document_id: input.document_id,
          revision: 2,
          source: 'manual',
          total_segments: 1101,
        },
      },
    };
    expect(jobInputSchema.safeParse(indexed).success).toBe(true);
    for (const change of [
      {
        ...indexed.source,
        transcript: { ...indexed.source.transcript, revision: 1 },
      },
      {
        ...indexed.source,
        transcript: { ...indexed.source.transcript, document_id: randomUUID() },
      },
      {
        ...indexed.source,
        transcript: { ...indexed.source.transcript, is_candidate: true },
      },
      { ...indexed.source, text_bytes: 0 },
      {
        ...indexed.source,
        text_bytes: 1,
        transcript: { ...indexed.source.transcript, total_segments: 0 },
      },
    ])
      expect(
        jobInputSchema.safeParse({ ...indexed, source: change }).success,
      ).toBe(false);
    expect(
      jobInputSchema.safeParse({
        ...indexed,
        snapshot: {
          ...indexed.snapshot,
          segments: [
            {
              id: randomUUID(),
              start_ms: 0,
              end_ms: 100,
              text: 'A partial transcript must not masquerade as the full frozen source.',
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('requires resume consent tokens only for the resume IPC action', () => {
    const command = {
      operation: 'controlSummary',
      scope: 1,
      id: input.document_id,
      job_id: randomUUID(),
      confirmed: true,
    };
    expect(
      desktopCommandSchema.safeParse({ ...command, action: 'resume' }).success,
    ).toBe(false);
    expect(
      desktopCommandSchema.safeParse({
        ...command,
        action: 'resume',
        resume_token: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      desktopCommandSchema.safeParse({ ...command, action: 'refresh' }).success,
    ).toBe(true);
    expect(
      desktopCommandSchema.safeParse({
        ...command,
        action: 'cancel',
        resume_token: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it('accepts bounded facts, including no confirmed facts, without inventing an action owner', () => {
    expect(validateEvidenceFacts({ facts: [] }, citations)).toEqual({
      facts: [],
    });
    expect(validateEvidenceFacts({ facts: [fact] }, citations)).toEqual({
      facts: [fact],
    });
    expect(() =>
      validateEvidenceFacts(
        { facts: [{ ...fact, owner: 'Invented owner' }] },
        citations,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_model_output' }));
    expect(() =>
      validateEvidenceFacts(
        { facts: [{ ...fact, due_date: 'Tomorrow' }] },
        citations,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_model_output' }));
    expect(
      validateEvidenceFacts(
        { facts: [{ ...fact, category: 'action', owner: 'Explicit owner' }] },
        citations,
      ).facts[0]!.owner,
    ).toBe('Explicit owner');
  });
  it('rejects citations outside the exact stage and unknown model fields', () => {
    expect(() =>
      validateEvidenceFacts(
        {
          facts: [{ ...fact, citations: [{ ...citations[0]!, revision: 2 }] }],
        },
        citations,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));
    expect(() =>
      validateEvidenceFacts(
        { facts: [{ ...fact, speaker: 'Unsupported attribution' }] },
        citations,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_model_output' }));
  });
  it('bounds the complete serialized fact output, including UTF-8 and escaping', () => {
    for (const text of ['a'.repeat(2000), '😀'.repeat(1000), '\n'.repeat(2000)])
      expect(() =>
        validateEvidenceFacts(
          { facts: Array.from({ length: 64 }, () => ({ ...fact, text })) },
          citations,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid_model_output' }));
  });
  it.each([
    { phase: 'generate', round: 0, index: 1 },
    { phase: 'extract', round: 1, index: 0 },
    { phase: 'merge', round: 0, index: 0 },
    { phase: 'extract', round: 0, index: 20_000 },
    { phase: 'merge', round: 9, index: 0 },
  ])('rejects invalid stage keys: %j', (key) => {
    expect(summaryStageKeySchema.safeParse(key).success).toBe(false);
  });
  it('requires unique citations and a stable stage input hash', () => {
    const value = {
      phase: 'generate',
      round: 0,
      index: 0,
      input_hash: 'a'.repeat(64),
      prompt_version: 'meeting-summary-v1',
      citations,
    };
    expect(summaryStageSpecSchema.safeParse(value).success).toBe(true);
    expect(
      summaryStageSpecSchema.safeParse({
        ...value,
        citations: [...citations, ...citations],
      }).success,
    ).toBe(false);
    expect(
      summaryStageSpecSchema.safeParse({ ...value, input_hash: 'unstable' })
        .success,
    ).toBe(false);
  });
  it('does not create a note citation for whitespace-only notes', () => {
    const empty = { ...input, notes: ' \n ' };
    expect(summarySnapshotCitations(empty)).toEqual([]);
    expect(() =>
      validateSummary(
        {
          overview: { text: 'Unsupported fact.', citations },
          topics: [],
          decisions: [],
          action_items: [],
          open_questions: [],
        },
        empty,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));
  });
  it('requires consistent progress counts and a token exactly when resume is available', () => {
    const value = {
      document_id: input.document_id,
      job_id: randomUUID(),
      state: 'failed',
      total_stages: 1,
      completed_stages: 0,
      provider_requests: 1,
      uncertain_requests: 1,
      resume_available: true,
      resume_token: randomUUID(),
    };
    expect(summaryProgressSchema.safeParse(value).success).toBe(true);
    for (const change of [
      { completed_stages: 2 },
      { uncertain_requests: 2 },
      { resume_token: null },
      { resume_available: false },
      { state: 'running' },
    ])
      expect(
        summaryProgressSchema.safeParse({ ...value, ...change }).success,
      ).toBe(false);
  });
});
