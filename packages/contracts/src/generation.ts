import { z } from 'zod';
import { citationSchema, resourceId, type Summary } from './server.js';

export const summarySubmissionSchema = z.strictObject({
  language: z.enum(['en', 'zh']),
  consent_id: resourceId,
  job_id: resourceId.nullable(),
  rejected: z.boolean().default(false),
});
export const summaryReviewSchema = z.strictObject({
  document_id: resourceId,
  job_id: resourceId,
  revision: z.number().int().positive(),
  base_local_revision: z.number().int().positive(),
  text: z
    .string()
    .min(1)
    .max(40_000)
    .refine((value) => !value.includes('\0')),
  edited: z.boolean(),
  applied_local_revision: z.number().int().positive().nullable(),
});
export type SummaryReview = z.infer<typeof summaryReviewSchema>;
export const summarySourceSchema = z.strictObject({
  document_id: resourceId,
  job_id: resourceId,
  citation: citationSchema,
  text: z.string().max(40_000),
  start_ms: z.number().nonnegative().nullable(),
  end_ms: z.number().nonnegative().nullable(),
});
export type SummarySource = z.infer<typeof summarySourceSchema>;
export function summaryCitations(summary: Summary) {
  const unique = new Map<string, z.infer<typeof citationSchema>>();
  for (const fact of [
    summary.overview,
    ...summary.topics,
    ...summary.decisions,
    ...summary.action_items,
    ...summary.open_questions,
  ])
    for (const citation of fact.citations)
      unique.set(
        `${citation.source}:${citation.id}:${citation.revision}`,
        citation,
      );
  return [...unique.values()];
}
export function summaryText(summary: Summary) {
  const citations = summaryCitations(summary);
  const reference = (items: typeof citations) =>
    items
      .map(
        (item) =>
          `[${
            citations.findIndex(
              (citation) =>
                citation.source === item.source &&
                citation.id === item.id &&
                citation.revision === item.revision,
            ) + 1
          }]`,
      )
      .join(' ');
  const fact = (item: Summary['overview']) =>
    `${item.text} ${reference(item.citations)}`;
  return [
    `Overview\n${fact(summary.overview)}`,
    ...(
      [
        ['Topics', summary.topics],
        ['Decisions', summary.decisions],
        ['Open questions', summary.open_questions],
      ] as const
    )
      .filter(([, items]) => items.length)
      .map(
        ([title, items]) =>
          `${title}\n${items.map((item) => `- ${fact(item)}`).join('\n')}`,
      ),
    ...(summary.action_items.length
      ? [
          `Action items\n${summary.action_items
            .map(
              (item) =>
                `- ${fact(item)}\n  Owner: ${item.owner ?? 'Not specified'}; Due: ${item.due_date ?? 'Not specified'}`,
            )
            .join('\n')}`,
        ]
      : []),
  ].join('\n\n');
}
export function summaryReferences(summary: Summary) {
  return summaryCitations(summary)
    .map(
      (citation, index) =>
        `[${index + 1}] ${citation.source === 'note' ? 'Note' : 'Transcript segment'} ${citation.id}, revision ${citation.revision}`,
    )
    .join('\n');
}
