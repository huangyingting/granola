import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@windows-ai-notes/db';
import {
  resourceId,
  idempotencyKey,
  citationSchema,
} from '@windows-ai-notes/contracts/server';
import {
  chatSubmissionSchema,
  chatResumeSchema,
} from '@windows-ai-notes/contracts/questions';
import { principal } from './auth.js';
import { parse } from './parse.js';
import { streamEvents } from './events.js';

const idParams = z.strictObject({ id: resourceId });
const confirmed = z.strictObject({ confirmed: z.literal(true) });
export function registerChatRoutes(
  app: FastifyInstance,
  db: Database,
  streams: Map<string, number>,
  shutdown: AbortSignal,
) {
  app.get('/v1/chat-capabilities', async () => ({
    questions: 'durable-questions-v1',
    max_attempts: 3,
    max_pending_work: 8,
    history_context: 'meeting-question-context-v1',
  }));
  app.post(
    '/v1/documents/:id/chat-turns',
    { bodyLimit: 16_384 },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      return reply
        .code(202)
        .send(
          await db.chat.enqueue(
            principal(request).userId,
            id,
            parse(chatSubmissionSchema, request.body),
            parse(idempotencyKey, request.headers['idempotency-key']),
          ),
        );
    },
  );
  app.get('/v1/documents/:id/chat-threads', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(
      z.strictObject({
        offset: z.coerce.number().int().min(0).max(10_000).default(0),
      }),
      request.query,
    );
    return db.chat.threads(principal(request).userId, id, query.offset);
  });
  app.get('/v1/chat-threads/:id/turns', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(
      z.strictObject({
        after: z.coerce.number().int().min(0).max(100_000).default(0),
      }),
      request.query,
    );
    return db.chat.history(principal(request).userId, id, query.after);
  });
  app.delete('/v1/chat-threads/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    parse(confirmed, request.body);
    return db.chat.remove(principal(request).userId, id);
  });
  app.get('/v1/chat-turns/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.chat.get(principal(request).userId, id);
  });
  app.post('/v1/chat-turns/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params);
    parse(confirmed, request.body);
    return db.chat.cancel(principal(request).userId, id);
  });
  app.post('/v1/chat-turns/:id/resume', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(chatResumeSchema, request.body);
    return reply
      .code(202)
      .send(
        await db.chat.resume(principal(request).userId, id, body.resume_token),
      );
  });
  app.post('/v1/chat-turns/:id/citation', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.chat.source(
      principal(request).userId,
      id,
      parse(citationSchema, request.body),
    );
  });
  app.get('/v1/chat-turns/:id/event-state', async (request) => {
    const { id } = parse(idParams, request.params);
    return { turn: await db.chat.get(principal(request).userId, id) };
  });
  app.get('/v1/chat-turns/:id/events', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    return streamEvents(request, reply, streams, shutdown, (cursor) =>
      db.chat.events(principal(request).userId, id, cursor),
    );
  });
}
