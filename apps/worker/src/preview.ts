import type { Database, ClaimedJob } from '@windows-ai-notes/db';
import type { PreviewReporter } from '@windows-ai-notes/ai';

export function summaryPreview(db: Database, job: ClaimedJob): PreviewReporter {
  return generationPreview((text) => db.summaries.preview(job, text));
}
export function generationPreview(save: PreviewReporter): PreviewReporter {
  let previous = '',
    sent = 0,
    last = Number.NEGATIVE_INFINITY;
  return async (text) => {
    if (text === previous) return;
    if (!text.startsWith(previous))
      throw new Error(
        'The generation preview changed an already published prefix.',
      );
    if (sent >= 80 || Date.now() - last < 250) return;
    await save(text);
    previous = text;
    last = Date.now();
    sent++;
  };
}
