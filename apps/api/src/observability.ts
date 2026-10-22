import type { FastifyInstance } from 'fastify';
import type { Writable } from 'node:stream';
import { boundedTelemetry } from '@windows-ai-notes/ai/telemetry';

const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export function registerRequestObservability(
  app: FastifyInstance,
  output: Writable = process.stdout,
) {
  const routes = new Set<string>();
  const telemetry = boundedTelemetry(output, 'http_request');
  app.addHook('onClose', async () => telemetry.close());
  app.addHook('onRoute', (route) => {
    routes.add(route.url);
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    telemetry.emit({
      code: 'http_request_completed',
      finished_at: new Date().toISOString(),
      request_id: request.id,
      method: methods.has(request.method) ? request.method : 'OTHER',
      route: route && routes.has(route) ? route : null,
      status_code: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    });
  });
}
