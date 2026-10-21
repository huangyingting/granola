import { createHash } from 'node:crypto';
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
const recording = '75048e79-2b45-440f-8609-b80a37635b4a';
const track = 'ece5191a-347b-40a2-8d09-82565aa396a1';
const upload = {
  chunk: {
    format_version: 1,
    recording_id: recording,
    track_id: track,
    chunk_id: '9c73575e-426d-4f72-98ed-7b4479f890ab',
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
    if (request.command === 'list_devices') {
      const reply = () => send(request, 'devices', { devices: [] });
      if (mode === 'slow') setTimeout(reply, 100);
      else reply();
    } else if (request.command === 'list_recording_chunks') {
      if (mode === 'wrong-kind') send(request, 'devices', { devices: [] });
      else
        send(request, 'recording.chunks', {
          track_id: track,
          sequence_start: 0,
          chunks: [upload],
          has_more: false,
        });
    } else if (request.command === 'read_chunk') {
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
          mode === 'changed' ? { ...upload, sha256: '0'.repeat(64) } : upload,
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
