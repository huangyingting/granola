import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AudioHostClient } from './client.js';

it.skipIf(process.platform !== 'win32')(
  'exchanges real framed messages with AudioHost and shuts down cleanly on EOF',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'windows-ai-notes-stdio-'));
    const host = fileURLToPath(
      new URL(
        '../../../native/audio-host/AudioHost/bin/Release/net10.0-windows/AudioHost.dll',
        import.meta.url,
      ),
    );
    const events: string[] = [];
    const client = new AudioHostClient(
      'dotnet',
      [host, '--data-dir', root],
      (event) => {
        events.push(event.event_type);
      },
    );
    try {
      await expect(
        client.request({
          command: 'inspect_recording',
          recording_id: randomUUID(),
        }),
      ).rejects.toThrow('recording_not_found');
      expect(events).toEqual(['error']);
    } finally {
      try {
        await client.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
