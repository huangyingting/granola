import type { FastifyInstance } from 'fastify';
import type { Writable } from 'node:stream';

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
  let dropped = 0n;
  let waiting = false;
  let failed = false;
  const droppedRecord = () => ({
    code: 'http_request_telemetry_dropped',
    finished_at: new Date().toISOString(),
    count: dropped.toString(),
  });
  const drain = () => {
    waiting = false;
    if (!dropped || failed) return;
    const record = droppedRecord();
    dropped = 0n;
    write(record);
  };
  function awaitDrain() {
    if (waiting) return;
    waiting = true;
    output.once('drain', drain);
  }
  function write(record: object) {
    if (!output.write(`${JSON.stringify(record)}\n`)) awaitDrain();
  }
  const unavailable = () => {
    failed = true;
    console.error(
      JSON.stringify({
        code: 'http_request_telemetry_unavailable',
        finished_at: new Date().toISOString(),
      }),
    );
  };
  output.on('error', unavailable);
  if (!output.writable) unavailable();
  app.addHook('onClose', async () => {
    output.off('drain', drain);
    output.off('error', unavailable);
    if (dropped) console.error(JSON.stringify(droppedRecord()));
  });
  app.addHook('onRoute', (route) => {
    routes.add(route.url);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (failed || output.writableNeedDrain) {
      dropped++;
      if (!failed) awaitDrain();
      return;
    }
    const route = request.routeOptions.url;
    write({
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
