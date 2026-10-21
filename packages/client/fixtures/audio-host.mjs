import { createHash, randomUUID } from 'node:crypto';
import {
  audioRequestSchema,
  encodeFrame,
  FrameDecoder,
} from '@windows-ai-notes/contracts';

const mode = process.argv[2];
const decoder = new FrameDecoder();
const wav = Buffer.alloc(65_580, 0x2a);
Buffer.from(
  '524946460000000057415645666d74201000000001000100803e0000007d0000020010006461746100000000',
  'hex',
).copy(wav);
wav.writeUInt32LE(wav.length - 8, 4);
wav.writeUInt32LE(wav.length - 44, 40);
const recording = process.argv[4] ?? '75048e79-2b45-440f-8609-b80a37635b4a';
const track = process.argv[5] ?? 'ece5191a-347b-40a2-8d09-82565aa396a1';
const upload = {
  chunk: {
    format_version: 1,
    recording_id: recording,
    track_id: track,
    chunk_id: process.argv[6] ?? '9c73575e-426d-4f72-98ed-7b4479f890ab',
    capture_epoch: 'e9393508-f494-417d-b968-9ebc3a5fd4c1',
    sequence: 0,
    sample_start: 0,
    sample_count: (wav.length - 44) / 2,
    sample_rate: 16_000,
    channels: 1,
    bits_per_sample: 16,
    clock_start_ms: 0,
    clock_end_ms: 2048,
    pcm_sha256: createHash('sha256').update(wav.subarray(44)).digest('hex'),
  },
  size_bytes: wav.length,
  sha256:
    mode === 'bad-hash'
      ? '0'.repeat(64)
      : createHash('sha256').update(wav).digest('hex'),
};
let capture = null;
let livePreview = null;
let savedSamples = 16_000;
let captureEpoch = randomUUID();
let levelClock = 100;
function sendLevels(request) {
  const payload = {
    capture_epoch: captureEpoch,
    clock_ms: levelClock,
    tracks: request.tracks.map((spec) => ({
      track_id: spec.track_id,
      level: { samples: 800, peak: 0.5, rms: 0.25, clock_ms: levelClock - 50 },
    })),
  };
  send(
    { request_id: null, recording_id: request.recording_id },
    'recording.levels',
    payload,
  );
  if (mode.startsWith('capture-level-bad-')) {
    const invalid = {
      ...payload,
      capture_epoch:
        mode === 'capture-level-bad-epoch' ? randomUUID() : captureEpoch,
      clock_ms:
        mode === 'capture-level-bad-clock' ? levelClock - 1 : levelClock + 1,
      tracks: payload.tracks.map((value) => ({
        ...value,
        track_id:
          mode === 'capture-level-bad-track' ? randomUUID() : value.track_id,
        level: {
          ...value.level,
          clock_ms: mode === 'capture-level-bad-reading' ? 1 : levelClock - 49,
        },
      })),
    };
    setTimeout(
      () =>
        send(
          { request_id: null, recording_id: request.recording_id },
          'recording.levels',
          invalid,
        ),
      10,
    );
  }
}
const recoveryTrack = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const archiveChunks = Array.from(
  { length: mode === 'archive-chunks' ? 51 : mode === 'archive-two' ? 2 : 1 },
  (_, index) => ({
    ...upload,
    chunk: {
      ...upload.chunk,
      chunk_id: index
        ? `${upload.chunk.chunk_id.slice(0, 24)}${index.toString(16).padStart(12, '0')}`
        : upload.chunk.chunk_id,
      sequence: index,
      sample_start: index * upload.chunk.sample_count,
      clock_start_ms: index * 2048,
      clock_end_ms: (index + 1) * 2048,
    },
  }),
);
const archiveEvents = [
  {
    event_type: 'capture.started',
    clock_ms: 0,
    capture_epoch: upload.chunk.capture_epoch,
    code: null,
  },
  ...(mode === 'archive-pages'
    ? Array.from({ length: 50 }, (_, index) => ({
        event_type: 'synthetic.event',
        clock_ms: index + 1,
        capture_epoch: null,
        code: null,
      }))
    : []),
  {
    event_type: 'capture.paused',
    clock_ms: archiveChunks.length * 2048,
    capture_epoch: upload.chunk.capture_epoch,
    code: null,
  },
  {
    event_type: 'capture.stopped',
    clock_ms: 1000 + archiveChunks.length * 2048,
    capture_epoch: null,
    code: null,
  },
];
let adopted = false;
function send(request, event_type, payload) {
  const frame = encodeFrame({
    protocol_version: 1,
    request_id: request.request_id,
    recording_id: request.recording_id ?? null,
    event_type,
    payload,
  });
  for (let offset = 0; offset < frame.length; offset += 47)
    process.stdout.write(frame.subarray(offset, offset + 47));
}
process.stdin.on('data', (bytes) => {
  for (const input of decoder.push(bytes)) {
    const request = audioRequestSchema.parse(input);
    if (mode.startsWith('archive') && request.command === 'inspect_recording') {
      send(request, 'recording.inspected', {
        state:
          mode === 'archive-incomplete'
            ? 'interrupted'
            : mode === 'archive-key-unavailable'
              ? 'key_unavailable'
              : 'sealed',
        verified_chunks: archiveChunks.length,
        recovered_chunks: mode === 'archive-orphan' ? 1 : 0,
        issues:
          mode === 'archive-corrupt'
            ? [{ code: 'chunk_corrupt', message: 'Synthetic damaged chunk.' }]
            : mode === 'archive-incomplete'
              ? [
                  {
                    code: 'unsealed_tail',
                    message: 'Synthetic interrupted tail.',
                  },
                ]
              : [],
        total_samples: upload.chunk.sample_count * archiveChunks.length,
      });
    } else if (
      mode.startsWith('archive') &&
      request.command === 'get_recording'
    ) {
      const offset = request.offset ?? 0;
      const events = archiveEvents.slice(offset, offset + 50);
      const spec = recoveryTrack ?? {
        track_id: track,
        kind: 'microphone',
        capture_scope: 'endpoint',
        device_selection_policy: 'explicit',
        device_id: 'synthetic',
      };
      send(request, 'recording.manifest', {
        format_version: 1,
        recording_id: request.recording_id,
        created_at: '2026-01-01T00:00:00.1239999+00:00',
        state: mode === 'archive-incomplete' ? 'failed' : 'sealed',
        tracks: [
          {
            spec:
              mode === 'archive-wrong-source'
                ? { ...spec, device_id: 'changed-source' }
                : spec,
            actual_device_id:
              spec.device_id === 'default'
                ? 'synthetic-default-microphone'
                : spec.device_id,
            saved_samples: upload.chunk.sample_count * archiveChunks.length,
            chunk_count: archiveChunks.length,
          },
        ],
        event_offset: mode === 'archive-bad-page' ? offset + 1 : offset,
        event_count:
          archiveEvents.length + (mode === 'archive-bad-page' ? 1 : 0),
        events,
        has_more: offset + events.length < archiveEvents.length,
      });
    } else if (
      request.command === 'start_recording' &&
      mode.startsWith('capture')
    ) {
      capture = request;
      send(request, 'recording.started', {
        state: 'recording',
        tracks: request.tracks.map((spec) => ({
          track_id: mode === 'capture-wrong-track' ? track : spec.track_id,
          saved_samples: savedSamples,
          device_id:
            spec.device_id === 'default'
              ? `synthetic-default-${spec.kind}`
              : spec.device_id,
          kind: spec.kind,
          capture_scope: spec.capture_scope,
          device_selection_policy: spec.device_selection_policy,
        })),
      });
      if (mode.startsWith('capture-level'))
        setTimeout(() => sendLevels(request), 20);
      if (mode === 'capture-fail')
        setTimeout(
          () =>
            send(
              { request_id: null, recording_id: request.recording_id },
              'error',
              {
                code: 'device_lost',
                message: 'Synthetic capture device disconnected.',
                retryable: true,
              },
            ),
          20,
        );
      if (mode === 'capture-fail-immediate')
        send(
          { request_id: null, recording_id: request.recording_id },
          'error',
          {
            code: 'device_lost',
            message: 'Synthetic capture device disconnected.',
            retryable: true,
          },
        );
    } else if (request.command === 'start_live_preview' && capture) {
      livePreview = {
        preview_id: randomUUID(),
        capture_epoch: captureEpoch,
        state: 'active',
        code: null,
        tracks: capture.tracks.map((spec) => ({
          track_id: spec.track_id,
          sample_end: null,
          buffered_samples: 0,
        })),
        frames: [],
      };
      send(request, 'recording.live_started', livePreview);
    } else if (
      ['read_live_audio', 'stop_live_preview'].includes(request.command) &&
      livePreview
    ) {
      if (request.preview_id !== livePreview.preview_id) {
        send(request, 'error', {
          code: 'live_preview_not_found',
          message: 'Unknown synthetic preview.',
          retryable: false,
        });
        continue;
      }
      if (
        request.command === 'stop_live_preview' &&
        livePreview.state === 'active'
      )
        livePreview = {
          ...livePreview,
          state: 'stopped',
          code: 'preview_stopped',
          frames: [],
        };
      if (mode === 'capture-live-overrun')
        livePreview = {
          ...livePreview,
          state: 'failed',
          code: 'live_overrun',
          frames: [],
        };
      const preview =
        mode === 'capture-live-wrong-preview'
          ? randomUUID()
          : livePreview.preview_id;
      const frames = [];
      if (livePreview.state === 'active') {
        for (const cursor of livePreview.tracks) {
          const start = cursor.sample_end ?? 16_000;
          const sequence = (start - 16_000) / 800;
          frames.push({
            format_version: 1,
            recording_id: request.recording_id,
            preview_id: preview,
            track_id:
              mode === 'capture-live-wrong-track'
                ? randomUUID()
                : cursor.track_id,
            capture_epoch: livePreview.capture_epoch,
            sequence,
            sample_start: start,
            sample_count: 800,
            sample_rate: 16_000,
            channels: 1,
            bits_per_sample: 16,
            clock_start_ms: sequence * 50,
            clock_end_ms: (sequence + 1) * 50,
            data_base64: Buffer.alloc(1600, 0x3b).toString('base64'),
          });
          cursor.sample_end = start + 800;
        }
      }
      send(
        request,
        request.command === 'read_live_audio'
          ? 'recording.live_audio'
          : 'recording.live_stopped',
        { ...livePreview, preview_id: preview, frames },
      );
    } else if (
      capture &&
      ['pause_recording', 'resume_recording', 'stop_recording'].includes(
        request.command,
      )
    ) {
      savedSamples += 16000;
      const state =
        request.command === 'pause_recording'
          ? 'paused'
          : request.command === 'resume_recording'
            ? 'recording'
            : 'sealed';
      if (livePreview && livePreview.state === 'active')
        livePreview = {
          ...livePreview,
          state: 'stopped',
          code: state === 'paused' ? 'capture_paused' : 'capture_stopped',
          frames: [],
        };
      send(
        request,
        `recording.${state === 'paused' ? 'paused' : state === 'recording' ? 'resumed' : 'stopped'}`,
        {
          state,
          tracks: capture.tracks.map((spec) => ({
            track_id: spec.track_id,
            saved_samples: savedSamples,
            device_id:
              spec.device_id === 'default'
                ? `synthetic-default-${spec.kind}`
                : spec.device_id,
            kind: spec.kind,
            capture_scope: spec.capture_scope,
            device_selection_policy: spec.device_selection_policy,
          })),
        },
      );
      if (mode.startsWith('capture-level') && state === 'recording') {
        captureEpoch = randomUUID();
        levelClock += 100;
        setTimeout(() => sendLevels(capture), 20);
      }
      if (mode === 'capture-auto-stop-paused' && state === 'paused') {
        setTimeout(
          () =>
            send(
              { request_id: null, recording_id: request.recording_id },
              'recording.stopped',
              {
                state: 'sealed',
                tracks: capture.tracks.map((spec) => ({
                  track_id: spec.track_id,
                  saved_samples: savedSamples,
                  device_id:
                    spec.device_id === 'default'
                      ? `synthetic-default-${spec.kind}`
                      : spec.device_id,
                  kind: spec.kind,
                  capture_scope: spec.capture_scope,
                  device_selection_policy: spec.device_selection_policy,
                })),
              },
            ),
          20,
        );
      }
    } else if (
      request.command === 'recover_recording' &&
      mode.startsWith('recovery')
    ) {
      adopted = true;
      const reply = () =>
        send(request, 'recording.recovered', {
          state: mode === 'recovery-claims-sealed' ? 'sealed' : 'interrupted',
          verified_chunks: 2,
          recovered_chunks: 0,
          issues: [
            {
              code: 'unsealed_tail',
              message: 'The synthetic unsaved tail remains incomplete.',
            },
          ],
          total_samples: 32000,
        });
      if (mode === 'recovery-slow') setTimeout(reply, 100);
      else reply();
    } else if (
      request.command === 'get_recording' &&
      ((mode.startsWith('recovery') && adopted) ||
        mode.startsWith('inspection') ||
        (mode === 'capture' && recoveryTrack))
    ) {
      send(request, 'recording.manifest', {
        format_version: 1,
        recording_id: request.recording_id,
        created_at: '2026-01-01T00:00:00+00:00',
        state: mode.startsWith('recovery') ? 'failed' : 'sealed',
        tracks: [
          {
            spec: mode.endsWith('wrong-track')
              ? { ...recoveryTrack, track_id: track }
              : mode.endsWith('wrong-source')
                ? {
                    ...recoveryTrack,
                    device_selection_policy: 'explicit',
                    device_id: 'unexpected-source',
                  }
                : recoveryTrack,
            actual_device_id: `synthetic-default-${recoveryTrack.kind}`,
            saved_samples: mode.endsWith('bad-count')
              ? 48000
              : mode.startsWith('recovery')
                ? 32000
                : 16000,
            chunk_count: mode.startsWith('recovery') ? 2 : 1,
          },
        ],
        event_offset: 0,
        event_count: 1,
        events: [
          {
            event_type: 'recovery.adopted',
            clock_ms: 2000,
            capture_epoch: null,
            code: 'unsealed_tail',
          },
        ],
        has_more: false,
      });
    } else if (
      request.command === 'inspect_recording' &&
      (mode.startsWith('capture') || mode.startsWith('inspection'))
    ) {
      send(request, 'recording.inspected', {
        state: 'sealed',
        verified_chunks: 1,
        recovered_chunks: 0,
        issues: [],
        total_samples: 16000,
      });
    } else if (request.command === 'list_devices') {
      const reply = () => send(request, 'devices', { devices: [] });
      if (mode === 'slow') setTimeout(reply, 100);
      else reply();
    } else if (request.command === 'list_recording_chunks') {
      if (mode === 'wrong-kind') send(request, 'devices', { devices: [] });
      else if (mode.startsWith('archive')) {
        const chunks = archiveChunks.slice(
          request.sequence_start,
          request.sequence_start + 50,
        );
        send(request, 'recording.chunks', {
          track_id: mode === 'archive-wrong-chunk' ? recording : track,
          sequence_start: request.sequence_start,
          chunks:
            mode === 'archive-wrong-chunk'
              ? chunks.map((c) => ({
                  ...c,
                  chunk: { ...c.chunk, track_id: recording },
                }))
              : chunks,
          has_more:
            request.sequence_start + chunks.length < archiveChunks.length,
        });
      } else
        send(request, 'recording.chunks', {
          track_id: track,
          sequence_start: 0,
          chunks: [upload],
          has_more: false,
        });
    } else if (request.command === 'read_chunk') {
      if (mode === 'archive-stall-read') continue;
      const rangeUpload = mode.startsWith('archive')
        ? archiveChunks.find(
            (chunk) => chunk.chunk.chunk_id === request.chunk_id,
          )
        : upload;
      if (!rangeUpload)
        throw new Error('The synthetic archive has no matching chunk.');
      if (mode === 'read-error') {
        send(request, 'error', {
          code: 'chunk_unreadable',
          message: 'Synthetic preserved-file failure.',
          retryable: false,
        });
        continue;
      }
      const end = Math.min(wav.length, request.offset + request.length);
      send(request, 'recording.chunk_range', {
        upload:
          mode === 'changed'
            ? { ...upload, sha256: '0'.repeat(64) }
            : rangeUpload,
        offset: mode === 'wrong-offset' ? request.offset + 1 : request.offset,
        data_base64: wav.subarray(request.offset, end).toString('base64'),
        end_of_chunk: end === wav.length,
      });
    } else {
      send(request, 'error', {
        code: 'invalid_request',
        message: 'Unsupported synthetic request.',
        retryable: false,
      });
    }
  }
});
process.stdin.on('end', () => decoder.finish());
