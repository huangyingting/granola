import {
  MAX_AUDIO_BYTES,
  ServiceError,
} from '@windows-ai-notes/contracts/server';

export function validateWav(bytes: Buffer): number {
  if (
    bytes.length < 46 ||
    bytes.length > MAX_AUDIO_BYTES ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16_000 ||
    bytes.readUInt32LE(28) !== 32_000 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0
  ) {
    throw new ServiceError(
      'invalid_audio',
      'Provide a canonical PCM16 mono 16 kHz WAV clip of at most 60 seconds.',
      400,
    );
  }
  return (bytes.length - 44) / 32;
}

export function makeSilentWav(milliseconds = 1000): Buffer {
  const samples = Math.round(milliseconds * 16);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
