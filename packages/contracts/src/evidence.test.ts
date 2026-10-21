import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { desktopCommandSchema } from './desktop.js';
import {
  summaryStageKeySchema,
  summaryStageSpecSchema,
  summaryProgressSchema,
  validateEvidenceFacts,
} from './evidence.js';
import {
  summarySnapshotCitations,
  validateSummary,
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
