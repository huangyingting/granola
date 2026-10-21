import { stdin, stdout } from 'node:process';
import {
  audioRequestSchema,
  encodeFrame,
  FrameDecoder,
} from '@windows-ai-notes/contracts';

const mode = process.argv[2];
if (mode === 'exit') process.exit(7);
const decoder = new FrameDecoder();
stdin.on('data', (bytes) => {
  for (const value of decoder.push(bytes)) {
    const request = audioRequestSchema.parse(value);
    if (mode === 'malformed') {
      stdout.write(Buffer.from([1, 0, 0, 0, 255]));
    } else {
      const frame = encodeFrame({
        protocol_version: 1,
        request_id: request.request_id,
        recording_id: null,
        event_type: 'devices',
        payload: { devices: [] },
      });
      for (const byte of frame) stdout.write(Buffer.from([byte]));
    }
  }
});
stdin.on('end', () => decoder.finish());
