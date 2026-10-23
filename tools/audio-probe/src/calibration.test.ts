import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  audioEventSchema,
  type AudioEvent,
  type UploadChunk,
} from '@windows-ai-notes/contracts';
import type { AudioHostClient } from './client.js';
import {
  calibrationReport,
  measureCalibration,
  writeCalibrationFixture,
} from './calibration.js';
import {
  calibration,
  calibrationPcm,
  wavHeader,
} from './calibration-signal.js';

type Manifest = Extract<
  AudioEvent,
  { event_type: 'recording.manifest' }
>['payload'];
type Inspection = Extract<
  AudioEvent,
  { event_type: 'recording.inspected' | 'recording.recovered' }
>['payload'];

class NativeFixture {
  readonly id = randomUUID();
  readonly epoch = randomUUID();
  readonly chunks = new Map<string, UploadChunk[]>();
  readonly sources = new Map<string, ReturnType<typeof calibrationPcm>>();
  readonly buffers: Buffer[] = [];
  readonly inspection: Inspection;
  readonly manifest: Manifest;
  exports = 0;
  requests = 0;
  retainBuffers = true;
  corruptHeader = false;
  truncate = false;
  wrongPage = false;
  readFailure = false;
  lateFailure = false;
  microphoneDelaySamples = 0;
  combinedHeader = false;
  private microphoneTail = Buffer.alloc(0);
  constructor(seconds = 24) {
    const tracks = (['microphone', 'loopback'] as const).map((kind) => {
      const trackId = randomUUID();
      const chunks: UploadChunk[] = [];
      for (let start = 0; start < seconds; start += 30) {
        const count = Math.min(30, seconds - start) * 16_000;
        const offset = kind === 'microphone' ? 25 : 0;
        chunks.push({
          chunk: {
            format_version: 1,
            recording_id: this.id,
            track_id: trackId,
            chunk_id: randomUUID(),
            capture_epoch: this.epoch,
            sequence: chunks.length,
            sample_start: start * 16_000,
            sample_count: count,
            sample_rate: 16_000,
            channels: 1,
            bits_per_sample: 16,
            clock_start_ms: 100 + start * 1000 + offset,
            clock_end_ms: 100 + start * 1000 + count / 16 + offset,
            pcm_sha256: 'a'.repeat(64),
          },
          size_bytes: 44 + count * 2,
          sha256: 'b'.repeat(64),
        });
      }
      this.chunks.set(trackId, chunks);
      this.sources.set(trackId, calibrationPcm());
      return {
        spec: {
          track_id: trackId,
          kind,
          device_id: 'default',
          capture_scope: 'endpoint' as const,
          device_selection_policy: 'default' as const,
        },
        actual_device_id: `synthetic-${kind}`,
        saved_samples: seconds * 16_000,
        chunk_count: chunks.length,
      };
    });
    this.manifest = {
      format_version: 1,
      recording_id: this.id,
      created_at: '2026-10-23T00:00:00Z',
      state: 'sealed',
      tracks,
      event_offset: 0,
      event_count: 2,
      has_more: false,
      events: [
        {
          event_type: 'capture.started',
          clock_ms: 0,
          capture_epoch: this.epoch,
          code: 'wasapi_qpc_v1',
        },
        {
          event_type: 'capture.stopped',
          clock_ms: seconds * 1000 + 200,
          capture_epoch: null,
          code: null,
        },
      ],
    };
    this.inspection = {
      state: 'sealed',
      verified_chunks: tracks.reduce(
        (sum, track) => sum + track.chunk_count,
        0,
      ),
      recovered_chunks: 0,
      total_samples: tracks.reduce(
        (sum, track) => sum + track.saved_samples,
        0,
      ),
      issues: [],
    };
  }

