import { usageSchema, type Usage } from '@windows-ai-notes/contracts/server';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import type { Database } from '@windows-ai-notes/db';
import type { UsageReporter } from '@windows-ai-notes/ai';

export async function withUsage<T extends { usage: Usage }>(
  db: Database,
  call: string,
  invoke: (report: UsageReporter) => Promise<T>,
): Promise<T> {
  let reported: Usage | null = null;
  const report: UsageReporter = async (value) => {
    const parsed = usageSchema.parse(value);
    const usage = { ...parsed, audio_ms: Math.ceil(parsed.audio_ms) };
    if (reported && canonicalJson(reported) === canonicalJson(usage)) return;
    await db.usage.settle(call, usage);
    reported = usage;
  };
  const generated = await invoke(report);
  await report(generated.usage);
  return generated;
}
