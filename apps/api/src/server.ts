import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { jobEventStateSchema } from '@windows-ai-notes/contracts/generation';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { SUMMARY_TEMPLATES } from '@windows-ai-notes/contracts/templates';
import {
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_TEXT_BYTES,
  LONG_SUMMARY_VERSION,
  ServiceError,
  createDocumentSchema,
  updateDocumentSchema,
  updateNotesSchema,
  updateTranscriptSchema,
  summaryRequestSchema,
  citationSchema,
  transcriptionQuerySchema,
  transcriptPageQuerySchema,
  applyTranscriptSchema,
  resourceId,
  idempotencyKey,
  syncSnapshotQuerySchema,
  syncChangesQuerySchema,
} from '@windows-ai-notes/contracts/server';
import {
  canonicalJson,
  exportMeetingStream,
} from '@windows-ai-notes/contracts/content';
import {
  withAuditContext,
  setAuditActor,
  isDatabaseUnavailable,
  type Database,
} from '@windows-ai-notes/db';
import { validateWav } from '@windows-ai-notes/ai/wav';
import {
  createAuthenticator,
  principal,
  trustedProxyCidrs,
  type AuthConfig,
} from './auth.js';
import type { RecordingBlobs } from '@windows-ai-notes/storage';
import { registerRecordingRoutes } from './recordings.js';
import { parse } from './parse.js';
import type { RealtimeProvider } from '@windows-ai-notes/ai/realtime';
import { prepareRealtimeRoutes } from './realtime.js';
import { registerChatRoutes } from './chat.js';
import { streamEvents } from './events.js';
import { registerRequestObservability } from './observability.js';

