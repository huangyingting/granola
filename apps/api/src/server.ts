import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  MAX_AUDIO_BYTES,
  ServiceError,
  createDocumentSchema,
  updateDocumentSchema,
  updateNotesSchema,
  updateTranscriptSchema,
  summaryRequestSchema,
  transcriptionQuerySchema,
  resourceId,
  idempotencyKey,
} from '@windows-ai-notes/contracts/server';
import type { Database } from '@windows-ai-notes/db';
import { validateWav } from '@windows-ai-notes/ai/wav';
import { createAuthenticator, principal, type AuthConfig } from './auth.js';

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ServiceError(
      'invalid_request',
      'The request does not match the documented contract.',
      400,
    );
  return result.data;
}
const idParams = z.strictObject({ id: resourceId });
const revisionQuery = z.strictObject({
  revision: z.coerce.number().int().positive().optional(),
});
const listQuery = z.strictObject({
  workspace_id: resourceId,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export async function createServer(db: Database, config: AuthConfig) {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_AUDIO_BYTES,
    genReqId: () => randomUUID(),
    requestTimeout: 30_000,
  });
  const authenticate = createAuthenticator(config, db);
  const streams = new Map<string, number>();
  const shutdown = new AbortController();
  app.addHook('preClose', async () => shutdown.abort());
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store');
    if (request.routeOptions.url !== '/health')
      request.principal = await authenticate(request);
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addContentTypeParser(
    'audio/wav',
    { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      if (error.status === 401) reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(error.status).send({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        request_id: request.id,
        ...error.details,
      });
    }
    const status =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        code: status === 429 ? 'rate_limited' : 'invalid_request',
        message:
          status === 413
            ? 'The request body exceeds the configured limit.'
            : 'The request could not be accepted.',
        retryable: status === 429,
        request_id: request.id,
      });
    }
    console.error(
      JSON.stringify({
        code: 'internal_error',
        request_id: request.id,
        kind: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return reply.code(500).send({
      code: 'internal_error',
      message: 'The server could not complete this request.',
      retryable: false,
      request_id: request.id,
    });
  });
  app.setNotFoundHandler(() => {
    throw new ServiceError(
      'route_not_found',
      'The requested API route does not exist.',
      404,
    );
  });
  app.get('/health', async () => {
    try {
      await db.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceError(
        'database_unavailable',
        'Database health check failed.',
        503,
        true,
      );
    }
  });
  app.get('/v1/me', async (request) => ({ id: principal(request).userId }));
  app.get('/v1/workspaces', async (request) => ({
    workspaces: await db.workspaces(principal(request).userId),
  }));
  app.get('/v1/models', async () => ({
    provider: 'azure',
    summary_model: 'deployment-default',
    speech_model: 'azure-fast-transcription',
    max_audio_seconds: 60,
    max_summary_context_bytes: 48_000,
    locales: ['en-US', 'zh-CN'],
  }));
  app.get('/v1/templates', async () => ({
    templates: [{ id: 'meeting-summary-v1', name: 'Meeting summary' }],
  }));
  app.post('/v1/documents', async (request, reply) => {
    const body = parse(createDocumentSchema, request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    const doc = await db.createDocument(principal(request).userId, body, key);
    return reply.code(201).header('ETag', `"${doc.revision}"`).send(doc);
  });
  app.get('/v1/documents', async (request) => {
    const query = parse(listQuery, request.query);
    return {
      documents: await db.listDocuments(
        principal(request).userId,
        query.workspace_id,
        query.limit,
        query.offset,
      ),
    };
  });
  app.get('/v1/documents/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const doc = await db.document(principal(request).userId, id);
    return reply.header('ETag', `"${doc.revision}"`).send(doc);
  });
  app.patch('/v1/documents/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(updateDocumentSchema, request.body);
    checkMatch(request.headers['if-match'], body.base_revision);
    const doc = await db.edit(
      principal(request).userId,
      id,
      body.base_revision,
      { title: body.title },
    );
    return reply.header('ETag', `"${doc.revision}"`).send(doc);
  });
  app.put('/v1/documents/:id/notes', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(updateNotesSchema, request.body);
    checkMatch(request.headers['if-match'], body.base_revision);
    const doc = await db.edit(
      principal(request).userId,
      id,
      body.base_revision,
      { notes: body.notes },
    );
    return reply.header('ETag', `"${doc.revision}"`).send(doc);
  });
  app.get('/v1/documents/:id/notes', async (request) => {
    const { id } = parse(idParams, request.params);
    const { revision } = parse(revisionQuery, request.query);
    const user = principal(request).userId;
    return db.notes(
      user,
      id,
      revision ?? (await db.document(user, id)).revision,
    );
  });
  app.delete('/v1/documents/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await db.deleteDocument(principal(request).userId, id);
    return reply.code(204).send();
  });
  app.get('/v1/documents/:id/transcript', async (request) => {
    const { id } = parse(idParams, request.params);
    const { revision } = parse(revisionQuery, request.query);
    return db.transcript(principal(request).userId, id, revision);
  });
  app.put('/v1/documents/:id/transcript', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(updateTranscriptSchema, request.body);
    return db.editTranscript(
      principal(request).userId,
      id,
      body.base_revision,
      body.segments,
    );
  });
  app.post('/v1/documents/:id/summary-runs', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(summaryRequestSchema, request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    return reply
      .code(202)
      .send(await db.enqueueSummary(principal(request).userId, id, body, key));
  });
  app.post('/v1/documents/:id/transcription-runs', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const query = parse(transcriptionQuerySchema, request.query);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    if (!Buffer.isBuffer(request.body))
      throw new ServiceError(
        'invalid_audio',
        'Send a raw audio/wav body.',
        415,
      );
    const duration = validateWav(request.body);
    return reply
      .code(202)
      .send(
        await db.enqueueTranscription(
          principal(request).userId,
          id,
          query.base_revision,
          query.locale,
          duration,
          request.body,
          key,
        ),
      );
  });
  app.get('/v1/jobs/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.job(principal(request).userId, id);
  });
  app.post('/v1/jobs/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.cancel(principal(request).userId, id);
  });
  app.get('/v1/jobs/:id/events', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const identity = principal(request);
    const rawCursor = request.headers['last-event-id'];
    let cursor =
      rawCursor === undefined
        ? 0
        : Number(parse(z.string().regex(/^\d+$/).max(10), rawCursor));
    if (!Number.isSafeInteger(cursor) || cursor > 2_147_483_647)
      throw new ServiceError(
        'invalid_event_cursor',
        'Invalid event sequence.',
        400,
      );
    await db.events(identity.userId, id, cursor);
    if ((streams.get(identity.userId) ?? 0) >= 2)
      throw new ServiceError(
        'quota_exceeded',
        'At most two event subscriptions are allowed per user.',
        429,
        true,
      );
    streams.set(identity.userId, (streams.get(identity.userId) ?? 0) + 1);
    const closed = new AbortController();
    const signal = AbortSignal.any([closed.signal, shutdown.signal]);
    reply.raw.once('close', () => closed.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    });
    try {
      while (!signal.aborted && Date.now() < identity.expiresAt) {
        const batch = await db.events(identity.userId, id, cursor);
        for (const event of batch.events) {
          if (signal.aborted || Date.now() >= identity.expiresAt) break;
          if (
            !reply.raw.write(
              `id: ${event.seq}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
          ) {
            await once(reply.raw, 'drain', { signal });
          }
          cursor = event.seq;
        }
        if (batch.terminal) break;
        await delay(500, undefined, { signal });
      }
    } catch (error) {
      if (
        !(
          error instanceof ServiceError &&
          [401, 403, 404].includes(error.status)
        ) &&
        !(error instanceof Error && error.name === 'AbortError')
      ) {
        console.error(
          JSON.stringify({
            code: 'event_stream_failed',
            request_id: request.id,
          }),
        );
      }
    } finally {
      const remaining = (streams.get(identity.userId) ?? 1) - 1;
      if (remaining > 0) streams.set(identity.userId, remaining);
      else streams.delete(identity.userId);
      reply.raw.end();
    }
  });
  return app;
}

function checkMatch(value: string | string[] | undefined, base: number) {
  if (value !== undefined && value !== `"${base}"`) {
    throw new ServiceError(
      'invalid_revision',
      'If-Match must agree with base_revision.',
      400,
    );
  }
}
