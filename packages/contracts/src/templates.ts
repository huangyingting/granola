import { z } from 'zod';

export const DEFAULT_SUMMARY_TEMPLATE = 'meeting-summary-v1';
export const summaryTemplateIdSchema = z.enum([
  DEFAULT_SUMMARY_TEMPLATE,
  'decisions-actions-v1',
]);
export type SummaryTemplateId = z.infer<typeof summaryTemplateIdSchema>;
export const summaryTemplateCatalogSchema = z.strictObject({
  templates: z
    .array(
      z.strictObject({
        id: z
          .string()
          .max(80)
          .regex(/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/),
        name: z.string().min(1).max(100),
        description: z.string().min(1).max(300).optional(),
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
    ),
});
export type SummaryTemplateCatalog = z.infer<
  typeof summaryTemplateCatalogSchema
>;
export const SUMMARY_TEMPLATES = [
  {
    id: DEFAULT_SUMMARY_TEMPLATE,
    name: 'Meeting summary',
    description:
      'Balanced overview, topics, decisions, action items and open questions.',
  },
  {
    id: 'decisions-actions-v1',
    name: 'Decisions and actions',
    description:
      'Emphasize confirmed decisions, explicit commitments and unresolved follow-ups.',
  },
] as const satisfies readonly {
  id: SummaryTemplateId;
  name: string;
  description: string;
}[];
