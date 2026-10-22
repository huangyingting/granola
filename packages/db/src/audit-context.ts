import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { auditSourceSchema } from '@windows-ai-notes/contracts/audit';
import { resourceId } from '@windows-ai-notes/contracts/server';

const contextSchema = z.strictObject({
  source: auditSourceSchema,
  actor_id: resourceId.nullable().default(null),
  request_id: resourceId.nullable().default(null),
  job_id: resourceId.nullable().default(null),
  turn_id: resourceId.nullable().default(null),
});
type Context = z.infer<typeof contextSchema>;
const storage = new AsyncLocalStorage<Context>();
const system = contextSchema.parse({ source: 'system' });

export function withAuditContext<T>(
  context: z.input<typeof contextSchema>,
  operation: () => T,
): T {
  return storage.run(contextSchema.parse(context), operation);
}
export function auditTransactionContext(): Context {
  return { ...(storage.getStore() ?? system) };
}
export function setAuditActor(id: string) {
  const context = storage.getStore();
  if (!context) throw new Error('The authenticated audit context is missing.');
  context.actor_id = resourceId.parse(id);
}
export function setAuditTask(kind: 'job' | 'chat', id: string) {
  const context = storage.getStore();
  if (!context) throw new Error('The worker audit context is missing.');
  const parsed = resourceId.parse(id);
  context.job_id = kind === 'job' ? parsed : null;
  context.turn_id = kind === 'chat' ? parsed : null;
}
export function bindAuditContext<Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
) {
  const context = storage.getStore();
  return (...args: Args): Result =>
    context
      ? storage.run(context, () => operation(...args))
      : operation(...args);
}
