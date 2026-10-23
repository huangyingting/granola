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
      'accept-incomplete': { type: 'boolean', default: false },
      'capture-clock': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || args.length === 0) return { help: true as const };
  const command = positionals[0];
  if (!['devices', 'record', 'inspect', 'recover'].includes(command ?? '')) {
    throw new Error(
      'Use devices, record, inspect <recording-id>, or recover <recording-id> --accept-incomplete.',
    );
  }
  const archive = command === 'inspect' || command === 'recover';
  const captureClock = values['capture-clock'];
  if (
    captureClock !== undefined &&
    (command !== 'record' || captureClock !== 'wasapi_qpc_v1')
  )
    throw new Error(
      'Only record accepts --capture-clock wasapi_qpc_v1 (experimental; physical acceptance required).',
    );
  if (positionals.length !== (archive ? 2 : 1)) {
    throw new Error('Unexpected or missing positional arguments.');
  }
  if ((command === 'recover') !== values['accept-incomplete'])
    throw new Error(
      'Only recover accepts, and requires, --accept-incomplete: the unsaved audio tail may be missing.',
    );
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
  const recordingId = archive ? positionals[1]! : randomUUID();
  if (archive) {
    audioRequestSchema.parse({
      protocol_version: 1,
      request_id: randomUUID(),
      ...(command === 'recover'
        ? { command: 'recover_recording', accept_incomplete: true }
        : { command: 'inspect_recording' }),
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
    captureClock,
    microphone: values.microphone,
    loopback: values.loopback,
    dataDir: resolve(values['data-dir']),
  };
}
