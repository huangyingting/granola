import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AudioHostClient } from './client.js';
import type { UploadChunk } from '@windows-ai-notes/contracts';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { readCaptureBuild } from './capture-build.js';
import {
  calibration,
  calibrationPcm,
  LandmarkDecoder,
  wavHeader,
} from './calibration-signal.js';

export async function writeCalibrationFixture(
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const check = () => {
    if (signal?.aborted)
      throw new Error('Calibration fixture creation was cancelled.');
  };
  check();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${calibration.fixture}.wav`);
  const file = await open(path, 'wx', 0o600);
  let identity: Stats | undefined;
  let failed = false;
  let failure: unknown;
  try {
    identity = await file.stat();
    check();
    await file.writeFile(
      wavHeader(calibration.durationSeconds * calibration.sampleRate),
    );
    for (const pcm of calibrationPcm()) {
      check();
      await file.writeFile(pcm);
    }
    await file.sync();
    check();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await file.close();
  } catch (error) {
    failure = failed
      ? new AggregateError(
          [failure, error],
          'Calibration write and close failed.',
        )
      : error;
    failed = true;
  }
  if (failed) {
    try {
      const current = await lstat(path);
      if (
        !identity ||
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        throw new Error(
          'The calibration output changed; it was left untouched.',
        );
      await unlink(path);
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError],
        'Calibration fixture creation failed; output cleanup was not confirmed.',
      );
    }
    throw failure;
  }
  return path;
}

type Native = Pick<AudioHostClient, 'request' | 'readChunk'>;

export async function measureCalibration(
  client: Native,
  recordingId: string,
  signal: AbortSignal,
) {
  const deadline = performance.now() + 300_000;
  const check = () => {
    if (signal.aborted)
      throw new Error('Calibration measurement was cancelled.');
    if (performance.now() >= deadline)
      throw new Error(
        'Calibration measurement exceeded its five-minute deadline.',
      );
  };
  check();
  const inspected = await client.request({
    command: 'inspect_recording',
    recording_id: recordingId,
  });
  check();
  if (
    inspected.event_type !== 'recording.inspected' ||
    inspected.recording_id !== recordingId ||
    inspected.payload.state !== 'sealed' ||
    inspected.payload.issues.length !== 0 ||
    inspected.payload.recovered_chunks !== 0
  )
    throw new Error(
      'Calibration requires a fully authenticated sealed recording.',
    );
  const described = await client.request({
    command: 'get_recording',
    recording_id: recordingId,
    offset: 0,
  });
  check();
  if (
    described.event_type !== 'recording.manifest' ||
    described.recording_id !== recordingId ||
    described.payload.recording_id !== recordingId
  )
    throw new Error('Calibration received an inconsistent recording manifest.');
  const manifest = described.payload;
  const started = manifest.events.at(-2);
  const stopped = manifest.events.at(-1);
  if (
    manifest.state !== 'sealed' ||
    manifest.event_offset !== 0 ||
    manifest.has_more ||
    manifest.event_count !== manifest.events.length ||
    ![2, 7].includes(manifest.event_count) ||
    started?.event_type !== 'capture.started' ||
    started.code !== 'wasapi_qpc_v1' ||
    !started.capture_epoch ||
    stopped?.event_type !== 'capture.stopped' ||
    stopped.capture_epoch !== null ||
    stopped.code !== null ||
    !Number.isFinite(started.clock_ms) ||
    !Number.isFinite(stopped.clock_ms) ||
    started.clock_ms < 0 ||
    stopped.clock_ms <= started.clock_ms ||
    stopped.clock_ms > 14_400_000 ||
    manifest.tracks.length !== 2 ||
    new Set(manifest.tracks.map((track) => track.spec.kind)).size !== 2 ||
    new Set(manifest.tracks.map((track) => track.spec.track_id)).size !== 2 ||
    manifest.tracks.reduce((sum, track) => sum + track.saved_samples, 0) !==
      inspected.payload.total_samples ||
    manifest.tracks.reduce((sum, track) => sum + track.chunk_count, 0) !==
      inspected.payload.verified_chunks
  )
    throw new Error(
      'Calibration requires two tracks and one uninterrupted wasapi_qpc_v1 epoch.',
    );
  const captureBuild = readCaptureBuild(
    manifest.events.slice(0, -2),
    started.clock_ms,
  );
  const chunkIds = new Set<string>();
  const archiveHash = createHash('sha256').update(canonicalJson(manifest));
  const tracks = [];
  for (const track of manifest.tracks) {
    if (
      track.saved_samples > 3660 * calibration.sampleRate ||
      track.chunk_count > 122
    )
      throw new Error('Calibration exceeds one hour plus 60 seconds.');
    const chunks: UploadChunk[] = [];
    let position = 0;
    while (chunks.length < track.chunk_count) {
      const event = await client.request({
        command: 'list_recording_chunks',
        recording_id: recordingId,
        track_id: track.spec.track_id,
        sequence_start: chunks.length,
      });
      check();
      if (
        event.event_type !== 'recording.chunks' ||
        event.recording_id !== recordingId ||
        event.payload.track_id !== track.spec.track_id ||
        event.payload.sequence_start !== chunks.length ||
        event.payload.chunks.length === 0 ||
        chunks.length + event.payload.chunks.length > track.chunk_count ||
        event.payload.has_more !==
          chunks.length + event.payload.chunks.length < track.chunk_count
      )
        throw new Error('Calibration received inconsistent chunk pagination.');
      for (const upload of event.payload.chunks) {
        const chunk = upload.chunk;
        const previous = chunks.at(-1)?.chunk;
        if (
          chunk.recording_id !== recordingId ||
          chunk.track_id !== track.spec.track_id ||
          chunk.sequence !== chunks.length ||
          chunk.sample_start !== position ||
          chunk.capture_epoch !== started.capture_epoch ||
          chunkIds.has(chunk.chunk_id) ||
          !Number.isFinite(chunk.clock_start_ms) ||
          !Number.isFinite(chunk.clock_end_ms) ||
          chunk.clock_start_ms < 0 ||
          chunk.clock_end_ms <= chunk.clock_start_ms ||
          chunk.clock_end_ms > 14_400_000 ||
          (previous &&
            (chunk.clock_start_ms < previous.clock_start_ms ||
              chunk.clock_end_ms <= previous.clock_end_ms))
        )
          throw new Error(
            'Calibration chunk identity, samples or clocks changed.',
          );
        chunkIds.add(chunk.chunk_id);
        archiveHash.update(canonicalJson(upload));
        chunks.push(upload);
        position += chunk.sample_count;
      }
    }
    if (position !== track.saved_samples)
      throw new Error('Calibration saved samples disagree with the manifest.');
    const decoder = new LandmarkDecoder();
    for (const upload of chunks) {
      const header = Buffer.alloc(44);
      let offset = 0;
      for await (const bytes of client.readChunk(recordingId, upload, signal)) {
        try {
          check();
          if (offset + bytes.length > upload.size_bytes)
            throw new Error('Calibration WAV exceeds its authenticated size.');
          const headerBytes = Math.min(bytes.length, Math.max(0, 44 - offset));
          if (headerBytes > 0) bytes.copy(header, offset, 0, headerBytes);
          if (offset < 44 && offset + bytes.length >= 44) {
            if (!header.equals(wavHeader(upload.chunk.sample_count)))
              throw new Error('Calibration requires canonical mono PCM16 WAV.');
          }
          if (offset + bytes.length > 44)
            decoder.write(bytes.subarray(headerBytes));
          offset += bytes.length;
        } finally {
          bytes.fill(0);
        }
      }
      check();
      if (offset !== upload.size_bytes)
        throw new Error('Calibration WAV ended before its authenticated size.');
    }
    const decoded = decoder.finish();
    if (decoded.samples !== track.saved_samples)
      throw new Error(
        'Calibration decoded samples disagree with the manifest.',
      );
    tracks.push({
      kind: track.spec.kind,
      saved_samples: track.saved_samples,
      duplicate_marker_ids: decoded.duplicate_marker_ids,
      unexpected_marker_ids: decoded.unexpected_marker_ids,
      missing_marker_ids: calibration.markerSeconds
        .map((_, index) => index)
        .filter(
          (index) => !decoded.markers.some((marker) => marker.index === index),
        ),
      markers: decoded.markers.map((marker) => {
        const chunk = chunks.find(
          ({ chunk }) =>
            marker.sample >= chunk.sample_start &&
            marker.sample < chunk.sample_start + chunk.sample_count,
        )?.chunk;
        if (!chunk)
          throw new Error(
            'Calibration marker has no authenticated clock range.',
          );
        return {
          ...marker,
          clock_ms:
            chunk.clock_start_ms +
            ((marker.sample - chunk.sample_start) / chunk.sample_count) *
              (chunk.clock_end_ms - chunk.clock_start_ms),
        };
      }),
    });
  }
  check();
  return {
    ...calibrationReport(
      recordingId,
      stopped.clock_ms - started.clock_ms,
      tracks,
    ),
    archive_descriptor_sha256: archiveHash.digest('hex'),
    capture_build_provenance: captureBuild,
    capture_build_provenance_recorded: captureBuild !== null,
  };
}

type MeasurementTrack = {
  kind: 'microphone' | 'loopback';
  saved_samples: number;
  duplicate_marker_ids: number[];
  unexpected_marker_ids: number[];
  missing_marker_ids: number[];
  markers: { index: number; sample: number; clock_ms: number }[];
};

export function calibrationReport(
  recordingId: string,
  duration: number,
  tracks: MeasurementTrack[],
) {
  const microphone = tracks.find((track) => track.kind === 'microphone')!;
  const loopback = tracks.find((track) => track.kind === 'loopback')!;
  const pairs = microphone.markers.flatMap((marker) => {
    const other = loopback.markers.find(
      (other) => other.index === marker.index,
    );
    return other
      ? [{ index: marker.index, offset_ms: marker.clock_ms - other.clock_ms }]
      : [];
  });
  const maximumOffset =
    pairs.length === 0
      ? null
      : Math.max(...pairs.map((pair) => Math.abs(pair.offset_ms)));
  const offsetChange =
    pairs.length < 2 ? null : pairs.at(-1)!.offset_ms - pairs[0]!.offset_ms;
  const maximumChange =
    pairs.length < 2
      ? null
      : Math.max(
          ...pairs.map((pair) =>
            Math.abs(pair.offset_ms - pairs[0]!.offset_ms),
          ),
        );
  const spans = tracks.map((track) =>
    track.markers.length < 2
      ? 0
      : track.markers.at(-1)!.clock_ms - track.markers[0]!.clock_ms,
  );
  const complete =
    pairs.length === calibration.markerSeconds.length &&
    tracks.every(
      (track) =>
        track.missing_marker_ids.length === 0 &&
        track.duplicate_marker_ids.length === 0 &&
        track.unexpected_marker_ids.length === 0 &&
        track.markers.every(
          (marker, index) =>
            index === 0 || marker.sample > track.markers[index - 1]!.sample,
        ),
    );
  return {
    version: 1,
    fixture: calibration.fixture,
    recording_id: recordingId,
    capture_clock: 'wasapi_qpc_v1',
    clock_mapping: 'authenticated_chunk_linear_interpolation',
    capture_duration_ms: duration,
    minimum_landmark_span_ms: Math.min(...spans),
    target_ms: calibration.targetMs,
    detection_margin_ms: calibration.detectionMarginMs,
    offset_change_margin_ms: calibration.detectionMarginMs * 2,
    tracks,
    pairs,
    maximum_absolute_offset_ms: maximumOffset,
    end_to_end_offset_change_ms: offsetChange,
    maximum_offset_change_ms: maximumChange,
    complete_fixture_detected: complete,
    sampled_landmarks_within_target:
      complete &&
      duration >= 3_590_000 &&
      tracks.every(
        (track) => track.saved_samples >= 3_550 * calibration.sampleRate,
      ) &&
      Math.min(...spans) >= 3_550_000 &&
      maximumOffset !== null &&
      maximumOffset + calibration.detectionMarginMs <= calibration.targetMs &&
      maximumChange !== null &&
      maximumChange + calibration.detectionMarginMs * 2 <= calibration.targetMs,
    continuous_alignment_evaluated: false,
    production_accepted: false,
  } as const;
}
