import { usageSchema, type Usage } from '@windows-ai-notes/contracts/server';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { bindAuditContext, type Database } from '@windows-ai-notes/db';
import type { UsageReporter } from '@windows-ai-notes/ai';
import { withProviderContext } from '@windows-ai-notes/ai/observability';

export async function withUsage<T extends { usage: Usage }>(
  db: Database,
  call: string,
  invoke: (report: UsageReporter) => Promise<T>,
): Promise<T> {
  let reported: Usage | null = null;
  const report: UsageReporter = bindAuditContext(async (value: Usage) => {
    const parsed = usageSchema.parse(value);
    const usage = { ...parsed, audio_ms: Math.ceil(parsed.audio_ms) };
    if (reported && canonicalJson(reported) === canonicalJson(usage)) return;
    await db.usage.settle(call, usage);
    reported = usage;
  });
  const correlation = await db.usage.correlation(call);
  const generated = await withProviderContext(
    { ...correlation, source: 'worker' },
    () => invoke(report),
  );
  await report(generated.usage);
  return generated;
}
