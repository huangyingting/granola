import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AudioHostClient } from './client.js';

const fixture = fileURLToPath(new URL('../fixtures/host.mjs', import.meta.url));

describe('AudioHost process lifecycle', () => {
  it('matches fragmented responses to requests and exits on stdin EOF', async () => {
    const events: string[] = [];
    const client = new AudioHostClient(
      process.execPath,
      [fixture, 'echo'],
      (event) => {
        events.push(event.event_type);
      },
    );
    try {
      expect(await client.request({ command: 'list_devices' })).toMatchObject({
        event_type: 'devices',
        payload: { devices: [] },
      });
      expect(events).toEqual(['devices']);
    } finally {
      await client.close();
    }
  });

  it('does not hang or claim success if the host exits early', async () => {
    const client = new AudioHostClient(
      process.execPath,
      [fixture, 'exit'],
      () => undefined,
    );
    await expect(client.request({ command: 'list_devices' })).rejects.toThrow(
      /AudioHost exited|EPIPE/,
    );
    await expect(client.close()).rejects.toThrow();
  });

  it('rejects malformed host frames and still closes the child process', async () => {
    const client = new AudioHostClient(
      process.execPath,
      [fixture, 'malformed'],
      () => undefined,
    );
    await expect(client.request({ command: 'list_devices' })).rejects.toThrow();
    await expect(client.close()).rejects.toThrow();
  });
});
