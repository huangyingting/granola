import { z } from 'zod';
import {
  citationKey,
  citationSchema,
  resourceId,
  revision,
  ServiceError,
} from './server.js';
import { summaryEvidenceUnitSchema } from './evidence.js';

export const QUESTION_VERSION = 'meeting-question-v1';
export const QUESTION_RETRIEVAL_VERSION = 'meeting-lexical-v1';
export const QUESTION_PROMPT_VERSION = 'meeting-question-answer-v1';
export const QUESTION_CONTEXT_BYTES = 48_000;
export const questionRequestSchema = z.strictObject({
  note_revision: revision.min(1),
  transcript_revision: revision,
  language: z.enum(['en', 'zh']),
  question: z
    .string()
    .min(1)
    .max(2000)
    .refine((text) => !!text.trim() && !/[\0\uD800-\uDFFF]/u.test(text)),
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;
const utf8 = new TextEncoder();
export const questionEvidenceSchema = questionRequestSchema
  .extend({
    document_id: resourceId,
    version: z.literal(QUESTION_VERSION),
    retrieval_version: z.literal(QUESTION_RETRIEVAL_VERSION),
    mode: z.enum(['full', 'retrieved']),
    units: z.array(summaryEvidenceUnitSchema).max(256),
  })
  .refine(
    (input) =>
      input.units.every((unit) =>
        unit.citation.source === 'note'
          ? unit.citation.id === input.document_id &&
            unit.citation.revision === input.note_revision
          : input.transcript_revision > 0 &&
            unit.citation.revision === input.transcript_revision,
      ) &&
      new Set(
        input.units.map(
          (unit) =>
            `${citationKey(unit.citation)}:${unit.text_start}:${unit.text_end}`,
        ),
      ).size === input.units.length,
    'Question evidence must be unique and retain its frozen meeting revisions.',
  )
  .refine(
    (input) =>
      utf8.encode(JSON.stringify(input)).length <= QUESTION_CONTEXT_BYTES,
    'The complete serialized question evidence exceeds its byte budget.',
  );
export type QuestionEvidence = z.infer<typeof questionEvidenceSchema>;
export const questionAnswerSchema = z
  .strictObject({
    answer: z.strictObject({
      text: z
        .string()
        .min(1)
        .max(4000)
        .refine((text) => !!text.trim() && !/[\0\uD800-\uDFFF]/u.test(text)),
      citations: z.array(citationSchema).max(16),
    }),
    status: z.enum(['answered', 'insufficient_evidence']),
  })
  .refine(
    (value) => value.status !== 'answered' || value.answer.citations.length > 0,
    'An answered question needs at least one meeting citation.',
  );
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export function validateQuestionAnswer(
  value: unknown,
  evidence: QuestionEvidence,
): QuestionAnswer {
  const parsed = questionAnswerSchema.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(
      'invalid_model_output',
      'The model did not return a bounded, cited meeting answer.',
      502,
    );
  const allowed = new Set(
    evidence.units.map((unit) => citationKey(unit.citation)),
  );
  if (
    parsed.data.answer.citations.some(
      (citation) => !allowed.has(citationKey(citation)),
    )
  )
    throw new ServiceError(
      'invalid_citation',
      'The answer cited material outside its supplied meeting evidence.',
      502,
    );
  return parsed.data;
}
export function insufficientQuestionEvidence(
  language: QuestionRequest['language'],
): QuestionAnswer {
  return {
    status: 'insufficient_evidence',
    answer: {
      text:
        language === 'zh'
          ? '当前可用的会议材料不足以回答这个问题。'
          : 'The available meeting evidence is insufficient to answer this question.',
      citations: [],
    },
  };
}

const stopwords = new Set(
  (
    'a an and are as at be been by can could did do does for from had has have ' +
    'how i if in is it its may me my of on or our please should that the their them ' +
    'there these they this to us was we were what when where which who why will with ' +
    'would you your meeting meetings tell about ' +
    '什么 怎么 如何 是否 多少 我们 会议 这个 哪个 问题 请问 一下 可以 内容 的是 是谁'
  ).split(' '),
);
export function questionSearchTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const run of question
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const token of run.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ??
      []) {
      if (/\p{Script=Han}/u.test(token)) {
        const characters = [...token];
        if (characters.length <= 12 && characters.length > 1) terms.add(token);
        for (let index = 0; index < characters.length - 1; index++)
          terms.add(characters.slice(index, index + 2).join(''));
      } else if (token.length >= 2 && token.length <= 64) terms.add(token);
    }
  }
  return [...terms].filter((term) => !stopwords.has(term)).slice(0, 32);
}
export function questionEvidenceScore(text: string, terms: readonly string[]) {
  const normalized = text.normalize('NFKC').toLowerCase();
  return terms.reduce(
    (score, term) => score + Number(normalized.includes(term)),
    0,
  );
}
