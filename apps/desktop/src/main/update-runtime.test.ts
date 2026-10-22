import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeJsonFrame as encodeFrame } from '@windows-ai-notes/contracts';
import { holdUpdateRuntime } from './update-runtime.js';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: native.spawn,
}));
const application = 'C:\\Program Files\\Synthetic\\Synthetic.exe';
const helper =
  'C:\\Program Files\\Synthetic\\resources\\audio-host\\AudioHost.exe';
const directory =
  'C:\\Users\\Test\\AppData\\Local\\WindowsAINotes.UpdateWorkers\\worker-71c1213f-45b7-47d4-9a13-3c94b7a7f8ca';
const held = {
  version: 1,
  event: 'update_runtime_held',
  identity: { pid: process.pid, creation_file_time: '134000000000000001' },
  runtime: {
    directory,
    executable: `${directory}\\AudioHost.exe`,
    files: 12,
    bytes: 1024,
    sha256: 'a'.repeat(64),
  },
};
class Guardian extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closeOnRelease = true;
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
    return true;
  });
  constructor() {
    super();
    this.stdin.once('finish', () => {
      if (this.closeOnRelease)
        queueMicrotask(() => this.emit('close', 0, null));
    });
  }
}
let child: Guardian;
function prepare(signal?: AbortSignal) {
  return holdUpdateRuntime(helper, application, '0.1.0', 'Synthetic', signal);
}
beforeEach(() => {
  child = new Guardian();
  native.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Main-owned update runtime guardian', () => {
  it('validates arguments before spawning native code', async () => {
    await expect(
      holdUpdateRuntime(helper, '..\\Synthetic.exe', '0.1.0', 'Synthetic'),
    ).rejects.toMatchObject({
      code: 'update_path_invalid',
    });
    expect(native.spawn).not.toHaveBeenCalled();
    await expect(
      holdUpdateRuntime(
        'C:\\Other\\AudioHost.exe',
        application,
        '0.1.0',
        'Synthetic',
      ),
    ).rejects.toMatchObject({ code: 'update_installation_helper' });
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('reports a failed spawn without claiming that an unstarted guardian leaked Main handles', async () => {
    child.closeOnRelease = false;
    const pending = prepare();
    child.emit('error', new Error('Synthetic spawn failure.'));
    child.emit('close', -4058, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_worker_unavailable',
    });
  });

  it('uses the real Main PID, OS-only environment and a private EOF release channel', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'synthetic-not-a-key');
    vi.stubEnv(
      'WINDOWS_SIGNING_CERTIFICATE_PASSWORD',
      'synthetic-not-a-password',
    );
    const pending = prepare();
    for (const byte of encodeFrame(held))
      child.stdout.write(Buffer.from([byte]));
    const lease = await pending;
    lease.assertHeld();
    expect(lease.runtime).toEqual(held.runtime);
    expect(lease.identity).toEqual(held.identity);
    expect(native.spawn).toHaveBeenCalledWith(
      helper,
      [
        '--hold-update-runtime',
        String(process.pid),
        application,
        '0.1.0',
        'Synthetic',
      ],
      expect.objectContaining({
        stdio: 'pipe',
        windowsHide: true,
        cwd: 'C:\\Program Files\\Synthetic\\resources\\audio-host',
      }),
    );
    const options = native.spawn.mock.calls[0]![2];
    expect(options.env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(options.env.WINDOWS_SIGNING_CERTIFICATE_PASSWORD).toBeUndefined();
    await lease.release();
    await lease.release();
    expect(() => lease.assertHeld()).toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('waits for native release confirmation instead of assuming EOF closed every lease', async () => {
    child.closeOnRelease = false;
    const pending = prepare();
    child.stdout.write(encodeFrame(held));
    const lease = await pending;
    let finished = false;
    const released = lease.release().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() => lease.assertHeld()).toThrow();
    child.emit('close', 0, null);
    await released;
  });

  it('does not let an old prepare signal release protection after returning the lease', async () => {
    const abort = new AbortController();
    const pending = prepare(abort.signal);
    child.stdout.write(encodeFrame(held));
    const lease = await pending;
    abort.abort();
    lease.assertHeld();
    expect(child.stdin.writableEnded).toBe(false);
    await lease.release();
  });

  it.each([
    { ...held, identity: { ...held.identity, pid: process.pid + 1 } },
    {
      ...held,
      runtime: { ...held.runtime, executable: `${directory}\\Other.exe` },
    },
    {
      ...held,
      runtime: {
        ...held.runtime,
        directory: directory.replace('UpdateWorkers', 'Other'),
      },
    },
    {
      ...held,
      runtime: {
        ...held.runtime,
        directory: directory.replace('worker-', 'other-'),
      },
    },
    { ...held, installer_started: true },
  ])(
    'rejects mismatched or caller-selected runtime authority',
    async (frame) => {
      const pending = prepare();
      child.stdout.write(encodeFrame(frame));
      await expect(pending).rejects.toMatchObject({
        code: 'update_verifier_protocol',
      });
    },
  );

  it('rejects repeated ready frames even when both arrive before the caller resumes', async () => {
    const pending = prepare();
    child.stdout.write(Buffer.concat([encodeFrame(held), encodeFrame(held)]));
    await expect(pending).rejects.toMatchObject({
      code: 'update_verifier_protocol',
    });
  });

  it('surfaces a bounded native rejection after confirmed cleanup', async () => {
    child.closeOnRelease = false;
    const pending = prepare();
    child.stdout.write(
      encodeFrame({
        version: 1,
        event: 'update_runtime_failed',
        code: 'update_parent_mismatch',
      }),
    );
    child.emit('close', 2, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_parent_mismatch',
    });
  });

  it('rejects truncated output rather than accepting a clean process exit', async () => {
    const pending = prepare();
    child.stdout.write(encodeFrame(held).subarray(0, 9));
    child.emit('close', 0, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_verifier_protocol',
    });
  });

  it('requires app restart when the guardian crashes and Main-owned handles may remain', async () => {
    const pending = prepare();
    child.stdout.write(encodeFrame(held));
    const lease = await pending;
    child.emit('close', null, 'SIGKILL');
    expect(() => lease.assertHeld()).toThrow();
    await expect(lease.release()).rejects.toMatchObject({
      code: 'update_runtime_lease_uncertain',
    });
  });

  it.each(['stdout', 'stderr'] as const)(
    'surfaces %s transport errors during preparation',
    async (stream) => {
      const pending = prepare();
      child[stream].emit('error', new Error('Synthetic transport failure.'));
      await expect(pending).rejects.toMatchObject({
        code: 'update_runtime_transport',
      });
    },
  );

  it('rejects excessive diagnostics even after a valid ready frame', async () => {
    const pending = prepare();
    child.stdout.write(encodeFrame(held));
    const lease = await pending;
    child.stderr.write(Buffer.alloc(16_385));
    await expect(lease.release()).rejects.toMatchObject({
      code: 'update_verifier_protocol',
    });
  });

  it('cancels preparation through EOF and waits for cleanup', async () => {
    const abort = new AbortController();
    const pending = prepare(abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'update_cancelled' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports uncertain leases when a stalled guardian must be terminated', async () => {
    vi.useFakeTimers();
    child.closeOnRelease = false;
    const pending = prepare();
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'update_runtime_lease_uncertain',
    });
    await vi.advanceTimersByTimeAsync(65_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
