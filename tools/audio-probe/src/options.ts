import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { audioRequestSchema } from '@windows-ai-notes/contracts';
import { randomUUID } from 'node:crypto';

export function parseOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      seconds: { type: 'string', default: '60' },
      microphone: { type: 'string', default: 'default' },
      loopback: { type: 'string', default: 'default' },
      'data-dir': { type: 'string', default: '.probe-data' },
      'pause-at': { type: 'string' },
      'pause-for': { type: 'string', default: '2' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || args.length === 0) return { help: true as const };
  const command = positionals[0];
  if (!['devices', 'record', 'inspect'].includes(command ?? '')) {
    throw new Error('Use devices, record, or inspect <recording-id>.');
  }
  if (positionals.length !== (command === 'inspect' ? 2 : 1)) {
    throw new Error('Unexpected or missing positional arguments.');
  }
  const seconds = Number(values.seconds);
  const pauseAt =
    values['pause-at'] === undefined ? undefined : Number(values['pause-at']);
  const pauseFor = Number(values['pause-for']);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('--seconds must be an integer from 1 to 3600.');
  }
  if (
    pauseAt !== undefined &&
    (!Number.isInteger(pauseAt) ||
      pauseAt < 1 ||
      pauseAt >= seconds ||
      !Number.isInteger(pauseFor) ||
      pauseFor < 1 ||
      pauseFor > 60 ||
      pauseAt + pauseFor >= seconds)
  ) {
    throw new Error(
      'The pause must fit within --seconds; --pause-for must be 1 to 60 seconds.',
    );
  }
  const recordingId = command === 'inspect' ? positionals[1]! : randomUUID();
  if (command === 'inspect') {
    audioRequestSchema.parse({
      protocol_version: 1,
      request_id: randomUUID(),
      command: 'inspect_recording',
      recording_id: recordingId,
    });
  }
  return {
    help: false as const,
    command,
    recordingId,
    seconds,
    pauseAt,
    pauseFor,
    microphone: values.microphone,
    loopback: values.loopback,
    dataDir: resolve(values['data-dir']),
  };
}
