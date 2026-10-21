import {
  ServiceError,
  segmentsSchema,
  usageSchema,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_TEXT_BYTES,
  type Segment,
  type Usage,
} from '@windows-ai-notes/contracts/server';
import { registerChunkSchema } from '@windows-ai-notes/contracts/uploads';
import type { Database, Transaction, ClaimedJob } from './index.js';
import type { UsageReservation } from './usage.js';

interface Run {
  provider: 'azure' | 'fixture';
  configuration_version: string;
  completed_chunks: number;
  segment_count: number;
  text_bytes: number;
  usage: Usage;
  pending_chunk: string | null;
  uncertain_requests: number;
}
const lost = () =>
  new ServiceError(
    'job_lease_lost',
    'This transcription attempt no longer owns its job.',
    409,
  );
const input = (job: ClaimedJob) => {
  if (job.input.kind !== 'recording_transcription')
    throw new Error('Expected a recording transcription job.');
  return job.input;
};
export class RecordingTranscriptions {
  constructor(private readonly database: Database) {}
  private async guard(tx: Transaction, job: ClaimedJob) {
    const selected = input(job);
    await this.database.document(job.ownerId, job.documentId, tx);
    const source = await this.database.recordings.transcriptionSource(
      job.ownerId,
      selected.recording_id,
      selected.seal_sha256,
      tx,
    );
    if (
      source.document_id !== job.documentId ||
      source.chunk_count !== selected.chunk_count ||
      (source.partial && !selected.accept_incomplete)
    )
      throw new ServiceError(
        'recording_source_changed',
        'The recording no longer matches its accepted transcription source.',
        409,
      );
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT state='running' AND lease_token=$2 AND lease_until>now() valid
       FROM jobs WHERE id=$1 FOR UPDATE`,
        [job.id, job.leaseToken],
      )
    ).rows[0];
    if (!row?.valid) throw lost();
    return source;
  }
  private async run(tx: Transaction, id: string): Promise<Run> {
    const row = (
      await tx.query<Run>(
        'SELECT * FROM recording_transcription_runs WHERE job_id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row)
      throw new ServiceError(
        'transcription_progress_expired',
        'Saved processing progress expired. Start a new transcription explicitly.',
        410,
      );
    return { ...row, usage: usageSchema.parse(row.usage) };
  }
  async begin(
    job: ClaimedJob,
    provider: 'azure' | 'fixture',
    configuration: string,
  ) {
    if (!configuration || configuration.length > 200)
      throw new Error('Use a bounded provider configuration identity.');
    await this.database.transaction(async (tx) => {
      await this.guard(tx, job);
      const prior = (
        await tx.query<{ has_progress: boolean }>(
          `SELECT progress IS NOT NULL has_progress FROM jobs WHERE id=$1`,
          [job.id],
        )
      ).rows[0];
      const exists = (
        await tx.query(
          'SELECT job_id FROM recording_transcription_runs WHERE job_id=$1',
          [job.id],
        )
      ).rowCount;
      if (!exists && prior?.has_progress)
        throw new ServiceError(
          'transcription_progress_expired',
          'Saved processing progress expired. Start a new transcription explicitly.',
          410,
        );
      await tx.query(
        `INSERT INTO recording_transcription_runs (job_id,provider,configuration_version,usage)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [
          job.id,
          provider,
          configuration,
          JSON.stringify({ input_tokens: 0, output_tokens: 0, audio_ms: 0 }),
        ],
      );
      const run = await this.run(tx, job.id);
      if (
        run.provider !== provider ||
        run.configuration_version !== configuration
      )
        throw new ServiceError(
          'provider_configuration_changed',
          'The speech configuration changed. Restore it to resume, or explicitly start a new transcription.',
          409,
        );
      await this.progress(tx, job, run);
    });
  }
  async next(job: ClaimedJob) {
    return this.database.transaction(async (tx) => {
      const source = await this.guard(tx, job);
      const run = await this.run(tx, job.id);
      if (run.completed_chunks === input(job).chunk_count) return null;
      const row = (
        await tx.query<{
          id: string;
          descriptor: unknown;
          verified_object: string | null;
        }>(
          `SELECT id,descriptor,verified_object FROM recording_chunks WHERE recording_id=$1
         ORDER BY track_id,sequence LIMIT 1 OFFSET $2`,
          [source.id, run.completed_chunks],
        )
      ).rows[0];
      if (!row?.verified_object)
        throw new ServiceError(
          'recording_incomplete',
          'A verified recording chunk is unavailable.',
          409,
          true,
        );
      const upload = registerChunkSchema.parse(row.descriptor);
      const track = source.tracks.find(
        (track) => track.spec.track_id === upload.chunk.track_id,
      );
      if (!track)
        throw new ServiceError(
          'recording_source_changed',
          'A chunk does not belong to the accepted tracks.',
          409,
        );
      return {
        id: row.id,
        ordinal: run.completed_chunks,
        upload,
        object: { id: row.verified_object, kind: 'verified' as const },
        kind: track.spec.kind,
      };
    });
  }
  async sending(
    job: ClaimedJob,
    chunk: string,
    ordinal: number,
    reservation?: UsageReservation,
  ) {
    return this.database.transaction(async (tx) => {
      await this.guard(tx, job);
      const run = await this.run(tx, job.id);
      if (run.completed_chunks !== ordinal) throw lost();
      const call = reservation
        ? await this.database.usage.start(job, reservation, tx)
        : undefined;
      await tx.query(
        `UPDATE recording_transcription_runs SET uncertain_requests=uncertain_requests+CASE WHEN pending_chunk IS NULL THEN 0 ELSE 1 END,
         pending_chunk=$2,updated_at=now() WHERE job_id=$1`,
        [job.id, chunk],
      );
      await this.progress(tx, job, await this.run(tx, job.id));
      return call;
    });
  }
  async save(
    job: ClaimedJob,
    chunk: string,
    ordinal: number,
    entries: Segment[],
    usage: Usage,
  ) {
    const segments = segmentsSchema.parse(entries);
    const acceptedUsage = usageSchema.parse(usage);
    await this.database.transaction(async (tx) => {
      await this.guard(tx, job);
      const run = await this.run(tx, job.id);
      if (run.completed_chunks !== ordinal || run.pending_chunk !== chunk)
        throw lost();
      if (
        segments.some(
          (segment) =>
            segment.origin?.chunk_id !== chunk ||
            segment.origin.recording_id !== input(job).recording_id,
        )
      )
        throw new Error(
          'Recording transcript segments require their immutable source provenance.',
        );
      const bytes = segments.reduce(
        (sum, segment) => sum + Buffer.byteLength(segment.text),
        0,
      );
      if (
        run.segment_count + segments.length > MAX_TRANSCRIPT_SEGMENTS ||
        run.text_bytes + bytes > MAX_TRANSCRIPT_TEXT_BYTES
      )
        throw new ServiceError(
          'transcript_too_large',
          'The recording transcript exceeds the supported segment or text budget; no partial transcript was published.',
          413,
        );
      const total: Usage = {
        input_tokens: run.usage.input_tokens + acceptedUsage.input_tokens,
        output_tokens: run.usage.output_tokens + acceptedUsage.output_tokens,
        audio_ms: run.usage.audio_ms + acceptedUsage.audio_ms,
      };
      await tx.query(
        'INSERT INTO recording_transcription_chunks VALUES ($1,$2,$3,$4)',
        [job.id, chunk, ordinal, JSON.stringify(segments)],
      );
      await tx.query(
        `UPDATE recording_transcription_runs SET completed_chunks=completed_chunks+1,segment_count=segment_count+$2,
         text_bytes=text_bytes+$3,usage=$4,pending_chunk=NULL,updated_at=now() WHERE job_id=$1`,
        [job.id, segments.length, bytes, JSON.stringify(total)],
      );
      const current = await this.run(tx, job.id);
      await this.progress(tx, job, current);
      await this.database.event(tx, job.id, 'job.progress', {
        stage: 'recording_chunks',
        completed_chunks: current.completed_chunks,
        total_chunks: input(job).chunk_count,
      });
    });
  }
  private async progress(tx: Transaction, job: ClaimedJob, run: Run) {
    await tx.query('UPDATE jobs SET progress=$2,updated_at=now() WHERE id=$1', [
      job.id,
      JSON.stringify({
        completed_chunks: run.completed_chunks,
        total_chunks: input(job).chunk_count,
        audio_ms: run.usage.audio_ms,
        uncertain_requests: run.uncertain_requests,
      }),
    ]);
  }
  async output(tx: Transaction, job: ClaimedJob) {
    const source = await this.guard(tx, job);
    const run = await this.run(tx, job.id);
    const rows = (
      await tx.query<{ ordinal: number; segments: unknown }>(
        'SELECT ordinal,segments FROM recording_transcription_chunks WHERE job_id=$1 ORDER BY ordinal',
        [job.id],
      )
    ).rows;
    if (
      run.completed_chunks !== input(job).chunk_count ||
      rows.length !== run.completed_chunks ||
      rows.some((row, index) => row.ordinal !== index)
    )
      throw new ServiceError(
        'recording_incomplete',
        'Not all recording chunks have durable transcription results.',
        409,
        true,
      );
    const segments = rows.flatMap((row) => segmentsSchema.parse(row.segments));
    if (segments.length !== run.segment_count)
      throw new Error(
        'The durable transcription result count is inconsistent.',
      );
    segments.sort(
      (a, b) =>
        a.start_ms - b.start_ms ||
        a.end_ms - b.end_ms ||
        (a.origin?.track_id ?? '').localeCompare(b.origin?.track_id ?? '') ||
        a.id.localeCompare(b.id),
    );
    const timeline = [
      ...source.seal.events.map((value) => ({ kind: 'event' as const, value })),
      ...source.seal.gaps.map((value) => ({ kind: 'gap' as const, value })),
    ].sort(
      (a, b) =>
        (a.kind === 'event' ? a.value.clock_ms : a.value.start_ms) -
        (b.kind === 'event' ? b.value.clock_ms : b.value.start_ms),
    );
    return {
      segments,
      timeline,
      run,
      recording: {
        id: source.id,
        seal_sha256: input(job).seal_sha256,
        partial: source.partial,
        tracks: source.tracks.map(({ spec }) => ({
          track_id: spec.track_id,
          kind: spec.kind,
        })),
        timeline_count: timeline.length,
      },
    };
  }
  async eraseRecording(tx: Transaction, recording: string) {
    const rows = (
      await tx.query<{ id: string }>(
        `UPDATE jobs SET state='cancelled',lease_token=lease_token+1,lease_until=NULL,error=NULL,updated_at=now()
       WHERE kind='recording_transcription' AND input->>'recording_id'=lower($1)
       AND state IN ('queued','running','retry_wait') RETURNING id`,
        [recording],
      )
    ).rows;
    for (const row of rows)
      await this.database.event(tx, row.id, 'job.cancelled', {
        code: 'recording_deleted',
      });
    await tx.query(
      `DELETE FROM recording_transcription_runs WHERE job_id IN
       (SELECT id FROM jobs WHERE kind='recording_transcription' AND input->>'recording_id'=lower($1))`,
      [recording],
    );
  }
}