  async request(
    request: Parameters<AudioHostClient['request']>[0],
  ): Promise<AudioEvent> {
    this.requests++;
    const base = {
      protocol_version: 1,
      request_id: randomUUID(),
      recording_id: this.id,
    };
    if (request.command === 'inspect_recording')
      return audioEventSchema.parse({
        ...base,
        event_type: 'recording.inspected',
        payload: this.inspection,
      });
    if (request.command === 'get_recording')
      return audioEventSchema.parse({
        ...base,
        event_type: 'recording.manifest',
        payload: this.manifest,
      });
    if (request.command === 'list_recording_chunks') {
      const chunks = this.chunks.get(request.track_id)!;
      const start = request.sequence_start;
      return audioEventSchema.parse({
        ...base,
        event_type: 'recording.chunks',
        payload: {
          track_id: request.track_id,
          sequence_start: this.wrongPage ? start + 1 : start,
          chunks: this.wrongPage ? [] : chunks.slice(start, start + 50),
          has_more: start + 50 < chunks.length,
        },
      });
    }
    throw new Error(
      'The calibration probe must not send mutating native requests.',
    );
  }

  async *readChunk(
    _recording: string,
    upload: UploadChunk,
  ): AsyncGenerator<Buffer> {
    this.exports++;
    const header = wavHeader(upload.chunk.sample_count);
    if (this.corruptHeader) header[0] = 0;
    if (!this.combinedHeader)
      for (const part of [header.subarray(0, 3), header.subarray(3)]) {
        if (this.retainBuffers) this.buffers.push(part);
        yield part;
      }
    const source = this.sources.get(upload.chunk.track_id)!;
    for (
      let second = 0;
      second < upload.chunk.sample_count / 16_000;
      second++
    ) {
      const part = source.next();
      if (part.done) throw new Error('Synthetic source ended unexpectedly.');
      if (this.readFailure)
        throw new Error('Synthetic verified-range checksum failure.');
      if (this.truncate) return;
      let pcm = part.value;
      if (
        upload.chunk.track_id === this.manifest.tracks[0]!.spec.track_id &&
        this.microphoneDelaySamples > 0
      ) {
        const delay = this.microphoneDelaySamples * 2;
        if (this.microphoneTail.length !== delay)
          this.microphoneTail = Buffer.alloc(delay);
        pcm = Buffer.alloc(part.value.length);
        this.microphoneTail.copy(pcm);
        part.value.copy(pcm, delay, 0, part.value.length - delay);
        this.microphoneTail = Buffer.from(
          part.value.subarray(part.value.length - delay),
        );
      }
      if (this.combinedHeader && second === 0)
        pcm = Buffer.concat([header, pcm]);
      if (this.retainBuffers) this.buffers.push(pcm);
      yield pcm;
    }
    if (this.lateFailure)
      throw new Error('Synthetic final WAV checksum failure.');
  }
}

function reportTracks(offset = 25, change = 0) {
  return (['microphone', 'loopback'] as const).map((kind) => ({
    kind,
    saved_samples: 3600 * 16_000,
    duplicate_marker_ids: [] as number[],
    unexpected_marker_ids: [] as number[],
    missing_marker_ids: [] as number[],
    markers: calibration.markerSeconds.map((second, index) => ({
      index,
      sample: second * 16_000,
      clock_ms:
        second * 1000 +
        (kind === 'microphone'
          ? offset + (change * index) / (calibration.markerSeconds.length - 1)
          : 0),
    })),
  }));
}

