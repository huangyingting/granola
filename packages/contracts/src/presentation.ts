import { z } from 'zod';

export const presentationSchema = z.strictObject({
  token: z.uuidv4(),
  kind: z.enum([
    'live_caption',
    'summary_preview',
    'chat_preview',
    'transcript_page',
  ]),
  operation_id: z.uuidv4().nullable(),
  revision: z.number().int().positive().optional(),
  offset: z.number().int().min(0).max(2_147_483_647).optional(),
});
export type Presentation = z.infer<typeof presentationSchema>;
