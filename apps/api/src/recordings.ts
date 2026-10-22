import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@windows-ai-notes/db';
import { RecordingBlobs } from '@windows-ai-notes/storage';
import {
  ServiceError,
  resourceId,
  idempotencyKey,
  finalizeTranscriptSchema,
} from '@windows-ai-notes/contracts/server';
import {
  createRecordingSchema,
  registerChunkSchema,
  recordingSealSchema,
  uploadAuthorizationSchema,
  recordingCapabilitiesSchema,
} from '@windows-ai-notes/contracts/uploads';
import { validateWav } from '@windows-ai-notes/ai/wav';
import { principal } from './auth.js';
import { parse } from './parse.js';
import { uploadObservability } from './upload-observability.js';

const idParams = z.strictObject({ id: resourceId });
const pageQuery = z.strictObject({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export async function cleanupRecordingObjects(
  db: Database,
  blobs: RecordingBlobs,
  signal: AbortSignal,
) {
  for (const object of await db.recordings.claimCleanup()) {
    try {
      await blobs.remove(
        object,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      await db.recordings.finishCleanup(object, true);
    } catch (error) {
      await db.recordings.finishCleanup(object, false);
      console.error(
        JSON.stringify({
          code: 'recording_cleanup_failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
      if (signal.aborted) break;
    }
  }
}

export function registerRecordingRoutes(
  app: FastifyInstance,
  db: Database,
  configured: RecordingBlobs | null,
) {
  const measurements = uploadObservability(app);
  const shutdown = new AbortController();
  let interval: NodeJS.Timeout | undefined;
  let maintenance: Promise<void> | null = null;
  const storage = () => {
    if (!configured)
      throw new ServiceError(
        'storage_not_configured',
        'The deployment administrator has not configured private recording storage.',
        503,
      );
    return configured;
  };
  if (configured) {
    app.addHook('onReady', async () => {
      await configured.assertReady();
      interval = setInterval(() => {
        if (maintenance) return;
        maintenance = cleanupRecordingObjects(db, configured, shutdown.signal)
          .catch((error: unknown) => {
            console.error(
              JSON.stringify({
                code: 'recording_cleanup_iteration_failed',
                kind: error instanceof Error ? error.name : 'unknown',
              }),
            );
          })
          .finally(() => {
            maintenance = null;
          });
      }, 30_000);
      interval.unref();
    });
    app.addHook('preClose', async () => {
      shutdown.abort();
      if (interval) clearInterval(interval);
      await maintenance;
    });
    app.addHook('onClose', async () => configured.close());
  }
  app.get('/v1/recording-capabilities', async () =>
    recordingCapabilitiesSchema.parse({
      enabled: configured !== null,
      max_chunk_bytes: 960_044,
      max_chunks: 10_000,
      upload_origin: configured
        ? new URL(configured.config.endpoint).origin
        : null,
      multipart: false,
    }),
  );
  app.post('/v1/documents/:id/recordings', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const input = parse(createRecordingSchema, request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    return reply
      .code(201)
      .send(
        await db.recordings.create(principal(request).userId, id, input, key),
      );
  });
  app.get('/v1/documents/:id/recordings', async (request) => {
    const { id } = parse(idParams, request.params);
    const { offset } = parse(pageQuery, request.query);
    return db.recordings.list(principal(request).userId, id, offset);
  });
  app.get('/v1/recordings/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.recordings.get(principal(request).userId, id);
  });
  app.get('/v1/recordings/:id/retention', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.recordings.retention(principal(request).userId, id);
  });
  app.get('/v1/recordings/:id/chunks', async (request) => {
    const { id } = parse(idParams, request.params);
    const { offset } = parse(pageQuery, request.query);
    return db.recordings.chunks(principal(request).userId, id, offset);
  });
  app.post('/v1/recordings/:id/finalize-transcript', async (request, reply) => {
    storage();
    const { id } = parse(idParams, request.params);
    const input = parse(finalizeTranscriptSchema, request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    return reply
      .code(202)
      .send(
        await db.enqueueRecordingTranscription(
          principal(request).userId,
          id,
          input,
          key,
        ),
      );
  });
  app.post('/v1/recordings/:id/chunks', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const input = parse(registerChunkSchema, request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    return reply
      .code(201)
      .send(
        await db.recordings.register(principal(request).userId, id, input, key),
      );
  });
  app.post(
    '/v1/recordings/:id/seal',
    { bodyLimit: 4 * 1024 * 1024 },
    async (request) => {
      const { id } = parse(idParams, request.params);
      const input = parse(recordingSealSchema, request.body);
      const key = parse(idempotencyKey, request.headers['idempotency-key']);
      return db.recordings.seal(principal(request).userId, id, input, key);
    },
  );
  app.get('/v1/audio-chunks/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.recordings.chunk(principal(request).userId, id);
  });
  app.post('/v1/audio-chunks/:id/upload', async (request) => {
    const { id } = parse(idParams, request.params);
    parse(z.strictObject({}), request.body);
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    const user = principal(request).userId;
    const blobs = storage();
    const grant = await db.recordings.authorizeUpload(user, id, key);
    if (!grant) return { state: 'verified', upload: null };
    const upload = await blobs.authorize(
      grant.object,
      grant.upload.size_bytes,
      grant.upload.sha256,
      grant.expires,
    );
    await db.recordings.chunk(user, id);
    return uploadAuthorizationSchema.parse({ state: 'pending', upload });
  });
  app.post('/v1/audio-chunks/:id/complete', async (request) => {
    const { id } = parse(idParams, request.params);
    const { upload_id } = parse(
      z.strictObject({ upload_id: resourceId }),
      request.body,
    );
    const key = parse(idempotencyKey, request.headers['idempotency-key']);
    const user = principal(request).userId;
    const blobs = storage();
    const lease = await db.recordings.beginVerification(
      user,
      id,
      upload_id,
      key,
    );
    if (!lease) return db.recordings.chunk(user, id);
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(30_000),
    ]);
    const measured = measurements.start(request.id);
    let bytes: Buffer | undefined;
    try {
      bytes = await blobs.read(lease.staging, lease.upload.size_bytes, signal);
      measured.stage('validate');
      if (
        bytes.length !== lease.upload.size_bytes ||
        createHash('sha256').update(bytes).digest('hex') !==
          lease.upload.sha256 ||
        createHash('sha256').update(bytes.subarray(44)).digest('hex') !==
          lease.upload.chunk.pcm_sha256
      )
        throw new ServiceError(
          'checksum_mismatch',
          'The uploaded WAV does not match its immutable chunk descriptor.',
          409,
        );
      validateWav(bytes);
      measured.stage('authorize');
      await db.recordings.get(user, lease.recordingId);
      measured.stage('promote');
      await blobs.promote(lease.candidate, bytes, signal);
      measured.stage('commit');
      const result = await db.recordings.finishVerification(user, lease);
      measured.verified(signal.aborted);
      return result;
    } catch (error) {
      measured.failed(error, signal.aborted);
      try {
        await db.recordings.failVerification(lease);
      } catch (failure) {
        console.error(
          JSON.stringify({
            code: 'recording_verification_release_failed',
            kind: failure instanceof Error ? failure.name : 'unknown',
          }),
        );
      }
      throw error;
    } finally {
      bytes?.fill(0);
    }
  });
  app.delete('/v1/recordings/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const user = principal(request).userId;
    await db.recordings.remove(user, id);
    return reply.code(202).send(await db.recordings.deletion(user, id));
  });
  app.get('/v1/recordings/:id/deletion', async (request) => {
    const { id } = parse(idParams, request.params);
    return db.recordings.deletion(principal(request).userId, id);
  });
  app.delete(
    '/v1/documents/:document/recordings/:id',
    async (request, reply) => {
      const { document, id } = parse(
        z.strictObject({ document: resourceId, id: resourceId }),
        request.params,
      );
      const user = principal(request).userId;
      await db.recordings.removeExpected(user, document, id);
      return reply.code(202).send(await db.recordings.deletion(user, id));
    },
  );
}