describe('calibration archive measurement', () => {
  it('streams both complete one-hour fixtures through bounded authenticated archive primitives', async () => {
    const native = new NativeFixture(3600);
    native.retainBuffers = false;
    const report = await measureCalibration(
      native,
      native.id,
      new AbortController().signal,
    );
    expect(native.exports).toBe(240);
    expect(native.requests).toBe(8);
    expect(report.complete_fixture_detected).toBe(true);
    expect(report.sampled_landmarks_within_target).toBe(true);
    expect(report.minimum_landmark_span_ms).toBe(3_560_000);
    expect(report.maximum_absolute_offset_ms).toBe(25);
    expect(report.end_to_end_offset_change_ms).toBe(0);
    expect(report.pairs).toHaveLength(13);
    expect(report.tracks.every((track) => track.markers.length === 13)).toBe(
      true,
    );
    expect(report.continuous_alignment_evaluated).toBe(false);
    expect(report.production_accepted).toBe(false);
    expect(report.archive_descriptor_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(report)).not.toContain('synthetic-microphone');
    expect(JSON.stringify(report)).not.toContain('data_base64');
  }, 30_000);

  it('reports missing markers and short media without accepting a calibration target', async () => {
    const native = new NativeFixture();
    const report = await measureCalibration(
      native,
      native.id,
      new AbortController().signal,
    );
    expect(report.pairs).toEqual([{ index: 0, offset_ms: 25 }]);
    expect(report.complete_fixture_detected).toBe(false);
    expect(report.sampled_landmarks_within_target).toBe(false);
    expect(report.tracks[0]!.missing_marker_ids).toHaveLength(12);
    expect(
      native.buffers.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it('measures actual waveform displacement as well as the authenticated chunk clock offset', async () => {
    const native = new NativeFixture();
    native.microphoneDelaySamples = 640;
    native.combinedHeader = true;
    const report = await measureCalibration(
      native,
      native.id,
      new AbortController().signal,
    );
    expect(report.pairs).toEqual([{ index: 0, offset_ms: 65 }]);
    expect(report.tracks[0]!.markers[0]!.sample).toBe(20 * 16_000 + 640);
    expect(report.tracks[1]!.markers[0]!.sample).toBe(20 * 16_000);
    expect(report.production_accepted).toBe(false);
  });

  it.each([
    'unsealed',
    'issues',
    'orphan',
    'totals',
    'legacy-clock',
    'paused',
    'one-track',
    'too-large',
  ])('rejects %s input before exporting PCM', async (scenario) => {
    const native = new NativeFixture();
    if (scenario === 'unsealed') native.inspection.state = 'interrupted';
    if (scenario === 'issues')
      native.inspection.issues.push({
        code: 'chunk_corrupt',
        message: 'Synthetic corruption.',
      });
    if (scenario === 'orphan') native.inspection.recovered_chunks = 1;
    if (scenario === 'totals') native.inspection.total_samples--;
    if (scenario === 'legacy-clock') native.manifest.events[0]!.code = null;
    if (scenario === 'paused')
      native.manifest.events[1]!.event_type = 'capture.paused';
    if (scenario === 'one-track') native.manifest.tracks.pop();
    if (scenario === 'too-large') {
      native.manifest.tracks[0]!.chunk_count = 123;
      native.manifest.tracks[0]!.saved_samples = 3661 * 16_000;
      native.inspection.total_samples = native.manifest.tracks.reduce(
        (sum, track) => sum + track.saved_samples,
        0,
      );
      native.inspection.verified_chunks = native.manifest.tracks.reduce(
        (sum, track) => sum + track.chunk_count,
        0,
      );
    }
    await expect(
      measureCalibration(native, native.id, new AbortController().signal),
    ).rejects.toThrow();
    expect(native.exports).toBe(0);
  });

  it.each([
    'wrong-page',
    'wrong-epoch',
    'sample-gap',
    'bad-header',
    'truncated',
    'range-failure',
    'late-checksum',
  ])(
    'rejects %s without printing or retaining exported buffers',
    async (scenario) => {
      const native = new NativeFixture();
      const chunk = native.chunks.values().next().value![0]!.chunk;
      if (scenario === 'wrong-page') native.wrongPage = true;
      if (scenario === 'wrong-epoch') chunk.capture_epoch = randomUUID();
      if (scenario === 'sample-gap') chunk.sample_start = 1;
      if (scenario === 'bad-header') native.corruptHeader = true;
      if (scenario === 'truncated') native.truncate = true;
      if (scenario === 'range-failure') native.readFailure = true;
      if (scenario === 'late-checksum') native.lateFailure = true;
      await expect(
        measureCalibration(native, native.id, new AbortController().signal),
      ).rejects.toThrow();
      expect(
        native.buffers.every((buffer) => buffer.every((byte) => byte === 0)),
      ).toBe(true);
    },
  );

  it('honors cancellation before any native request', async () => {
    const native = new NativeFixture();
    await expect(
      measureCalibration(native, native.id, AbortSignal.abort()),
    ).rejects.toThrow('cancelled');
    expect(native.requests).toBe(0);
  });

  it('bounds total analysis duration independently of per-request timeouts', async () => {
    const native = new NativeFixture();
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(300_001);
    try {
      await expect(
        measureCalibration(native, native.id, new AbortController().signal),
      ).rejects.toThrow('deadline');
      expect(native.requests).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('sampled calibration target', () => {
  it.each([160, -160])(
    'includes the detection margin at the signed %i ms boundary',
    (offset) => {
      const report = calibrationReport(
        randomUUID(),
        3_600_000,
        reportTracks(offset),
      );
      expect(report.sampled_landmarks_within_target).toBe(true);
      expect(report.maximum_absolute_offset_ms).toBe(160);
      expect(report.production_accepted).toBe(false);
    },
  );

  it.each([160.0001, -160.0001])(
    'does not round an out-of-target %i ms observation into acceptance',
    (offset) => {
      expect(
        calibrationReport(randomUUID(), 3_600_000, reportTracks(offset))
          .sampled_landmarks_within_target,
      ).toBe(false);
    },
  );

  it('measures offset change rather than averaging away long-session drift', () => {
    const report = calibrationReport(
      randomUUID(),
      3_600_000,
      reportTracks(-100, 300),
    );
    expect(report.end_to_end_offset_change_ms).toBe(300);
    expect(report.maximum_absolute_offset_ms).toBe(200);
    expect(report.sampled_landmarks_within_target).toBe(false);
  });

  it('rejects cumulative drift even when all individual offsets fit the absolute target', () => {
    const report = calibrationReport(
      randomUUID(),
      3_600_000,
      reportTracks(-100, 200),
    );
    expect(report.maximum_absolute_offset_ms).toBe(100);
    expect(report.maximum_offset_change_ms).toBe(200);
    expect(report.offset_change_margin_ms).toBe(80);
    expect(report.sampled_landmarks_within_target).toBe(false);
  });

  it.each([
    'duplicates',
    'unexpected',
    'missing',
    'reordered',
    'short-duration',
    'short-audio',
    'short-span',
  ])('does not accept %s as complete evidence', (scenario) => {
    const tracks = reportTracks();
    let duration = 3_600_000;
    if (scenario === 'duplicates') tracks[0]!.duplicate_marker_ids.push(0);
    if (scenario === 'unexpected') tracks[0]!.unexpected_marker_ids.push(15);
    if (scenario === 'missing') tracks[0]!.missing_marker_ids.push(0);
    if (scenario === 'reordered') tracks[0]!.markers[2]!.sample = 0;
    if (scenario === 'short-duration') duration = 1000;
    if (scenario === 'short-audio') tracks[0]!.saved_samples = 16_000;
    if (scenario === 'short-span')
      for (const track of tracks)
        for (const marker of track.markers) marker.clock_ms /= 2;
    const report = calibrationReport(randomUUID(), duration, tracks);
    expect(report.sampled_landmarks_within_target).toBe(false);
    expect(report.production_accepted).toBe(false);
  });
});

it('writes a new fixed WAV without overwriting an existing fixture', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'windows-ai-notes-calibration-'),
  );
  try {
    const path = await writeCalibrationFixture(directory);
    expect((await stat(path)).size).toBe(115_200_044);
    const file = await open(path, 'r');
    try {
      const header = Buffer.alloc(44);
      expect((await file.read(header, 0, 44, 0)).bytesRead).toBe(44);
      expect(header).toEqual(wavHeader(3600 * 16_000));
    } finally {
      await file.close();
    }
    await expect(writeCalibrationFixture(directory)).rejects.toThrow('EEXIST');
    expect((await stat(path)).size).toBe(115_200_044);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it('cancels fixture creation and removes only its newly created partial output', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'windows-ai-notes-calibration-cancel-'),
  );
  try {
    await expect(
      writeCalibrationFixture(directory, AbortSignal.timeout(50)),
    ).rejects.toThrow('cancelled');
    await expect(
      stat(join(directory, `${calibration.fixture}.wav`)),
    ).rejects.toThrow('ENOENT');
    await expect(
      writeCalibrationFixture(directory, AbortSignal.abort()),
    ).rejects.toThrow('cancelled');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('runs portable fixture creation through the real CLI without a native host or credentials', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'windows-ai-notes-calibration-cli-'),
  );
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [entry, 'calibration-audio', '--data-dir', directory],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim())).toEqual({
      fixture_path: join(directory, `${calibration.fixture}.wav`),
      seconds: 3600,
      production_accepted: false,
    });
    expect(
      (await stat(join(directory, `${calibration.fixture}.wav`))).size,
    ).toBe(115_200_044);
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          entry,
          'calibration-audio',
          '--seconds',
          '60',
          '--data-dir',
          directory,
        ],
        { timeout: 5000, maxBuffer: 64 * 1024 },
      ),
    ).rejects.toThrow('Calibration commands accept only');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
