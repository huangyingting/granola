import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioHostClient } from './audio.js';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: native.spawn,
}));

class Helper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => false);
}
let child: Helper;
beforeEach(() => {
  vi.useFakeTimers();
  child = new Helper();
  native.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => {
  child.emit('close', 0);
  vi.useRealTimers();
});

describe('physical audio helper termination evidence', () => {
  it('does not treat a child error as confirmed process and pipe closure', async () => {
    const client = new AudioHostClient('Synthetic.exe', [], () => {});
    let stopped = false;
    void client.stopped.then(() => {
      stopped = true;
    });
    const failure = new Error('Synthetic child error before close.');
    child.emit('error', failure);
    await expect(client.close()).rejects.toBe(failure);
    expect(stopped).toBe(false);
    child.emit('close', 0);
    await client.stopped;
    expect(stopped).toBe(true);
  });

  it('keeps physical termination pending after a timed-out close and unsuccessful kill', async () => {
    const client = new AudioHostClient('Synthetic.exe', [], () => {});
    let stopped = false;
    void client.stopped.then(() => {
      stopped = true;
    });
    const closing = client.close();
    const rejected = expect(closing).rejects.toThrow('did not stop after EOF');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    child.emit('close', 0);
    await client.stopped;
    expect(stopped).toBe(true);
  });

  it('confirms physical closure even when a nonzero native exit is not successful capture', async () => {
    const client = new AudioHostClient('Synthetic.exe', [], () => {});
    const closing = client.close();
    const rejected = expect(closing).rejects.toThrow('exited with code 2');
    child.emit('close', 2);
    await Promise.all([rejected, client.stopped]);
  });
});
