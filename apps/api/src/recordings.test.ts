import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import { Database } from '@windows-ai-notes/db';
import {
  RecordingBlobs,
  objectKey,
  type StorageConfig,
} from '@windows-ai-notes/storage';
import { makeSilentWav } from '@windows-ai-notes/ai/wav';
import type { AiProviders } from '@windows-ai-notes/ai';
import {
  ServiceError,
  jobSchema,
  segmentsSchema,
  transcriptPageSchema,
  transcriptTimelinePageSchema,
} from '@windows-ai-notes/contracts/server';
import { runOnce } from '@windows-ai-notes/worker';
import {
  remoteRecordingSchema,
  remoteChunkSchema,
  uploadAuthorizationSchema,
  type CreateRecording,
  type RecordingSeal,
} from '@windows-ai-notes/contracts/uploads';
import type { UploadChunk } from '@windows-ai-notes/contracts';
import { createServer } from './server.js';
import { cleanupRecordingObjects } from './recordings.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!databaseUrl || !endpoint)(
  'real PostgreSQL, private S3 uploads and immutable recording verification',
  () => {
    const schema = `notes_recordings_${randomUUID().replaceAll('-', '')}`;
    const bucket = `notes-recordings-${randomUUID()}`;
    const config: StorageConfig = {
      endpoint: endpoint ?? 'http://127.0.0.1:59000',
      region: 'us-east-1',
      bucket,
      encryption: 'none',
      credentials: {
        accessKeyId: 'storage-test-only',
        secretAccessKey: 'storage-test-only-secret',
      },
    };
    const s3 = new S3Client({
      ...config,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    let admin: Database;
    let db: Database;
    let blobs: RecordingBlobs;
    let app: Awaited<ReturnType<typeof createServer>>;
    let bucketCreated = false;
    let schemaCreated = false;
    beforeAll(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketCreated = true;
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
      await db.assertReady();
    }, 30_000);
    beforeEach(async () => {
      blobs = new RecordingBlobs(config);
      app = await createServer(
        db,
        { mode: 'development', host: '127.0.0.1' },
        blobs,
      );
      await app.ready();
    });
    afterEach(async () => {
      await app?.close();
      blobs?.close();
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        if (schemaCreated)
          await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
      if (!bucketCreated) {
        s3.destroy();
        return;
      }
      let continuation: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ...(continuation ? { ContinuationToken: continuation } : {}),
          }),
        );
        for (const object of page.Contents ?? [])
          if (object.Key)
            await s3.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
            );
        continuation = page.NextContinuationToken;
      } while (continuation);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      s3.destroy();
    });
    async function context(twoTracks = false) {
      const subject = randomUUID();
      const actor = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const headers = { 'x-dev-subject': subject };
      const doc = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic audio meeting',
          notes: '',
        },
        randomUUID(),
      );
      const input: CreateRecording = {
        id: randomUUID(),
        created_at: new Date().toISOString(),
        tracks: [
          {
            spec: {
              track_id: randomUUID(),
              kind: 'microphone',
              capture_scope: 'endpoint',
              device_selection_policy: 'explicit',
              device_id: 'synthetic-microphone',
            },
            actual_device_id: 'synthetic-microphone',
          },
        ],
      };
      const key = randomUUID();
      if (twoTracks)
        input.tracks.push({
          spec: {
            track_id: randomUUID(),
            kind: 'loopback',
            capture_scope: 'endpoint',
            device_selection_policy: 'explicit',
            device_id: 'synthetic-output',
          },
          actual_device_id: 'synthetic-output',
        });
      const response = await app.inject({
        method: 'POST',
        url: `/v1/documents/${doc.id}/recordings`,
        headers: { ...headers, 'idempotency-key': key },
        payload: input,
      });
      expect(response.statusCode).toBe(201);
      const recording = remoteRecordingSchema.parse(response.json());
      const wav = makeSilentWav();
      const chunk = (sequence = 0, trackIndex = 0): UploadChunk => ({
        chunk: {
          format_version: 1,
          recording_id: input.id,
          track_id: input.tracks[trackIndex]!.spec.track_id,
          chunk_id: randomUUID(),
          capture_epoch: randomUUID(),
          sequence,
          sample_start: sequence * 16000,
          sample_count: 16000,
          sample_rate: 16000,
          channels: 1,
          bits_per_sample: 16,
          clock_start_ms: sequence * 1000,
          clock_end_ms: (sequence + 1) * 1000,
          pcm_sha256: createHash('sha256')
            .update(wav.subarray(44))
            .digest('hex'),
        },
        size_bytes: wav.length,
        sha256: createHash('sha256').update(wav).digest('hex'),
      });
      return { ...actor, headers, doc, input, key, recording, wav, chunk };
    }
    it('tombstones an uncertain creation before it exists, and late retries cannot resurrect it', async () => {
      const c = await context();
      const id = randomUUID();
      const request = {
        method: 'DELETE' as const,
        url: `/v1/documents/${c.doc.id}/recordings/${id}`,
        headers: c.headers,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({
          state: 'cleanup_confirmed',
          pending_objects: 0,
          repeated_cleanup: true,
        });
      }
      const late = await app.inject({
        method: 'POST',
        url: `/v1/documents/${c.doc.id}/recordings`,
        headers: { ...c.headers, 'idempotency-key': `recording:${id}` },
        payload: { ...c.input, id },
      });
      expect(late.statusCode).toBe(409);
      await expect(db.recordings.get(c.user_id, id)).rejects.toThrow();
      expect(
        (await db.recordings.list(c.user_id, c.doc.id, 0)).recordings.map(
          (r) => r.id,
        ),
      ).not.toContain(id);
    });
    it('serializes document-scoped deletion with concurrent creation', async () => {
      const c = await context();
      const id = randomUUID();
      const [created, deleted] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/v1/documents/${c.doc.id}/recordings`,
          headers: { ...c.headers, 'idempotency-key': `recording:${id}` },
          payload: { ...c.input, id },
        }),
        app.inject({
          method: 'DELETE',
          url: `/v1/documents/${c.doc.id}/recordings/${id}`,
          headers: c.headers,
        }),
      ]);
      expect([201, 409]).toContain(created.statusCode);
      expect(deleted.statusCode).toBe(202);
      await expect(db.recordings.get(c.user_id, id)).rejects.toThrow();
    });
    it('does not tombstone another owner or document recording identity', async () => {
      const c = await context(),
        other = await context();
      const sibling = await db.createDocument(
        c.user_id,
        {
          workspace_id: c.workspace_id,
          title: 'Another synthetic meeting',
          notes: '',
        },
        randomUUID(),
      );
      for (const [document, headers] of [
        [other.doc.id, other.headers],
        [sibling.id, c.headers],
        [c.doc.id, other.headers],
      ] as const) {
        const response = await app.inject({
          method: 'DELETE',
          url: `/v1/documents/${document}/recordings/${c.input.id}`,
          headers,
        });
        expect(response.statusCode).toBe(404);
      }
      expect((await db.recordings.get(c.user_id, c.input.id)).id).toBe(
        c.input.id,
      );
    });
    type Context = Awaited<ReturnType<typeof context>>;
    async function register(
      c: Context,
      upload = c.chunk(),
      key = randomUUID(),
    ) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/recordings/${c.input.id}/chunks`,
        headers: { ...c.headers, 'idempotency-key': key },
        payload: upload,
      });
      expect(response.statusCode).toBe(201);
      return { ...remoteChunkSchema.parse(response.json()), key };
    }
    async function authorize(c: Context, id: string, key = randomUUID()) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/audio-chunks/${id}/upload`,
        headers: { ...c.headers, 'idempotency-key': key },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const grant = uploadAuthorizationSchema.parse(response.json()).upload;
      expect(grant).not.toBeNull();
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(grant!.headers))
        if (value !== undefined) headers[name] = value;
      return { ...grant!, headers, key };
    }
    async function put(
      grant: Awaited<ReturnType<typeof authorize>>,
      wav: Buffer,
    ) {
      const response = await fetch(grant.url, {
        method: 'PUT',
        headers: grant.headers,
        body: new Uint8Array(wav),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
    }
    function complete(
      c: Context,
      id: string,
      uploadId: string,
      key = randomUUID(),
    ) {
      return app.inject({
        method: 'POST',
        url: `/v1/audio-chunks/${id}/complete`,
        headers: { ...c.headers, 'idempotency-key': key },
        payload: { upload_id: uploadId },
      });
    }
    function seal(c: Context, chunks: UploadChunk[]): RecordingSeal {
      return {
        native_state: 'sealed',
        accept_incomplete: false,
        tracks: [
          {
            track_id: c.input.tracks[0]!.spec.track_id,
            end_sample: chunks.length * 16000,
            chunk_ids: chunks.map((v) => v.chunk.chunk_id),
          },
        ],
        events: [],
        gaps: [],
      };
    }
    describe('complete-recording transcription with the real private store', () => {
      afterEach(async () => {
        vi.restoreAllMocks();
        await db.pool.query(
          "UPDATE jobs SET state='cancelled',lease_token=lease_token+1 WHERE state IN ('queued','running','retry_wait')",
        );
        await db.pool.query(
          "DELETE FROM recording_transcription_runs WHERE job_id IN (SELECT id FROM jobs WHERE state='cancelled')",
        );
      });
      function provider(
        transcribe: AiProviders['transcribe'] = async () => ({
          segments: [
            {
              id: randomUUID(),
              start_ms: 100,
              end_ms: 700,
              text: 'Synthetic recognized speech.',
            },
          ],
          usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
        }),
      ): AiProviders {
        return {
          provider: 'fixture',
          configurationVersion: 'recording-fixture-v1',
          transcribe,
          summarize: async () => {
            throw new Error(
              'A recording job must not call the summary provider.',
            );
          },
        };
      }
      async function ready(
        c: Context,
        count = 2,
        duration = 1000,
        partial = false,
      ) {
        const wav = makeSilentWav(duration);
        const uploads: UploadChunk[] = [];
        for (let track = 0; track < c.input.tracks.length; track++)
          for (let sequence = 0; sequence < count; sequence++) {
            const upload = c.chunk(sequence, track);
            Object.assign(upload.chunk, {
              sample_start: sequence * duration * 16,
              sample_count: duration * 16,
              clock_start_ms: sequence * (duration + 3000),
              clock_end_ms: sequence * (duration + 3000) + duration,
              pcm_sha256: createHash('sha256')
                .update(wav.subarray(44))
                .digest('hex'),
            });
            upload.size_bytes = wav.length;
            upload.sha256 = createHash('sha256').update(wav).digest('hex');
            await register(c, upload);
            const grant = await authorize(c, upload.chunk.chunk_id);
            await put(grant, wav);
            expect(
              (await complete(c, upload.chunk.chunk_id, grant.id)).statusCode,
            ).toBe(200);
            uploads.push(upload);
          }
        const frozen: RecordingSeal = {
          native_state: partial ? 'failed' : 'sealed',
          accept_incomplete: partial,
          tracks: c.input.tracks.map(({ spec }) => ({
            track_id: spec.track_id,
            end_sample: count * duration * 16,
            chunk_ids: uploads
              .filter((upload) => upload.chunk.track_id === spec.track_id)
              .map((upload) => upload.chunk.chunk_id),
          })),
          events: [
            {
              event_type: 'capture.started',
              clock_ms: 0,
              capture_epoch: uploads[0]!.chunk.capture_epoch,
              code: null,
            },
          ],
          gaps:
            count > 1
              ? c.input.tracks.map(({ spec }) => ({
                  track_id: spec.track_id,
                  start_ms: duration,
                  end_ms: duration + 3000,
                  reason: 'paused' as const,
                }))
              : [],
        };
        await db.recordings.seal(c.user_id, c.input.id, frozen, randomUUID());
        return { uploads, frozen, wav };
      }
      async function enqueue(c: Context, key = randomUUID(), accept = false) {
        const source = await db.recordings.get(c.user_id, c.input.id);
        const response = await app.inject({
          method: 'POST',
          url: `/v1/recordings/${c.input.id}/finalize-transcript`,
          headers: { ...c.headers, 'idempotency-key': key },
          payload: {
            base_revision: 0,
            locale: 'en-US',
            seal_sha256: source.seal_sha256,
            accept_incomplete: accept,
          },
        });
        expect(response.statusCode).toBe(202);
        return jobSchema.parse(response.json());
      }
      it('processes audio beyond the short-clip window and publishes every long transcript segment with immutable provenance', async () => {
        const c = await context();
        const source = await ready(c, 3, 30_000);
        const job = await enqueue(c);
        const buffers: Buffer[] = [];
        const transcribe = vi.fn<AiProviders['transcribe']>(async (bytes) => {
          buffers.push(bytes);
          expect(bytes.length).toBe(960_044);
          return {
            segments: Array.from({ length: 400 }, (_, index) => ({
              id: randomUUID(),
              start_ms: index * 50,
              end_ms: index * 50 + 40,
              text: `Phrase ${index}: ${'speech '.repeat(15)}`,
            })),
            usage: { input_tokens: 0, output_tokens: 0, audio_ms: 30_000 },
          };
        });
        await runOnce(db, provider(transcribe), undefined, blobs);
        const done = await db.job(c.user_id, job.id);
        expect(done).toMatchObject({
          state: 'succeeded',
          progress: { completed_chunks: 3, total_chunks: 3 },
          result: {
            kind: 'recording_transcription',
            applied: true,
            segment_count: 1200,
            processed_chunks: 3,
            usage: { audio_ms: 90_000 },
          },
        });
        expect(transcribe).toHaveBeenCalledTimes(3);
        expect(
          buffers.every((bytes) => bytes.every((value) => value === 0)),
        ).toBe(true);
        const entries = [];
        let offset = 0;
        while (true) {
          const page = await db.transcripts.page(
            c.user_id,
            c.doc.id,
            1,
            offset,
          );
          entries.push(...page.segments);
          if (!page.has_more) break;
          offset += page.segments.length;
        }
        expect(entries).toHaveLength(1200);
        expect(new Set(entries.map((entry) => entry.id)).size).toBe(1200);
        expect(new Set(entries.map((entry) => entry.origin?.chunk_id))).toEqual(
          new Set(source.uploads.map((upload) => upload.chunk.chunk_id)),
        );
        expect(entries[800]!.start_ms).toBe(66_000);
        await expect(db.transcript(c.user_id, c.doc.id)).rejects.toMatchObject({
          code: 'transcript_pagination_required',
        });
        expect(
          (
            await db.pool.query(
              'SELECT count(*)::integer count FROM recording_transcription_runs WHERE job_id=$1',
              [job.id],
            )
          ).rows[0].count,
        ).toBe(0);
      });
      it('resumes durable completed chunks after retry and records uncertain requests without claiming exactly-once billing', async () => {
        const c = await context();
        await ready(c, 3);
        const job = await enqueue(c);
        let requests = 0;
        const transcribe = vi.fn<AiProviders['transcribe']>(async () => {
          requests++;
          if (requests === 2)
            throw new ServiceError(
              'provider_rate_limited',
              'Synthetic provider throttle.',
              503,
              true,
            );
          return {
            segments: [
              {
                id: randomUUID(),
                start_ms: 0,
                end_ms: 500,
                text: `Request ${requests}.`,
              },
            ],
            usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
          };
        });
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'retry_wait',
          progress: { completed_chunks: 1 },
        });
        const first = segmentsSchema.parse(
          (
            await db.pool.query<{ segments: unknown }>(
              'SELECT segments FROM recording_transcription_chunks WHERE job_id=$1',
              [job.id],
            )
          ).rows[0]!.segments,
        );
        await db.pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [
          job.id,
        ]);
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(transcribe).toHaveBeenCalledTimes(4);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'succeeded',
          result: { uncertain_requests: 1, usage: { audio_ms: 3000 } },
        });
        expect(
          (await db.transcripts.page(c.user_id, c.doc.id, 1)).segments[0],
        ).toEqual(first[0]);
        expect(await db.usage.snapshot(c.user_id)).toMatchObject({
          settled: { audio_ms: '3000' },
          uncertain: { audio_ms: '1000' },
          settled_requests: '3',
          uncertain_requests: '1',
        });
      });
      it('stops before sending an unreserved chunk and resumes only remaining chunks after an administrator raises the allowance', async () => {
        const c = await context();
        await ready(c, 3);
        const job = await enqueue(c);
        await db.usage.setLimits(c.user_id, {
          input_tokens: 0,
          output_tokens: 0,
          audio_ms: 1000,
        });
        const transcribe = vi.fn<AiProviders['transcribe']>(async () => ({
          segments: [
            {
              id: randomUUID(),
              start_ms: 0,
              end_ms: 500,
              text: 'Budgeted speech.',
            },
          ],
          usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
        }));
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'failed',
          error: { code: 'quota_exceeded' },
          progress: { completed_chunks: 1, uncertain_requests: 0 },
        });
        expect(await db.usage.snapshot(c.user_id)).toMatchObject({
          settled: { audio_ms: '1000' },
          uncertain_requests: '0',
        });
        await db.usage.setLimits(c.user_id, {
          input_tokens: 0,
          output_tokens: 0,
          audio_ms: 3000,
        });
        await db.retryRecordingTranscription(c.user_id, job.id);
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(transcribe).toHaveBeenCalledTimes(3);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'succeeded',
          result: { processed_chunks: 3, uncertain_requests: 0 },
        });
        expect(await db.usage.snapshot(c.user_id)).toMatchObject({
          settled: { audio_ms: '3000' },
          uncertain_requests: '0',
          settled_requests: '3',
        });
      });
      it('preserves microphone/system source epochs and known pause gaps in separately paged capture evidence', async () => {
        const c = await context(true);
        const source = await ready(c, 2, 1000, true);
        const denied = await app.inject({
          method: 'POST',
          url: `/v1/recordings/${c.input.id}/finalize-transcript`,
          headers: { ...c.headers, 'idempotency-key': randomUUID() },
          payload: {
            base_revision: 0,
            locale: 'en-US',
            seal_sha256: (await db.recordings.get(c.user_id, c.input.id))
              .seal_sha256,
            accept_incomplete: false,
          },
        });
        expect(denied.statusCode).toBe(409);
        await enqueue(c, randomUUID(), true);
        await runOnce(db, provider(), undefined, blobs);
        const page = await db.transcripts.page(c.user_id, c.doc.id, 1);
        expect(page.recording).toMatchObject({
          partial: true,
          timeline_count: 3,
        });
        expect(
          new Set(page.segments.map((segment) => segment.origin?.kind)),
        ).toEqual(new Set(['microphone', 'loopback']));
        expect(
          new Set(
            page.segments.map((segment) => segment.origin?.capture_epoch),
          ),
        ).toEqual(
          new Set(source.uploads.map((upload) => upload.chunk.capture_epoch)),
        );
        expect(page.segments.map((segment) => segment.start_ms)).toEqual([
          100, 100, 4100, 4100,
        ]);
        const evidence = await app.inject({
          url: `/v1/documents/${c.doc.id}/transcript/timeline?revision=1&offset=0`,
          headers: c.headers,
        });
        expect(
          transcriptTimelinePageSchema
            .parse(evidence.json())
            .entries.filter((entry) => entry.kind === 'gap'),
        ).toHaveLength(2);
        const exported = await app.inject({
          url: `/v1/documents/${c.doc.id}/export?format=text&timestamps=false`,
          headers: c.headers,
        });
        expect(exported.statusCode).toBe(200);
        expect(exported.body).toContain('Incomplete recording:');
        expect(exported.body).toContain('[Microphone]');
        expect(exported.body).toContain('[System audio]');
        await db.recordings.remove(c.user_id, c.input.id);
        expect(
          (await db.transcripts.timeline(c.user_id, c.doc.id, 1, 0)).entries,
        ).toHaveLength(3);
        await db.pool.query(
          'UPDATE transcript_revisions SET timeline_count=4 WHERE document_id=$1 AND revision=1',
          [c.doc.id],
        );
        try {
          await expect(
            db.transcripts.header(c.user_id, c.doc.id, 1),
          ).rejects.toMatchObject({ code: 'transcript_integrity_error' });
        } finally {
          await db.pool.query(
            'UPDATE transcript_revisions SET timeline_count=3 WHERE document_id=$1 AND revision=1',
            [c.doc.id],
          );
        }
      });
      it('marks unavailable capture-clock mapping explicitly and rejects out-of-chunk provider phrases', async () => {
        const c = await context();
        const upload = c.chunk();
        upload.chunk.clock_end_ms = 0;
        await register(c, upload);
        const grant = await authorize(c, upload.chunk.chunk_id);
        await put(grant, c.wav);
        expect(
          (await complete(c, upload.chunk.chunk_id, grant.id)).statusCode,
        ).toBe(200);
        await db.recordings.seal(
          c.user_id,
          c.input.id,
          seal(c, [upload]),
          randomUUID(),
        );
        await enqueue(c);
        await runOnce(db, provider(), undefined, blobs);
        expect(
          (await db.transcript(c.user_id, c.doc.id)).segments[0],
        ).toMatchObject({
          start_ms: 0,
          end_ms: 0,
          origin: {
            time_basis: 'unmapped_clock',
            start_offset_ms: 100,
            end_offset_ms: 700,
          },
        });
        const other = await context();
        await ready(other, 1);
        const job = await enqueue(other);
        await runOnce(
          db,
          provider(async () => ({
            segments: [
              {
                id: randomUUID(),
                start_ms: 1001,
                end_ms: 1002,
                text: 'Outside the source audio.',
              },
            ],
            usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
          })),
          undefined,
          blobs,
        );
        expect(await db.job(other.user_id, job.id)).toMatchObject({
          state: 'failed',
          error: { code: 'invalid_transcript' },
        });
        expect(
          (await db.document(other.user_id, other.doc.id)).transcript_revision,
        ).toBe(0);
      });
      it('refuses an empty sealed recording without reserving a provider job', async () => {
        const c = await context();
        await db.recordings.seal(
          c.user_id,
          c.input.id,
          seal(c, []),
          randomUUID(),
        );
        const source = await db.recordings.get(c.user_id, c.input.id);
        const result = await app.inject({
          method: 'POST',
          url: `/v1/recordings/${c.input.id}/finalize-transcript`,
          headers: { ...c.headers, 'idempotency-key': randomUUID() },
          payload: {
            base_revision: 0,
            locale: 'en-US',
            seal_sha256: source.seal_sha256,
            accept_incomplete: false,
          },
        });
        expect(result.statusCode).toBe(400);
        expect(result.json()).toMatchObject({ code: 'empty_audio' });
        expect(await db.jobs(c.user_id, c.doc.id)).toEqual([]);
      });
      it('keeps a generated candidate when manual edits win, and only applies it through an explicit idempotent revision decision', async () => {
        const c = await context();
        await ready(c, 1);
        const job = await enqueue(c);
        await db.editTranscript(c.user_id, c.doc.id, 0, [
          {
            id: randomUUID(),
            start_ms: 0,
            end_ms: 1,
            text: 'Manual text must remain.',
          },
        ]);
        await runOnce(db, provider(), undefined, blobs);
        const done = await db.job(c.user_id, job.id);
        expect(done).toMatchObject({
          state: 'succeeded',
          input_stale: true,
          result: { applied: false, transcript_revision: 2 },
        });
        expect(
          (await db.transcript(c.user_id, c.doc.id)).segments[0]!.text,
        ).toBe('Manual text must remain.');
        expect(
          await db.transcripts.header(c.user_id, c.doc.id, 2),
        ).toMatchObject({ is_candidate: true, based_on_revision: 0 });
        await db.editTranscript(c.user_id, c.doc.id, 1, [
          {
            id: randomUUID(),
            start_ms: 0,
            end_ms: 1,
            text: 'Even newer manual text.',
          },
        ]);
        await expect(
          db.transcripts.apply(c.user_id, c.doc.id, 1, 2, randomUUID()),
        ).rejects.toMatchObject({ code: 'revision_conflict' });
        const key = randomUUID();
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await app.inject({
            method: 'POST',
            url: `/v1/documents/${c.doc.id}/transcript/apply`,
            headers: { ...c.headers, 'idempotency-key': key },
            payload: { base_revision: 3, source_revision: 2, confirmed: true },
          });
          expect(result.statusCode).toBe(200);
          expect(transcriptPageSchema.parse(result.json())).toMatchObject({
            revision: 4,
            is_candidate: false,
            recording: { id: c.input.id },
          });
        }
        expect(
          (await db.transcript(c.user_id, c.doc.id, 1)).segments[0]!.text,
        ).toBe('Manual text must remain.');
        expect(
          (await db.document(c.user_id, c.doc.id)).transcript_revision,
        ).toBe(4);
      });
      it.each(['cancel', 'audio-delete', 'document-delete', 'revoke'] as const)(
        'fences late provider results after %s and erases staged speech',
        async (action) => {
          const c = await context();
          await ready(c, 1);
          const job = await enqueue(c);
          let finish!: (
            result: Awaited<ReturnType<AiProviders['transcribe']>>,
          ) => void;
          const transcribe = vi.fn<AiProviders['transcribe']>(
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          );
          const running = runOnce(db, provider(transcribe), undefined, blobs);
          await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
          if (action === 'cancel') await db.cancel(c.user_id, job.id);
          if (action === 'audio-delete')
            await db.recordings.remove(c.user_id, c.input.id);
          if (action === 'document-delete')
            await db.deleteDocument(c.user_id, c.doc.id);
          if (action === 'revoke')
            await db.pool.query(
              'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
              [c.workspace_id, c.user_id],
            );
          finish({
            segments: [
              {
                id: randomUUID(),
                start_ms: 0,
                end_ms: 500,
                text: 'Must never publish.',
              },
            ],
            usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
          });
          await running;
          expect(
            (
              await db.pool.query(
                'SELECT transcript_revision FROM documents WHERE id=$1',
                [c.doc.id],
              )
            ).rows[0].transcript_revision,
          ).toBe(0);
          expect(
            (
              await db.pool.query(
                'SELECT count(*)::integer count FROM recording_transcription_chunks WHERE job_id=$1',
                [job.id],
              )
            ).rows[0].count,
          ).toBe(0);
        },
      );
      it('replays frozen consent after manual edits and rejects changed keys, unready sources and other owners', async () => {
        const c = await context(),
          other = await context();
        const route = `/v1/recordings/${c.input.id}/finalize-transcript`;
        const wrong = {
          base_revision: 0,
          locale: 'en-US',
          seal_sha256: '0'.repeat(64),
          accept_incomplete: false,
        };
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers: { ...c.headers, 'idempotency-key': randomUUID() },
              payload: wrong,
            })
          ).statusCode,
        ).toBe(409);
        await ready(c, 1);
        const key = randomUUID(),
          job = await enqueue(c, key);
        await db.editTranscript(c.user_id, c.doc.id, 0, [
          {
            id: randomUUID(),
            start_ms: 0,
            end_ms: 1,
            text: 'Newer manual evidence.',
          },
        ]);
        expect((await enqueue(c, key)).id).toBe(job.id);
        const source = await db.recordings.get(c.user_id, c.input.id);
        const frozen = { ...wrong, seal_sha256: source.seal_sha256 };
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers: { ...c.headers, 'idempotency-key': key },
              payload: { ...frozen, locale: 'zh-CN' },
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers: { ...other.headers, 'idempotency-key': randomUUID() },
              payload: frozen,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers: { ...c.headers, 'idempotency-key': randomUUID() },
              payload: frozen,
            })
          ).statusCode,
        ).toBe(409);
      });
      it('refuses mixed speech configurations and resumes the same failed job only through explicit confirmation', async () => {
        const c = await context();
        await ready(c, 2);
        const job = await enqueue(c);
        let calls = 0;
        const transcribe = vi.fn<AiProviders['transcribe']>(async () => {
          if (++calls === 2)
            throw new ServiceError(
              'provider_unavailable',
              'Synthetic explicit failure.',
              502,
            );
          return {
            segments: [
              {
                id: randomUUID(),
                start_ms: 0,
                end_ms: 500,
                text: `Saved output ${calls}.`,
              },
            ],
            usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
          };
        });
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'failed',
          progress: { completed_chunks: 1 },
        });
        const retry = () =>
          app.inject({
            method: 'POST',
            url: `/v1/jobs/${job.id}/retry`,
            headers: c.headers,
            payload: { confirmed: true },
          });
        expect((await retry()).statusCode).toBe(200);
        await runOnce(
          db,
          {
            ...provider(transcribe),
            configurationVersion: 'changed-configuration',
          },
          undefined,
          blobs,
        );
        expect(transcribe).toHaveBeenCalledTimes(2);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'failed',
          error: { code: 'provider_configuration_changed' },
        });
        expect((await retry()).statusCode).toBe(200);
        expect((await retry()).statusCode).toBe(200);
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(transcribe).toHaveBeenCalledTimes(3);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'succeeded',
          result: { processed_chunks: 2, uncertain_requests: 1 },
        });
        expect((await retry()).statusCode).toBe(409);
      });
      it('does not resend audio after temporary processing evidence expires', async () => {
        const c = await context();
        await ready(c, 1);
        const job = await enqueue(c);
        const transcribe = vi.fn<AiProviders['transcribe']>(async () => {
          throw new ServiceError(
            'provider_unavailable',
            'Synthetic explicit failure.',
            502,
          );
        });
        await runOnce(db, provider(transcribe), undefined, blobs);
        await db.pool.query(
          "UPDATE jobs SET updated_at=now()-interval '25 hours' WHERE id=$1",
          [job.id],
        );
        await db.cleanup();
        const response = await app.inject({
          method: 'POST',
          url: `/v1/jobs/${job.id}/retry`,
          headers: c.headers,
          payload: { confirmed: true },
        });
        expect(response.statusCode).toBe(410);
        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'failed',
          error: { code: 'provider_unavailable' },
        });
      });
      it('fences an expired worker while its replacement preserves the completed prefix and publishes one revision', async () => {
        const c = await context();
        await ready(c, 3);
        const job = await enqueue(c);
        let release!: (
          value: Awaited<ReturnType<AiProviders['transcribe']>>,
        ) => void;
        let calls = 0;
        const late = {
          segments: [
            {
              id: randomUUID(),
              start_ms: 0,
              end_ms: 500,
              text: 'Expired worker must not publish.',
            },
          ],
          usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
        };
        const old = vi.fn<AiProviders['transcribe']>(async () => {
          if (++calls === 2)
            return new Promise((resolve) => {
              release = resolve;
            });
          return {
            ...late,
            segments: [{ ...late.segments[0]!, text: 'Durable first chunk.' }],
          };
        });
        const original = runOnce(db, provider(old), undefined, blobs);
        try {
          await vi.waitFor(() => expect(old).toHaveBeenCalledTimes(2));
          await db.pool.query(
            "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
            [job.id],
          );
          const replacement = vi.fn<AiProviders['transcribe']>(async () => ({
            ...late,
            segments: [{ ...late.segments[0]!, text: 'Replacement worker.' }],
          }));
          await runOnce(db, provider(replacement), undefined, blobs);
          expect(replacement).toHaveBeenCalledTimes(2);
        } finally {
          release(late);
          await original;
        }
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'succeeded',
          result: {
            transcript_revision: 1,
            processed_chunks: 3,
            uncertain_requests: 1,
          },
        });
        const result = await db.transcript(c.user_id, c.doc.id);
        expect(result.segments[0]!.text).toBe('Durable first chunk.');
        expect(result.segments.map((segment) => segment.text)).not.toContain(
          'Expired worker must not publish.',
        );
      });
      it('enforces the pending owner budget for independently confirmed recording jobs', async () => {
        const c = await context();
        await ready(c, 1);
        for (let index = 0; index < 8; index++) await enqueue(c);
        const source = await db.recordings.get(c.user_id, c.input.id);
        const response = await app.inject({
          method: 'POST',
          url: `/v1/recordings/${c.input.id}/finalize-transcript`,
          headers: { ...c.headers, 'idempotency-key': randomUUID() },
          payload: {
            base_revision: 0,
            locale: 'en-US',
            seal_sha256: source.seal_sha256,
            accept_incomplete: false,
          },
        });
        expect(response.statusCode).toBe(429);
      });
      it('rejects altered private media before calling Azure and retains the original recording for repair', async () => {
        const c = await context();
        const source = await ready(c, 1);
        const job = await enqueue(c);
        const object = (
          await db.pool.query<{ verified_object: string }>(
            'SELECT verified_object FROM recording_chunks WHERE recording_id=$1',
            [c.input.id],
          )
        ).rows[0]!.verified_object;
        const damaged = Buffer.from(source.wav);
        damaged[damaged.length - 1] = 1;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey({ id: object, kind: 'verified' }),
            Body: damaged,
          }),
        );
        const transcribe = vi.fn<AiProviders['transcribe']>();
        await runOnce(db, provider(transcribe), undefined, blobs);
        expect(transcribe).not.toHaveBeenCalled();
        expect(await db.job(c.user_id, job.id)).toMatchObject({
          state: 'failed',
          error: { code: 'checksum_mismatch' },
        });
        expect((await db.recordings.get(c.user_id, c.input.id)).state).toBe(
          'ready',
        );
        expect(
          (await db.document(c.user_id, c.doc.id)).transcript_revision,
        ).toBe(0);
      });
    });
    async function expire(recording: string) {
      await db.pool.query(
        "UPDATE recording_objects SET protected_until=now()-interval '1 second',cleanup_after=now()-interval '1 second',cleanup_until=NULL WHERE recording_id=$1",
        [recording],
      );
    }
    it('resumes missing uploads after sealing, verifies the full WAV and does not expose the bucket publicly', async () => {
      const c = await context();
      const registered = await register(c);
      const descriptor = registered.upload;
      const sealKey = randomUUID();
      const frozen = await app.inject({
        method: 'POST',
        url: `/v1/recordings/${c.input.id}/seal`,
        headers: { ...c.headers, 'idempotency-key': sealKey },
        payload: seal(c, [descriptor]),
      });
      expect(frozen.statusCode).toBe(200);
      expect(frozen.json()).toMatchObject({
        state: 'sealed_pending',
        verified_chunks: 0,
      });
      const grant = await authorize(c, descriptor.chunk.chunk_id);
      expect(await authorize(c, descriptor.chunk.chunk_id, grant.key)).toEqual(
        grant,
      );
      const missing = await complete(c, descriptor.chunk.chunk_id, grant.id);
      expect(missing.json()).toMatchObject({ code: 'upload_missing' });
      await put(grant, c.wav);
      const publicUrl = new URL(grant.url);
      publicUrl.search = '';
      expect((await fetch(publicUrl)).status).toBe(403);
      const done = await complete(c, descriptor.chunk.chunk_id, grant.id);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ state: 'verified' });
      expect(
        (
          await app.inject({
            url: `/v1/recordings/${c.input.id}`,
            headers: c.headers,
          })
        ).json(),
      ).toMatchObject({
        state: 'ready',
        partial: false,
        chunk_count: 1,
        verified_chunks: 1,
      });
      const final = await db.pool.query<{ verified_object: string }>(
        'SELECT verified_object FROM recording_chunks WHERE id=$1',
        [descriptor.chunk.chunk_id],
      );
      const stored = await blobs.read(
        { id: final.rows[0]!.verified_object, kind: 'verified' },
        c.wav.length,
        AbortSignal.timeout(10_000),
      );
      expect(stored).toEqual(c.wav);
      const replay = await complete(c, descriptor.chunk.chunk_id, grant.id);
      expect(replay.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/recordings/${c.input.id}/chunks`,
            headers: { ...c.headers, 'idempotency-key': randomUUID() },
            payload: c.chunk(1),
          })
        ).json(),
      ).toMatchObject({ code: 'recording_sealed' });
    });
    it('binds creation, immutable chunks, seals and completion receipts to their input', async () => {
      const c = await context();
      const registered = await register(c);
      const again = await register(c, registered.upload, registered.key);
      expect(again).toEqual(registered);
      const changed = await app.inject({
        method: 'POST',
        url: `/v1/recordings/${c.input.id}/chunks`,
        headers: { ...c.headers, 'idempotency-key': registered.key },
        payload: { ...registered.upload, sha256: '0'.repeat(64) },
      });
      expect(changed.json()).toMatchObject({ code: 'idempotency_conflict' });
      const createAgain = await app.inject({
        method: 'POST',
        url: `/v1/documents/${c.doc.id}/recordings`,
        headers: { ...c.headers, 'idempotency-key': c.key },
        payload: { ...c.input, created_at: '2025-01-01T00:00:00Z' },
      });
      expect(createAgain.json()).toMatchObject({
        code: 'idempotency_conflict',
      });
      const first = await authorize(c, registered.upload.chunk.chunk_id);
      const second = await authorize(c, registered.upload.chunk.chunk_id);
      await put(first, c.wav);
      const key = randomUUID();
      expect(
        (await complete(c, registered.upload.chunk.chunk_id, first.id, key))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await complete(c, registered.upload.chunk.chunk_id, second.id, key)
        ).json(),
      ).toMatchObject({ code: 'idempotency_conflict' });
    });
    it('rejects unknown tracks, overlaps, out-of-order seals and undeclared or missing chunks', async () => {
      const c = await context();
      const first = (await register(c)).upload;
      const foreign = c.chunk(1);
      foreign.chunk.track_id = randomUUID();
      await expect(
        db.recordings.register(c.user_id, c.input.id, foreign, randomUUID()),
      ).rejects.toMatchObject({ code: 'invalid_track' });
      await expect(
        db.recordings.register(c.user_id, c.input.id, c.chunk(), randomUUID()),
      ).rejects.toMatchObject({ code: 'chunk_overlap' });
      const second = (await register(c, c.chunk(1))).upload;
      for (const expected of [[first], [second, first], [first, c.chunk(2)]])
        await expect(
          db.recordings.seal(
            c.user_id,
            c.input.id,
            seal(c, expected),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: 'recording_incomplete' });
      const frozen = seal(c, [first, second]);
      const key = randomUUID();
      const result = await db.recordings.seal(
        c.user_id,
        c.input.id,
        frozen,
        key,
      );
      expect(
        await db.recordings.seal(c.user_id, c.input.id, frozen, randomUUID()),
      ).toEqual(result);
      await expect(
        db.recordings.seal(
          c.user_id,
          c.input.id,
          {
            ...frozen,
            events: [
              {
                event_type: 'recording.stopped',
                clock_ms: 2000,
                capture_epoch: null,
                code: null,
              },
            ],
          },
          key,
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    });
    it('requires explicit incomplete acceptance and preserves the partial seal', async () => {
      const c = await context();
      const upload = (await register(c)).upload;
      const input: RecordingSeal = {
        ...seal(c, [upload]),
        native_state: 'failed',
      };
      const request = () =>
        app.inject({
          method: 'POST',
          url: `/v1/recordings/${c.input.id}/seal`,
          headers: { ...c.headers, 'idempotency-key': randomUUID() },
          payload: input,
        });
      expect((await request()).statusCode).toBe(400);
      input.accept_incomplete = true;
      expect((await request()).json()).toMatchObject({
        state: 'sealed_pending',
        partial: true,
      });
    });
    it('enforces retained chunk and byte budgets across recordings without uploading fake media', async () => {
      for (const [count, sampleCount] of [
        [10_000, 16000],
        [5592, 480000],
      ] as const) {
        const c = await context();
        const perRecording = Math.min(
          10_000,
          Math.floor(230400000 / sampleCount),
        );
        let remaining: number = count;
        while (remaining > 0) {
          const id = randomUUID();
          await db.recordings.create(
            c.user_id,
            c.doc.id,
            { ...c.input, id },
            randomUUID(),
          );
          const length = Math.min(perRecording, remaining);
          const descriptor = c.chunk();
          descriptor.chunk.sample_count = sampleCount;
          descriptor.size_bytes = sampleCount * 2 + 44;
          await db.pool.query(
            `WITH generated AS (SELECT gen_random_uuid() id,s FROM generate_series(0,$5::int-1) s)
             INSERT INTO recording_chunks(id,recording_id,track_id,sequence,sample_start,sample_count,descriptor,request_key,request_hash)
             SELECT id,$1::uuid,$2::uuid,s,s::bigint*$6,$6,
             jsonb_set($3::jsonb,'{chunk}',($3::jsonb->'chunk') || jsonb_build_object(
               'chunk_id',id,'recording_id',$1::text,'sequence',s,'sample_start',s::bigint*$6,
               'clock_start_ms',s::bigint*$6/16,'clock_end_ms',(s::bigint+1)*$6/16)),
             id::text,$4 FROM generated`,
            [
              id,
              c.input.tracks[0]!.spec.track_id,
              JSON.stringify(descriptor),
              '0'.repeat(64),
              length,
              sampleCount,
            ],
          );
          remaining -= length;
        }
        const additional = c.chunk();
        additional.chunk.sample_count = sampleCount;
        additional.chunk.clock_end_ms = sampleCount / 16;
        additional.size_bytes = sampleCount * 2 + 44;
        await expect(
          db.recordings.register(
            c.user_id,
            c.input.id,
            additional,
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: 'quota_exceeded' });
      }
    });
    it('bounds temporary storage even when a user deletes a recording and starts another', async () => {
      const c = await context();
      const upload = (await register(c)).upload;
      await db.pool.query(
        `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,request_key,upload_expires,protected_until,cleanup_after)
         SELECT gen_random_uuid(),$1,gen_random_uuid(),'staging',gen_random_uuid()::text,
         now()+interval '5 minutes',now()+interval '6 minutes',now()+interval '6 minutes' FROM generate_series(1,256)`,
        [c.input.id],
      );
      await expect(
        db.recordings.authorizeUpload(
          c.user_id,
          upload.chunk.chunk_id,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
      await db.recordings.remove(c.user_id, c.input.id);
      const id = randomUUID();
      await db.recordings.create(
        c.user_id,
        c.doc.id,
        { ...c.input, id },
        randomUUID(),
      );
      const next = c.chunk();
      next.chunk.recording_id = id;
      await db.recordings.register(c.user_id, id, next, randomUUID());
      await expect(
        db.recordings.authorizeUpload(
          c.user_id,
          next.chunk.chunk_id,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
      await db.pool.query(
        "UPDATE recording_objects SET protected_until=now()-interval '1 second' WHERE recording_id=$1",
        [c.input.id],
      );
      expect(
        await db.recordings.authorizeUpload(
          c.user_id,
          next.chunk.chunk_id,
          randomUUID(),
        ),
      ).not.toBeNull();
    });
    it('rejects changed signed headers and unsigned public ACLs', async () => {
      const c = await context();
      const registered = await register(c);
      const grant = await authorize(c, registered.upload.chunk.chunk_id);
      const signed = new URL(grant.url).searchParams.get('X-Amz-SignedHeaders');
      expect(signed).toContain('content-type');
      expect(signed).toContain('x-amz-acl');
      for (const headers of [
        { ...grant.headers, 'content-type': 'application/octet-stream' },
        { ...grant.headers, 'x-amz-acl': 'public-read' },
      ]) {
        const response = await fetch(grant.url, {
          method: 'PUT',
          headers,
          body: new Uint8Array(c.wav),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        expect(
          response.ok,
          'x-amz-acl' in headers && headers['x-amz-acl'] === 'public-read'
            ? 'ACL tampering'
            : 'Content-Type tampering',
        ).toBe(false);
      }
    });
    it.each(['sha256', 'pcm', 'oversized', 'wav'])(
      'does not promote invalid %s audio',
      async (damage) => {
        const c = await context();
        const upload = c.chunk();
        let bytes = c.wav;
        if (damage === 'pcm') upload.chunk.pcm_sha256 = '0'.repeat(64);
        if (damage === 'wav') {
          bytes = Buffer.from(bytes);
          bytes[0] = 0;
          upload.sha256 = createHash('sha256').update(bytes).digest('hex');
        }
        const registered = await register(c, upload);
        const grant = await authorize(c, registered.upload.chunk.chunk_id);
        if (damage === 'sha256' || damage === 'oversized') {
          bytes =
            damage === 'oversized'
              ? Buffer.concat([bytes, Buffer.from([0])])
              : Buffer.from(bytes);
          if (damage === 'sha256') bytes[bytes.length - 1] = 1;
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey({ id: grant.id, kind: 'staging' }),
              Body: bytes,
            }),
          );
        } else await put(grant, bytes);
        const result = await complete(
          c,
          registered.upload.chunk.chunk_id,
          grant.id,
        );
        expect(result.json()).toMatchObject({
          code: damage === 'wav' ? 'invalid_audio' : 'checksum_mismatch',
        });
        expect(
          (await db.recordings.chunk(c.user_id, upload.chunk.chunk_id)).state,
        ).toBe('pending');
      },
    );
    it('promotes the exact verified bytes instead of copying a staging object that can change', async () => {
      const c = await context();
      const registered = await register(c);
      const grant = await authorize(c, registered.upload.chunk.chunk_id);
      await put(grant, c.wav);
      const original = blobs.read.bind(blobs);
      const read = vi
        .spyOn(blobs, 'read')
        .mockImplementationOnce(async (object, size, signal) => {
          const bytes = await original(object, size, signal);
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey(object),
              Body: Buffer.alloc(size, 1),
            }),
          );
          return bytes;
        });
      try {
        expect(
          (await complete(c, registered.upload.chunk.chunk_id, grant.id))
            .statusCode,
        ).toBe(200);
      } finally {
        read.mockRestore();
      }
      const object = (
        await db.pool.query<{ verified_object: string }>(
          'SELECT verified_object FROM recording_chunks WHERE id=$1',
          [registered.upload.chunk.chunk_id],
        )
      ).rows[0]!.verified_object;
      expect(
        await blobs.read(
          { id: object, kind: 'verified' },
          c.wav.length,
          AbortSignal.timeout(10_000),
        ),
      ).toEqual(c.wav);
      await expect(
        blobs.promote(
          { id: object, kind: 'verified' },
          Buffer.alloc(c.wav.length, 1),
          AbortSignal.timeout(10_000),
        ),
      ).rejects.toMatchObject({ code: 'immutable_object_conflict' });
    });
    it('rejects another owner even in the same workspace, and fences permission loss before publication', async () => {
      const c = await context();
      const registered = await register(c);
      const otherSubject = randomUUID();
      await db.provision(
        'urn:windows-ai-notes:development',
        otherSubject,
        c.workspace_id,
      );
      expect(
        (
          await app.inject({
            url: `/v1/recordings/${c.input.id}`,
            headers: { 'x-dev-subject': otherSubject },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/audio-chunks/${registered.upload.chunk.chunk_id}/upload`,
            headers: {
              'x-dev-subject': otherSubject,
              'idempotency-key': randomUUID(),
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      const grant = await authorize(c, registered.upload.chunk.chunk_id);
      await put(grant, c.wav);
      const original = blobs.promote.bind(blobs);
      const promote = vi
        .spyOn(blobs, 'promote')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          await db.pool.query(
            'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
            [c.workspace_id, c.user_id],
          );
        });
      try {
        expect(
          (await complete(c, registered.upload.chunk.chunk_id, grant.id))
            .statusCode,
        ).toBe(404);
      } finally {
        promote.mockRestore();
      }
      expect(
        (
          await db.pool.query<{ state: string }>(
            'SELECT state FROM recording_chunks WHERE id=$1',
            [registered.upload.chunk.chunk_id],
          )
        ).rows[0]!.state,
      ).toBe('pending');
      await expire(c.input.id);
      await cleanupRecordingObjects(db, blobs, AbortSignal.timeout(10_000));
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',
        [c.workspace_id, c.user_id],
      );
      await expect(
        db.recordings.get(c.user_id, c.input.id),
      ).rejects.toMatchObject({ code: 'recording_not_found' });
    });
    it('keeps object deletion durable across document removal and late replayed uploads', async () => {
      const c = await context();
      const registered = await register(c);
      const grant = await authorize(c, registered.upload.chunk.chunk_id);
      await put(grant, c.wav);
      expect(
        (await complete(c, registered.upload.chunk.chunk_id, grant.id))
          .statusCode,
      ).toBe(200);
      await db.deleteDocument(c.user_id, c.doc.id);
      expect((await db.recordings.deletion(c.user_id, c.input.id)).state).toBe(
        'cleanup_pending',
      );
      await expect(
        db.recordings.get(c.user_id, c.input.id),
      ).rejects.toMatchObject({ code: 'recording_not_found' });
      await expire(c.input.id);
      await cleanupRecordingObjects(db, blobs, AbortSignal.timeout(10_000));
      await expect(
        s3.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: objectKey({ id: grant.id, kind: 'staging' }),
          }),
        ),
      ).rejects.toBeDefined();
      await put(grant, c.wav);
      await expire(c.input.id);
      await cleanupRecordingObjects(db, blobs, AbortSignal.timeout(10_000));
      await expect(
        s3.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: objectKey({ id: grant.id, kind: 'staging' }),
          }),
        ),
      ).rejects.toBeDefined();
      expect(
        (
          await db.pool.query(
            'SELECT 1 FROM recording_objects WHERE recording_id=$1',
            [c.input.id],
          )
        ).rowCount,
      ).toBe(2);
    });
    it('expires grants without extending their signed lifetime when verification renews protection', async () => {
      const c = await context();
      const registered = await register(c);
      const grant = await authorize(c, registered.upload.chunk.chunk_id);
      await db.pool.query(
        "UPDATE recording_objects SET upload_expires=now()-interval '1 second',protected_until=now()+interval '10 minutes' WHERE id=$1",
        [grant.id],
      );
      const expired = await app.inject({
        method: 'POST',
        url: `/v1/audio-chunks/${registered.upload.chunk.chunk_id}/upload`,
        headers: { ...c.headers, 'idempotency-key': grant.key },
        payload: {},
      });
      expect(expired.json()).toMatchObject({ code: 'upload_expired' });
      expect(
        (await authorize(c, registered.upload.chunk.chunk_id)).id,
      ).not.toBe(grant.id);
    });
    it('keeps deletion failures observable and retryable without deleting written notes', async () => {
      const c = await context();
      const upload = (await register(c)).upload;
      const grant = await authorize(c, upload.chunk.chunk_id);
      await put(grant, c.wav);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/recordings/${c.input.id}`,
        headers: c.headers,
      });
      expect(removed.statusCode).toBe(202);
      await expire(c.input.id);
      const objects = await db.recordings.claimCleanup();
      const object = objects.find((object) => object.id === grant.id)!;
      expect(object).toBeDefined();
      await db.recordings.finishCleanup(object, false);
      expect(await db.recordings.deletion(c.user_id, c.input.id)).toMatchObject(
        {
          state: 'cleanup_pending',
          cleanup_errors: 1,
        },
      );
      expect((await db.document(c.user_id, c.doc.id)).id).toBe(c.doc.id);
      await expire(c.input.id);
      await cleanupRecordingObjects(db, blobs, AbortSignal.timeout(10_000));
      expect(await db.recordings.deletion(c.user_id, c.input.id)).toMatchObject(
        {
          state: 'cleanup_confirmed',
          pending_objects: 0,
          cleanup_errors: 0,
          repeated_cleanup: true,
        },
      );
    });
    it('exposes disabled storage explicitly instead of accepting an unverifiable upload', async () => {
      const c = await context();
      const upload = (await register(c)).upload;
      const disabled = await createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
      });
      try {
        expect(
          (
            await disabled.inject({
              url: '/v1/recording-capabilities',
              headers: c.headers,
            })
          ).json(),
        ).toMatchObject({
          enabled: false,
          upload_origin: null,
          multipart: false,
        });
        const response = await disabled.inject({
          method: 'POST',
          url: `/v1/audio-chunks/${upload.chunk.chunk_id}/upload`,
          headers: { ...c.headers, 'idempotency-key': randomUUID() },
          payload: {},
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          code: 'storage_not_configured',
        });
      } finally {
        await disabled.close();
      }
    });
    it('fences stale verification attempts and never allows an old release to clear a newer lease', async () => {
      const c = await context();
      const registered = await register(c);
      const grant = await authorize(c, registered.upload.chunk.chunk_id);
      const first = await db.recordings.beginVerification(
        c.user_id,
        registered.upload.chunk.chunk_id,
        grant.id,
        randomUUID(),
      );
      expect(first).not.toBeNull();
      await db.pool.query(
        "UPDATE recording_chunks SET verification_until=now()-interval '1 second' WHERE id=$1",
        [registered.upload.chunk.chunk_id],
      );
      const second = await db.recordings.beginVerification(
        c.user_id,
        registered.upload.chunk.chunk_id,
        grant.id,
        randomUUID(),
      );
      expect(second!.token).toBeGreaterThan(first!.token);
      await expect(
        db.recordings.finishVerification(c.user_id, first!),
      ).rejects.toMatchObject({ code: 'verification_superseded' });
      await db.recordings.failVerification(first!);
      expect(
        (await db.recordings.chunk(c.user_id, registered.upload.chunk.chunk_id))
          .state,
      ).toBe('checking');
      await db.recordings.failVerification(second!);
    });
    it('refuses public buckets at startup rather than exposing uploaded media', async () => {
      await s3.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: '*',
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${bucket}/recordings/v1/*`],
              },
            ],
          }),
        }),
      );
      try {
        await expect(blobs.assertReady()).rejects.toThrow('public');
      } finally {
        await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
      }
    });
    it('refuses versioned buckets whose old audio versions cannot be deleted by this implementation', async () => {
      const name = `notes-versioned-${randomUUID()}`;
      await s3.send(new CreateBucketCommand({ Bucket: name }));
      const versioned = new RecordingBlobs({ ...config, bucket: name });
      try {
        await s3.send(
          new PutBucketVersioningCommand({
            Bucket: name,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        );
        await expect(versioned.assertReady()).rejects.toThrow('unversioned');
      } finally {
        versioned.close();
        await s3.send(new DeleteBucketCommand({ Bucket: name }));
      }
    });
  },
);
