import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameDecoder, encodeJsonFrame } from '@windows-ai-notes/contracts';
import {
  acquireStartupAdmission,
  cleanupRetiredUpdateSessions,
  inspectUpdateSessions,
} from './update-startup.js';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: native.spawn,
}));
const application = 'C:\\Program Files\\Synthetic\\Synthetic.exe';
const helper =
  'C:\\Program Files\\Synthetic\\resources\\audio-host\\AudioHost.exe';
const ready = {
  version: 1,
  event: 'update_startup_admitted',
  identity: { pid: process.pid, creation_file_time: '134000000000000001' },
};
class Claim extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}
let child: Claim;
function claim() {
  return acquireStartupAdmission(helper, application, '0.1.0');
}
beforeEach(() => {
  child = new Claim();
  native.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Main-only read-only update inspection transport', () => {
  const report = {
    checked_at: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    active: 0,
    retired: 0,
    unverifiable: 0,
    limited: false,
    omitted: 0,
    sessions: [],
  };
  const frame = {
    version: 1,
    event: 'update_inspection_report',
    identity: ready.identity,
    report,
  };
  const inspect = (signal?: AbortSignal) =>
    inspectUpdateSessions(helper, application, '0.1.0', signal);
  it('uses fixed native inspection with no caller paths and waits for physical exit', async () => {
    let finished = false;
    const result = inspect().then((value) => {
      finished = true;
      return value;
    });
    child.stdout.write(encodeJsonFrame(frame));
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(native.spawn.mock.calls[0]![1]).toEqual([
      '--inspect-update-sessions',
      String(process.pid),
      application,
      '0.1.0',
    ]);
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close', 0, null);
    await expect(result).resolves.toEqual(report);
  });
  it.each([
    'startup',
    'cleanup',
    'identity',
    'counts',
    'status',
    'path',
    'duplicate',
    'truncated',
    'exit',
  ])(
    'rejects %s without returning an empty successful inspection',
    async (fault) => {
      const result = inspect();
      const value =
        fault === 'startup'
          ? ready
          : fault === 'cleanup'
            ? { ...frame, event: 'update_cleanup_report' }
            : {
                ...frame,
                ...(fault === 'identity'
                  ? { identity: { ...ready.identity, pid: process.pid + 1 } }
                  : {}),
                report: {
                  ...report,
                  ...(fault === 'counts' ? { active: 1 } : {}),
                  ...(fault === 'status' ? { status: 'partial' } : {}),
                  ...(fault === 'path'
                    ? { directory: 'C:\\private\\notes' }
                    : {}),
                },
              };
      const bytes = encodeJsonFrame(value);
      child.stdout.write(fault === 'truncated' ? bytes.subarray(0, -1) : bytes);
      if (fault === 'duplicate') child.stdout.write(bytes);
      child.emit('close', fault === 'exit' ? 2 : 0, null);
      await expect(result).rejects.toMatchObject({
        code:
          fault === 'exit'
            ? 'update_inspection_unavailable'
            : 'update_inspection_protocol',
      });
    },
  );
  it('reports a busy native lock without interpreting it as no unresolved records', async () => {
    const result = inspect();
    child.stdout.write(
      encodeJsonFrame({
        version: 1,
        event: 'update_inspection_failed',
        code: 'update_worker_busy',
      }),
    );
    child.emit('close', 2, null);
    await expect(result).rejects.toMatchObject({
      code: 'update_worker_busy',
      message: expect.stringContaining('records are busy'),
    });
  });
  it.each(['cancel', 'timeout'])(
    'physically drains on %s before shutdown can continue',
    async (reason) => {
      vi.useFakeTimers();
      const cancellation = new AbortController();
      let stopped = false;
      const result = inspect(cancellation.signal).catch((error: unknown) => {
        stopped = true;
        return error;
      });
      if (reason === 'cancel') cancellation.abort();
      else await vi.advanceTimersByTimeAsync(30_001);
      await vi.advanceTimersByTimeAsync(1001);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      child.emit('close', null, 'SIGTERM');
      await expect(result).resolves.toMatchObject({
        code:
          reason === 'cancel'
            ? 'update_inspection_cancelled'
            : 'update_inspection_timeout',
      });
    },
  );
});

