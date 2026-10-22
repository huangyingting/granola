import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  QUESTION_RETRIEVAL_VERSION,
  QUESTION_VERSION,
  questionAnswerSchema,
  questionEvidenceSchema,
  questionEvidenceScore,
  questionRequestSchema,
  questionSearchTerms,
  insufficientQuestionEvidence,
  validateQuestionAnswer,
  type QuestionEvidence,
} from './questions.js';

const document = randomUUID();
const text = 'Mira owns the checklist.';
const request = {
  note_revision: 3,
  transcript_revision: 0,
  language: 'en' as const,
  question: 'Who owns the checklist?',
};
const evidence: QuestionEvidence = {
  document_id: document,
  ...request,
  mode: 'full',
  version: QUESTION_VERSION,
  retrieval_version: QUESTION_RETRIEVAL_VERSION,
  units: [
    {
      citation: { source: 'note', id: document, revision: 3 },
      text,
      text_start: 0,
      text_end: text.length,
      start_ms: null,
      end_ms: null,
      overlap: false,
    },
  ],
};
const answered = () => ({
  answer: { text: 'Mira.', citations: [evidence.units[0]!.citation] },
  status: 'answered',
});
describe('versioned current-meeting question evidence', () => {
  it('retains the exact question and requires a closed bounded evidence package', () => {
    expect(questionEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(
      questionRequestSchema.parse({
        note_revision: 3,
        transcript_revision: 0,
        language: 'en',
        question: '  Checklist?  ',
      }).question,
    ).toBe('  Checklist?  ');
    expect(
      questionEvidenceSchema.safeParse({
        ...evidence,
        provider_url: 'https://example.com',
      }).success,
    ).toBe(false);
    expect(
      questionEvidenceSchema.safeParse({
        ...evidence,
        units: [...evidence.units, ...evidence.units],
      }).success,
    ).toBe(false);
    expect(
      questionEvidenceSchema.safeParse({
        ...evidence,
        units: [
          {
            ...evidence.units[0],
            citation: { source: 'note', id: randomUUID(), revision: 3 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      questionEvidenceSchema.safeParse({
        ...evidence,
        units: [
          {
            ...evidence.units[0],
            citation: { source: 'note', id: document, revision: 2 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      questionEvidenceSchema.safeParse({
        ...evidence,
        units: [{ ...evidence.units[0], text_end: 1 }],
      }).success,
    ).toBe(false);
  });
  it.each(['', '   ', '\0', '\ud800', '\udfff', 'x'.repeat(2001)])(
    'rejects an invalid question %#',
    (question) => {
      expect(
        questionRequestSchema.safeParse({ ...request, question }).success,
      ).toBe(false);
    },
  );
  it('requires citations on answered responses but allows explicit insufficiency without citations', () => {
    expect(validateQuestionAnswer(answered(), evidence)).toEqual(answered());
    expect(
      validateQuestionAnswer(insufficientQuestionEvidence('en'), {
        ...evidence,
        units: [],
      }).status,
    ).toBe('insufficient_evidence');
    expect(insufficientQuestionEvidence('zh').answer.text).not.toBe(
      insufficientQuestionEvidence('en').answer.text,
    );
    expect(
      questionAnswerSchema.safeParse({
        ...answered(),
        answer: { text: 'Mira.', citations: [] },
      }).success,
    ).toBe(false);
    expect(() =>
      validateQuestionAnswer(answered(), { ...evidence, units: [] }),
    ).toThrow('outside');
    expect(() =>
      validateQuestionAnswer(
        {
          ...answered(),
          answer: {
            text: 'Mira.',
            citations: [{ source: 'note', id: document, revision: 2 }],
          },
        },
        evidence,
      ),
    ).toThrow('outside');
    expect(() =>
      validateQuestionAnswer(
        { ...answered(), tool_call: 'anything' },
        evidence,
      ),
    ).toThrow('bounded');
  });
  it('bounds serialized escaped/multibyte evidence rather than only source characters', () => {
    const text = '预算😀'.repeat(6000);
    expect(
      questionEvidenceSchema.safeParse({
        ...evidence,
        units: [{ ...evidence.units[0], text, text_end: text.length }],
      }).success,
    ).toBe(false);
  });
  it('retrieves bounded English, Chinese substrings and normalized mixed-language terms', () => {
    expect(questionSearchTerms('Who owns the CHECKLIST?')).toEqual([
      'owns',
      'checklist',
    ]);
    expect(questionSearchTerms('请问预算是多少？')).toContain('预算');
    expect(questionSearchTerms('ＯＲＩＯＮ预算？')).toContain('orion');
    expect(
      questionEvidenceScore(
        'Orion 预算已确认。',
        questionSearchTerms('ORION预算？'),
      ),
    ).toBeGreaterThan(1);
    expect(questionSearchTerms('Who is it?')).toEqual([]);
    const terms = questionSearchTerms(
      Array.from({ length: 100 }, (_, i) => `term${i}`).join(' '),
    );
    expect(terms).toHaveLength(32);
    expect(questionSearchTerms(`%_'\\ ${'x'.repeat(2000)}`)).toEqual([]);
  });
});