const idParams = z.strictObject({ id: resourceId });
const revisionQuery = z.strictObject({
  revision: z.coerce.number().int().positive().optional(),
});
const listQuery = z.strictObject({
  workspace_id: resourceId,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const entityTag = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/gu;
const entityTagList =
  /^[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"(?:[ \t]*,[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")*[ \t]*$/u;
function notModified(value: string | undefined, etag: string) {
  if (!value) return false;
  if (/^[ \t]*\*[ \t]*$/u.test(value)) return true;
  return (
    entityTagList.test(value) &&
    [...value.matchAll(entityTag)].some(
      ([tag]) => (tag.startsWith('W/') ? tag.slice(2) : tag) === etag,
    )
  );
}

export async function createServer(
  db: Database,
  config: AuthConfig,
  storage: RecordingBlobs | null = null,
  realtime: RealtimeProvider | null = null,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_AUDIO_BYTES,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    requestTimeout: 30_000,
    trustProxy: trustedProxyCidrs(config.trustedProxies),
  });
  registerRequestObservability(app);
  const authenticate = createAuthenticator(config, db);
  const streams = new Map<string, number>();
  const shutdown = new AbortController();
  // An aborted fetch can leave a replacement TCP connection without an HTTP request.
  const unusedConnections = new Set<Socket>();
  app.server.on('connection', (socket) => {
    if (socket.bytesRead !== 0) return;
    if (shutdown.signal.aborted) {
      socket.destroy();
      return;
    }
    unusedConnections.add(socket);
    const forget = () => unusedConnections.delete(socket);
    socket.once('data', forget);
    socket.once('close', forget);
  });
  const assertNotStopping = () => {
    if (shutdown.signal.aborted)
      throw new ServiceError(
        'service_unavailable',
        'The API is shutting down.',
        503,
        true,
      );
  };
  app.addHook('onReady', async () => db.assertReady(shutdown.signal));
  app.addHook('preClose', async () => {
    shutdown.abort();
    for (const socket of unusedConnections)
      if (socket.bytesRead === 0) socket.destroy();
    unusedConnections.clear();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (shutdown.signal.aborted) reply.header('Connection', 'close');
    return payload;
  });
  // Track upgrades before authentication so rejected requests close their raw sockets.
  const registerRealtime = await prepareRealtimeRoutes(app, db, realtime);
  app.decorateRequest('principal', null);
  app.addHook('onRequest', (request, _reply, done) =>
    withAuditContext({ source: 'api', request_id: request.id }, done),
  );
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const limitUnmatched = app.rateLimit();
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .header('X-Request-ID', request.id);
    if (request.is404) await limitUnmatched.call(app, request, reply);
  });
  // Authenticate after onRequest admission, but before consuming the payload.
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (
      !['/health', '/health/live', '/v1/client-config'].includes(
        request.routeOptions.url ?? '',
      )
    ) {
      request.principal = await authenticate(request);
      setAuditActor(request.principal.userId);
    }
    return payload;
  });
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
    if (isDatabaseUnavailable(error)) {
      console.error(
        JSON.stringify({
          code: 'database_unavailable',
          request_id: request.id,
        }),
      );
      return reply.code(503).send({
        code: 'database_unavailable',
        message: 'The database is temporarily unavailable. Retry this request.',
        retryable: true,
        request_id: request.id,
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
        kind: error instanceof Error ? 'error' : 'unknown',
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
  registerRealtime();
  registerRecordingRoutes(app, db, storage);
  registerChatRoutes(app, db, streams, shutdown.signal);
  app.get(
    '/health',
    { config: { rateLimit: { groupId: 'health/readiness' } } },
    async () => {
      assertNotStopping();
      try {
        await db.checkHealth();
      } catch {
        throw new ServiceError(
          'database_unavailable',
          'Database health check failed.',
          503,
          true,
        );
      }
      assertNotStopping();
      return { status: 'ok' };
    },
  );
  app.get(
    '/health/live',
    { config: { rateLimit: { groupId: 'health/liveness' } } },
    async () => ({ status: 'ok' }),
  );
  app.get('/v1/me', async (request) => ({ id: principal(request).userId }));
  app.get('/v1/usage', async (request) =>
    db.usage.snapshot(principal(request).userId),
  );
  app.get('/v1/client-config', async () => {
    if (config.mode !== 'oidc' || !config.desktop)
      throw new ServiceError(
        'desktop_login_not_configured',
        'The deployment administrator has not configured native-client OIDC login.',
        503,
      );
    return config.desktop;
  });
  app.get('/v1/workspaces', async (request) => ({
    workspaces: await db.workspaces(principal(request).userId),
  }));
  app.get('/v1/models', async () => ({
    provider: 'azure',
    summary_model: 'deployment-default',
    speech_model: 'azure-fast-transcription',
    max_audio_seconds: 60,
    live_transcription: {
      configured: realtime !== null,
      max_media_seconds: 60,
      max_unfinalized_seconds: 5,
      canonical: false,
      automatic_reconnect: false,
      profiles: realtime?.profiles ?? [],
    },
    recording_transcription: {
      storage_configured: storage !== null,
      max_chunk_audio_seconds: 30,
      max_track_audio_seconds: 4 * 60 * 60,
      max_transcript_segments: MAX_TRANSCRIPT_SEGMENTS,
      max_transcript_text_bytes: MAX_TRANSCRIPT_TEXT_BYTES,
    },
    max_summary_context_bytes: 48_000,
    locales: ['en-US', 'zh-CN'],
  }));
  app.get('/v1/templates', async () => ({
    templates: SUMMARY_TEMPLATES,
  }));
  app.get('/v1/summary-capabilities', async () => ({
    long_meetings: LONG_SUMMARY_VERSION,
  }));
  app.get('/v1/sync/snapshot', async (request) => {
    const query = parse(syncSnapshotQuerySchema, request.query);
    return db.sync.snapshot(
      principal(request).userId,
      query.workspace_id,
      query.cursor,
      query.after,
      query.limit,
    );
  });
  app.get('/v1/sync/changes', async (request) => {
    const query = parse(syncChangesQuerySchema, request.query);
    return db.sync.changes(
      principal(request).userId,
      query.workspace_id,
      query.cursor,
      query.limit,
    );
  });
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
      body,
      optionalMutationKey(request.headers['idempotency-key']),
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
      body,
      optionalMutationKey(request.headers['idempotency-key']),
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
  app.get('/v1/documents/:id/jobs', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const query = parse(
      z.strictObject({
        limit: z.coerce.number().int().min(1).max(20).default(10),
        offset: z.coerce.number().int().min(0).max(10_000).default(0),
      }),
      request.query,
    );
    const body = canonicalJson({
      jobs: await db.jobs(
        principal(request).userId,
        id,
        query.limit,
        query.offset,
      ),
    });
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    reply.header('ETag', etag);
    if (notModified(request.headers['if-none-match'], etag))
      return reply.code(304).send();
    return reply.type('application/json').send(body);
  });
  app.get('/v1/documents/:id/export', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const query = parse(
      z.strictObject({
        format: z.enum(['markdown', 'text']).default('markdown'),
        timestamps: z.enum(['true', 'false']).default('true'),
      }),
      request.query,
    );
    const user = principal(request).userId;
    const document = await db.document(user, id);
    const first = await db.transcripts.page(
      user,
      id,
      document.transcript_revision,
    );
    async function* segments() {
      let page = first;
      while (true) {
        yield* page.segments;
        if (!page.has_more) return;
        page = await db.transcripts.page(
          user,
          id,
          first.revision,
          page.offset + page.segments.length,
        );
      }
    }
    const content = exportMeetingStream(
      {
        ...document,
        ...(first.recording ? { recording: first.recording } : {}),
      },
      segments(),
      query.format,
      query.timestamps === 'true',
    );
    return reply
      .header(
        'Content-Type',
        query.format === 'markdown'
          ? 'text/markdown; charset=utf-8'
          : 'text/plain; charset=utf-8',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="meeting-${id}.${query.format === 'markdown' ? 'md' : 'txt'}"`,
      )
      .send(Readable.from(content));
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
  app.get('/v1/documents/:id/transcript/pages', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(transcriptPageQuerySchema, request.query);
    return db.transcripts.page(
      principal(request).userId,
      id,
      query.revision,
      query.offset,
    );
  });
  app.get('/v1/documents/:id/transcript/timeline', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(transcriptPageQuerySchema, request.query);
    const selected =
      query.revision ??
      (await db.document(principal(request).userId, id)).transcript_revision;
    return db.transcripts.timeline(
      principal(request).userId,
      id,
      selected,
      query.offset,
    );
  });
  app.post('/v1/documents/:id/transcript/apply', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(applyTranscriptSchema, request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    return db.transcripts.apply(
      principal(request).userId,
      id,
      input.base_revision,
      input.source_revision,
      key,
    );
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
  app.get('/v1/jobs/:id/summary-progress', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.summaries.progress(principal(request).userId, id);
  });
  app.post('/v1/jobs/:id/citation', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.summarySource(
      principal(request).userId,
      id,
      parse(citationSchema, request.body),
    );
  });
  app.post('/v1/jobs/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.cancel(principal(request).userId, id);
  });
  app.post('/v1/jobs/:id/retry', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.strictObject({
        confirmed: z.literal(true),
        resume_token: z.uuid().optional(),
      }),
      request.body,
    );
    const user = principal(request).userId;
    const job = await db.job(user, id);
    if (job.kind === 'summary') {
      if (!body.resume_token)
        throw new ServiceError(
          'summary_resume_required',
          'Refresh summary progress and confirm its resume token before retrying.',
          400,
        );
      return db.summaries.resume(user, id, body.resume_token);
    }
    if (body.resume_token)
      throw new ServiceError(
        'unsupported_retry',
        'Summary resume consent cannot be used for an audio job.',
        409,
      );
    return db.retryRecordingTranscription(user, id);
  });
  app.get('/v1/jobs/:id/event-state', async (request) => {
    const { id } = parse(idParams, request.params);
    return jobEventStateSchema.parse(
      await db.eventState(principal(request).userId, id),
    );
  });
  app.get('/v1/jobs/:id/events', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    return streamEvents(request, reply, streams, shutdown.signal, (cursor) =>
      db.events(principal(request).userId, id, cursor),
    );
  });
  return app;
}

function optionalMutationKey(value: unknown): string | undefined {
  return value === undefined ? undefined : parse(idempotencyKey, value);
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