describe('Main-only retired-session maintenance transport', () => {
  const report = {
    version: 1,
    event: 'update_cleanup_report',
    identity: ready.identity,
    status: 'complete',
    retired: 1,
    removed: 1,
    incomplete: 0,
    rejected: 0,
  };
  const cleanup = (signal?: AbortSignal) =>
    cleanupRetiredUpdateSessions(helper, application, '0.1.0', signal);

  it.each(['complete', 'pending'])(
    'waits for physical closure and preserves the explicit %s report',
    async (status) => {
      let finished = false;
      const pending = cleanup().then((value) => {
        finished = true;
        return value;
      });
      const frame = {
        ...report,
        status,
        incomplete: status === 'pending' ? 1 : 0,
      };
      child.stdout.write(encodeJsonFrame(frame));
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(native.spawn.mock.calls[0]![1]).toEqual([
        '--cleanup-update-sessions',
        String(process.pid),
        application,
        '0.1.0',
      ]);
      expect(child.stdin.writableEnded).toBe(true);
      child.emit('close', 0, null);
      await expect(pending).resolves.toEqual(frame);
    },
  );

  it.each([
    'identity',
    'counts',
    'status',
    'extra',
    'duplicate',
    'truncated',
    'nonzero',
  ])(
    'rejects %s reports without treating maintenance as startup admission',
    async (fault) => {
      const pending = cleanup();
      const frame = {
        ...report,
        ...(fault === 'identity'
          ? { identity: { ...ready.identity, pid: process.pid + 1 } }
          : {}),
        ...(fault === 'counts' ? { retired: 5 } : {}),
        ...(fault === 'status' ? { incomplete: 1 } : {}),
        ...(fault === 'extra' ? { path: 'C:\\arbitrary\\notes.sqlite' } : {}),
      };
      const bytes = encodeJsonFrame(frame);
      child.stdout.write(fault === 'truncated' ? bytes.subarray(0, -1) : bytes);
      if (fault === 'duplicate') child.stdout.write(bytes);
      child.emit('close', fault === 'nonzero' ? 2 : 0, null);
      await expect(pending).rejects.toBeInstanceOf(Error);
    },
  );

  it('cannot accept an ordinary startup success as a maintenance report', async () => {
    const pending = cleanup();
    child.stdout.write(encodeJsonFrame(ready));
    child.emit('close', 0, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_cleanup_protocol',
    });
  });

  it('propagates native recovery rejection rather than returning empty successful cleanup', async () => {
    const pending = cleanup();
    child.stdout.write(
      encodeJsonFrame({
        version: 1,
        event: 'update_cleanup_failed',
        code: 'update_recovery_required',
      }),
    );
    child.emit('close', 2, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_recovery_required',
    });
  });

  it('cancels and physically drains the maintenance helper before shutdown can finish', async () => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    let stopped = false;
    const result = cleanup(cancellation.signal).catch((error: unknown) => {
      stopped = true;
      return error;
    });
    cancellation.abort();
    await vi.advanceTimersByTimeAsync(1001);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({
      code: 'update_cleanup_cancelled',
    });
  });

  it('bounds maintenance time without returning before the child closes', async () => {
    vi.useFakeTimers();
    let stopped = false;
    const result = cleanup().catch((error: unknown) => {
      stopped = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({
      code: 'update_cleanup_timeout',
    });
  });
});

