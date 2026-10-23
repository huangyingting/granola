import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameDecoder, encodeJsonFrame } from '@windows-ai-notes/contracts';
import { acquireRestartStartup, restartArguments } from './update-restart.js';

const native = vi.hoisted(() => ({ connect: vi.fn(), claim: vi.fn() }));
vi.mock('node:net', () => ({ createConnection: native.connect }));
vi.mock('./update-startup.js', () => ({
  acquireStartupAdmission: native.claim,
}));
const session = '11111111-1111-4111-8111-111111111111';
const args = {
  session,
  health: `WindowsAINotes.Restart.${session.replaceAll('-', '')}.${'a'.repeat(64)}`,
  authentication: `WindowsAINotes.RestartAuth.${session.replaceAll('-', '')}.${'b'.repeat(64)}`,
};
const argv = [
  `--update-restart=${session}`,
  `--update-health=${args.health}`,
  `--update-auth=${args.authentication}`,
];
const binding = {
  version: 1,
  event: 'update_restart_challenge',
  session_id: session,
  challenge: 'c'.repeat(64),
  identity: { pid: process.pid, creation_file_time: '134000000000000001' },
  application_version: '0.1.1',
};
const application = 'C:\\Installed app\\Synthetic.exe';
const helper = 'C:\\Installed app\\resources\\audio-host\\AudioHost.exe';
class Health extends EventEmitter {
  readonly sent: unknown[] = [];
  private closed = false;
  readonly write = vi.fn((chunk: Buffer) => {
    this.sent.push(...new FrameDecoder().push(chunk));
    return true;
  });
  readonly destroy = vi.fn(() => {
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close'));
    }
    return this;
  });
  frame(value: unknown) {
    this.emit('data', encodeJsonFrame(value));
  }
}
let health: Health;
beforeEach(() => {
  health = new Health();
  native.connect.mockReset().mockReturnValue(health);
  native.claim.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
function acquire() {
  return acquireRestartStartup(helper, application, '0.1.1', args);
}
async function admitted() {
  const pending = acquire();
  health.frame(binding);
  return pending;
}

describe('authenticated pre-storage restart startup', () => {
  it('accepts only one complete canonical session and both fixed local pipe endpoints', () => {
    expect(restartArguments(['app.exe'])).toBeNull();
    expect(restartArguments(['app.exe', ...argv])).toEqual(args);
    for (const invalid of [
      argv.slice(1),
      [...argv, argv[0]!],
      [...argv, '--update-unknown=x'],
      argv.map((arg) =>
        arg.replace(
          '11111111-1111-4111-8111-111111111111',
          '11111111-1111-1111-8111-111111111111',
        ),
      ),
      [argv[0]!, '--update-health=\\\\server\\pipe', argv[2]!],
      [argv[0]!, `--update-health=${args.health}\\extra`, argv[2]!],
      [argv[0]!, argv[1]!, `--update-auth=${args.health}`],
      [argv[0]!, `--update-health=${args.health.toUpperCase()}`, argv[2]!],
      ['--update-restart=', argv[1]!, argv[2]!],
    ])
      expect(() => restartArguments(invalid)).toThrow();
  });

  it('binds the native bridge to the ordinary socket challenge and waits for bridge closure before admitting storage', async () => {
    let release!: () => void;
    native.claim.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let ready = false;
    const pending = acquire().then((value) => {
      ready = true;
      return value;
    });
    for (const byte of encodeJsonFrame(binding))
      health.emit('data', Buffer.from([byte]));
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(native.connect).toHaveBeenCalledWith(`\\\\.\\pipe\\${args.health}`);
    expect(native.claim).toHaveBeenCalledWith(
      helper,
      application,
      '0.1.1',
      { binding, endpoint: args.authentication },
      expect.any(AbortSignal),
    );
    release();
    const startup = await pending;
    let confirmed = false;
    const confirmation = startup.confirm(8).then(() => {
      confirmed = true;
    });
    expect(health.sent).toEqual([
      { ...binding, event: 'update_restart_ready', storage_schema: 8 },
    ]);
    health.frame({ ...binding, event: 'update_restart_confirmed' });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    health.emit('close');
    await confirmation;
    startup.close();
    expect(confirmed).toBe(true);
  });

  it.each([
    { ...binding, event: 'update_restart_admitted' },
    { ...binding, session_id: '22222222-2222-4222-8222-222222222222' },
    { ...binding, identity: { ...binding.identity, pid: process.pid + 1 } },
    { ...binding, application_version: '0.1.2' },
    { ...binding, challenge: 'C'.repeat(64) },
    { ...binding, handle: 123 },
  ])('never starts a bridge for an invalid health binding', async (frame) => {
    const pending = acquire();
    health.frame(frame);
    await expect(pending).rejects.toMatchObject({
      code: 'update_restart_protocol',
    });
    expect(native.claim).not.toHaveBeenCalled();
  });

  it('cancels but drains an in-flight native bridge when the health channel disappears', async () => {
    let reject!: (error: Error) => void;
    native.claim.mockReturnValue(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    let stopped = false;
    const pending = acquire().catch((error: unknown) => {
      stopped = true;
      throw error;
    });
    health.frame(binding);
    await Promise.resolve();
    const signal: AbortSignal = native.claim.mock.calls[0]![4];
    health.emit('close');
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    reject(new Error('Native helper physically closed.'));
    await expect(pending).rejects.toMatchObject({
      code: 'update_restart_closed',
    });
  });

  it.each([
    'duplicate',
    'extension',
    'identity',
    'challenge',
    'truncated',
    'closed',
    'transport',
  ])(
    'rejects %s completion without releasing writable startup',
    async (mode) => {
      const startup = await admitted();
      const pending = startup.confirm(8);
      let frame: unknown = { ...binding, event: 'update_restart_confirmed' };
      if (mode === 'extension')
        frame = {
          ...binding,
          event: 'update_restart_confirmed',
          healthy: true,
        };
      if (mode === 'identity')
        frame = {
          ...binding,
          event: 'update_restart_confirmed',
          identity: {
            ...binding.identity,
            creation_file_time: '134000000000000002',
          },
        };
      if (mode === 'challenge')
        frame = {
          ...binding,
          event: 'update_restart_confirmed',
          challenge: 'd'.repeat(64),
        };
      if (mode === 'transport')
        health.emit('error', new Error('Synthetic pipe failure.'));
      else if (mode !== 'closed') {
        const bytes = encodeJsonFrame(frame);
        health.emit(
          'data',
          mode === 'truncated' ? bytes.subarray(0, -1) : bytes,
        );
        if (mode === 'duplicate') health.emit('data', bytes);
      }
      health.emit('close');
      await expect(pending).rejects.toBeInstanceOf(Error);
      startup.close();
    },
  );

  it.each([0, 65_536, 1.5, NaN])(
    'rejects unsupported schema report %s without writing readiness',
    async (schema) => {
      const startup = await admitted();
      await expect(startup.confirm(schema)).rejects.toMatchObject({
        code: 'update_restart_schema',
      });
      expect(health.sent).toEqual([]);
      startup.close();
    },
  );

  it('rejects cumulative output and repeated health attempts', async () => {
    const startup = await admitted();
    const pending = startup.confirm(8);
    await expect(startup.confirm(8)).rejects.toMatchObject({
      code: 'update_restart_used',
    });
    health.emit('data', Buffer.alloc(4097));
    await expect(pending).rejects.toMatchObject({
      code: 'update_restart_protocol',
    });
    startup.close();
  });

  it('does not equate a confirmed frame with health if the server never closes', async () => {
    vi.useFakeTimers();
    const startup = await admitted();
    const pending = startup.confirm(8);
    const result = pending.catch((error: unknown) => error);
    health.frame({ ...binding, event: 'update_restart_confirmed' });
    await vi.advanceTimersByTimeAsync(90_001);
    await expect(result).resolves.toMatchObject({
      code: 'update_restart_timeout',
    });
    startup.close();
  });

  it('preserves native authentication rejection and never sends a schema report', async () => {
    native.claim.mockRejectedValue(
      new Error('Synthetic unsigned bundle rejected.'),
    );
    const pending = acquire();
    health.frame(binding);
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(health.sent).toEqual([]);
  });
});
