import { createHash, randomUUID } from 'node:crypto';
import {
  ServiceError,
  segmentsSchema,
  usageSchema,
} from '@windows-ai-notes/contracts/server';
import type { AiProviders } from '@windows-ai-notes/ai';
import { validateWav } from '@windows-ai-notes/ai/wav';
import type { Database, ClaimedJob } from '@windows-ai-notes/db';
import type { RecordingBlobs } from '@windows-ai-notes/storage';
import { withUsage } from './usage.js';

export async function transcribeRecording(
  db: Database,
  job: ClaimedJob,
  providers: AiProviders,
  blobs: RecordingBlobs,
  signal: AbortSignal,
) {
  if (job.input.kind !== 'recording_transcription')
    throw new Error('Expected a recording transcription job.');
  const locale = job.input.locale;
  const recording = job.input.recording_id;
  await db.recordingTranscriptions.begin(
    job,
    providers.provider,
    providers.configurationVersion,
  );
  while (true) {
    signal.throwIfAborted();
    const next = await db.recordingTranscriptions.next(job);
    if (!next) return;
    const { upload } = next;
    const bytes = await blobs.read(
      next.object,
      upload.size_bytes,
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    );
    try {
      if (
        bytes.length !== upload.size_bytes ||
        createHash('sha256').update(bytes).digest('hex') !== upload.sha256 ||
        createHash('sha256').update(bytes.subarray(44)).digest('hex') !==
          upload.chunk.pcm_sha256
      )
        throw new ServiceError(
          'checksum_mismatch',
          'The private audio object no longer matches its verified WAV and PCM checksums.',
          409,
        );
      const duration = upload.chunk.sample_count / 16;
      if (Math.abs(validateWav(bytes) - duration) > 0.001)
        throw new ServiceError(
          'invalid_audio',
          'The stored WAV duration does not match its immutable samples.',
          409,
        );
      signal.throwIfAborted();
      const call = await db.recordingTranscriptions.sending(
        job,
        next.id,
        next.ordinal,
        {
          operation: next.id,
          provider: providers.provider,
          configurationVersion: providers.configurationVersion,
          budget: {
            input_tokens: 0,
            output_tokens: 0,
            audio_ms: Math.ceil(duration),
          },
        },
      );
      if (!call)
        throw new Error(
          'Recording transcription requires a usage reservation.',
        );
      const generated = await withUsage(db, call, async (report) => {
        const output = await providers.transcribe(
          bytes,
          locale,
          signal,
          (usage) => report({ ...usage, audio_ms: duration }),
        );
        return { ...output, usage: { ...output.usage, audio_ms: duration } };
      });
      signal.throwIfAborted();
      const relative = segmentsSchema.parse(generated.segments);
      const chunk = upload.chunk;
      const span = chunk.clock_end_ms - chunk.clock_start_ms;
      const segments = relative.map((segment) => {
        if (segment.start_ms > duration || segment.end_ms > Math.ceil(duration))
          throw new ServiceError(
            'invalid_transcript',
            'A speech phrase lies outside its source audio chunk.',
            502,
          );
        const mapped = (offset: number) =>
          chunk.clock_start_ms + (Math.min(duration, offset) / duration) * span;
        return {
          id: randomUUID(),
          start_ms:
            span === 0
              ? Math.round(chunk.clock_start_ms)
              : Math.floor(mapped(segment.start_ms)),
          end_ms:
            span === 0
              ? Math.round(chunk.clock_start_ms)
              : Math.ceil(mapped(segment.end_ms)),
          text: segment.text,
          origin: {
            recording_id: recording,
            track_id: chunk.track_id,
            kind: next.kind,
            capture_epoch: chunk.capture_epoch,
            chunk_id: next.id,
            start_offset_ms: segment.start_ms,
            end_offset_ms: segment.end_ms,
            time_basis:
              span === 0
                ? ('unmapped_clock' as const)
                : ('chunk_clock_linear' as const),
          },
        };
      });
      const usage = usageSchema.parse(generated.usage);
      await db.recordingTranscriptions.save(
        job,
        next.id,
        next.ordinal,
        segments,
        { ...usage, audio_ms: duration },
      );
    } finally {
      bytes.fill(0);
    }
  }
}