describe('pre-storage Main startup admission', () => {
  it.each([
    'update_recovery_required',
    'update_recovery_invalid',
    'update_recovery_unavailable',
    'update_recovery_limit',
  ])(
    'surfaces %s without offering a retry, rollback or database reset',
    async (code) => {
      const pending = claim();
      child.stdout.write(
        encodeJsonFrame({ version: 1, event: 'update_startup_failed', code }),
      );
      child.emit('close', 2, null);
      await expect(pending).rejects.toMatchObject({
        code,
        message: expect.stringContaining(
          'no installer was retried and no backup was restored',
        ),
      });
    },
  );

  it('requires an original bundled helper before spawning anything', async () => {
    await expect(
      acquireStartupAdmission('C:\\Other\\AudioHost.exe', application, '0.1.0'),
    ).rejects.toMatchObject({ code: 'update_installation_helper' });
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('uses a challenge-bound restart bridge and waits for its successful physical closure', async () => {
    const binding = {
      version: 1 as const,
      event: 'update_restart_challenge' as const,
      session_id: '11111111-1111-4111-8111-111111111111',
      challenge: 'a'.repeat(64),
      identity: ready.identity,
      application_version: '0.1.0',
    };
    const endpoint = `WindowsAINotes.RestartAuth.${binding.session_id.replaceAll('-', '')}.${'b'.repeat(64)}`;
    const sent: unknown[] = [];
    const decoder = new FrameDecoder();
    child.stdin.on('data', (chunk: Buffer) =>
      sent.push(...decoder.push(chunk)),
    );
    let finished = false;
    const pending = acquireStartupAdmission(helper, application, '0.1.0', {
      binding,
      endpoint,
    }).then(() => {
      finished = true;
    });
    child.stdout.write(
      encodeJsonFrame({ ...binding, event: 'update_restart_admitted' }),
    );
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(sent).toEqual([
      { ...binding, event: 'update_restart_authenticate', endpoint },
    ]);
    expect(native.spawn.mock.calls[0]![1][0]).toBe('--claim-update-restart');
    child.emit('close', 0, null);
    await pending;
  });

  it.each([
    'challenge',
    'creation',
    'session',
    'version',
    'nonzero',
    'duplicate',
  ])(
    'rejects %s restart admission even when the basic startup PID matches',
    async (mode) => {
      const binding = {
        version: 1 as const,
        event: 'update_restart_challenge' as const,
        session_id: '11111111-1111-4111-8111-111111111111',
        challenge: 'a'.repeat(64),
        identity: ready.identity,
        application_version: '0.1.0',
      };
      const admitted = { ...binding, event: 'update_restart_admitted' };
      if (mode === 'challenge') admitted.challenge = 'b'.repeat(64);
      if (mode === 'creation')
        admitted.identity = {
          ...ready.identity,
          creation_file_time: '134000000000000002',
        };
      if (mode === 'session')
        admitted.session_id = '22222222-2222-4222-8222-222222222222';
      if (mode === 'version') admitted.application_version = '0.1.1';
      const pending = acquireStartupAdmission(helper, application, '0.1.0', {
        binding,
        endpoint: 'Synthetic endpoint rejected by native production validation',
      });
      child.stdout.write(encodeJsonFrame(admitted));
      if (mode === 'duplicate') child.stdout.write(encodeJsonFrame(admitted));
      child.emit('close', mode === 'nonzero' ? 2 : 0, null);
      await expect(pending).rejects.toBeInstanceOf(Error);
    },
  );

  it('uses actual Main identity and OS-only environment and waits for confirmed helper exit after ready', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'synthetic-not-a-secret');
    let admitted = false;
    const pending = claim().then(() => {
      admitted = true;
    });
    for (const byte of encodeJsonFrame(ready))
      child.stdout.write(Buffer.from([byte]));
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close', 0, null);
    await pending;
    expect(admitted).toBe(true);
    expect(native.spawn).toHaveBeenCalledWith(
      helper,
      ['--claim-update-startup', String(process.pid), application, '0.1.0'],
      expect.objectContaining({ windowsHide: true, stdio: 'pipe' }),
    );
    expect(
      native.spawn.mock.calls[0]![2].env.AZURE_OPENAI_API_KEY,
    ).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { ...ready, identity: { ...ready.identity, pid: process.pid + 1 } },
    {
      ...ready,
      identity: { ...ready.identity, creation_file_time: 134000000000000001 },
    },
    { ...ready, identity: { ...ready.identity, handle: 42 } },
    { ...ready, installation_enabled: true },
    { ...ready, event: 'update_runtime_held' },
  ])('rejects mismatched authority and protocol extensions', async (frame) => {
    const pending = claim();
    child.stdout.write(encodeJsonFrame(frame));
    child.emit('close', 0, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_startup_protocol',
    });
  });

  it.each(['duplicate', 'truncated', 'missing', 'nonzero', 'signal'])(
    'does not treat %s completion as admission',
    async (scenario) => {
      const pending = claim();
      if (scenario !== 'missing') {
        const frame = encodeJsonFrame(ready);
        child.stdout.write(
          scenario === 'truncated'
            ? frame.subarray(0, frame.length - 1)
            : frame,
        );
        if (scenario === 'duplicate') child.stdout.write(frame);
      }
      child.emit(
        'close',
        scenario === 'nonzero' ? 2 : 0,
        scenario === 'signal' ? 'SIGTERM' : null,
      );
      await expect(pending).rejects.toBeInstanceOf(Error);
    },
  );

  it('surfaces native busy without authorizing local-key access or a retry in the same process', async () => {
    const pending = claim();
    child.stdout.write(
      encodeJsonFrame({
        version: 1,
        event: 'update_startup_failed',
        code: 'update_worker_busy',
      }),
    );
    child.emit('close', 2, null);
    await expect(pending).rejects.toMatchObject({
      code: 'update_worker_busy',
      message: expect.stringContaining('Local data was not opened'),
    });
  });

  it.each(['child', 'stdin', 'stdout', 'stderr'])(
    'handles repeated %s errors while still awaiting physical close',
    async (source) => {
      const pending = claim();
      const emitter =
        source === 'child'
          ? child
          : source === 'stdin'
            ? child.stdin
            : source === 'stdout'
              ? child.stdout
              : child.stderr;
      emitter.emit('error', new Error('Synthetic transport error.'));
      emitter.emit('error', new Error('Repeated synthetic transport error.'));
      child.emit('close', 2, null);
      await expect(pending).rejects.toMatchObject({
        code:
          source === 'child'
            ? 'update_startup_unavailable'
            : 'update_startup_transport',
      });
    },
  );

  it.each(['stdout', 'stderr'])(
    'enforces the cumulative %s byte bound',
    async (source) => {
      const pending = claim();
      const stream = source === 'stdout' ? child.stdout : child.stderr;
      stream.write(Buffer.alloc(8_192));
      stream.write(Buffer.alloc(8_193));
      child.emit('close', 0, null);
      await expect(pending).rejects.toMatchObject({
        code: 'update_startup_protocol',
      });
    },
  );

  it('never equates a timeout or kill request with successful admission or physical close', async () => {
    vi.useFakeTimers();
    const pending = claim();
    let finished = false;
    const result = pending.catch((error: unknown) => {
      finished = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({
      code: 'update_startup_timeout',
    });
  });
});
