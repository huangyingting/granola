import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import type { Database } from '@windows-ai-notes/db';

export function loadWorkerHealthPort(env: NodeJS.ProcessEnv = process.env) {
  const value = env.WORKER_HEALTH_PORT;
  if (value === undefined) return undefined;
  const port = Number(value);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== value
  )
    throw new ServiceError(
      'worker_health_configuration_invalid',
      'WORKER_HEALTH_PORT must be an integer between 1 and 65535.',
      400,
    );
  return port;
}

export async function startWorkerHealth(
  port: number,
  db: Pick<Database, 'checkHealth'>,
  signal: AbortSignal,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024,
    requestTimeout: 3000,
    connectionTimeout: 3000,
    keepAliveTimeout: 1000,
    requestIdHeader: false,
  });
  let initialized = false;
  let closing = false;
  const ready = () => initialized && !closing && !signal.aborted;
  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff');
    if (closing || signal.aborted) reply.header('Connection', 'close');
    return payload;
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ status: 'unavailable' }),
  );
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 503;
    return reply.code(status).send({ status: 'unavailable' });
  });
  app.get(
    '/health',
    { config: { rateLimit: { groupId: 'health/readiness' } } },
    async (_request, reply) => {
      if (!ready()) return reply.code(503).send({ status: 'unavailable' });
      try {
        await db.checkHealth();
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
      return ready()
        ? { status: 'ok' }
        : reply.code(503).send({ status: 'unavailable' });
    },
  );
  app.get(
    '/health/live',
    { config: { rateLimit: { groupId: 'health/liveness' } } },
    async () => ({ status: 'ok' }),
  );
  let url: string;
  try {
    url = await app.listen({ host: '127.0.0.1', port });
  } catch {
    await app.close();
    throw new ServiceError(
      'worker_health_listen_failed',
      'The loopback Worker health listener could not start.',
      500,
    );
  }
  return {
    url,
    markReady() {
      if (closing || signal.aborted)
        throw new ServiceError(
          'worker_health_stopping',
          'A stopping Worker cannot become ready.',
          409,
        );
      initialized = true;
    },
    async close() {
      closing = true;
      await app.close();
    },
  };
}
