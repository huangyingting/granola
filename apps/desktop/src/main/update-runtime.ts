import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { FrameDecoder } from '@windows-ai-notes/contracts';
import {
  heldUpdateRuntimeSchema,
  updateRuntimeFailureSchema,
} from '@windows-ai-notes/contracts/updates';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';
import { installationArguments } from './update-trust.js';

type HeldRuntime = ReturnType<typeof heldUpdateRuntimeSchema.parse>;

export interface HeldUpdateRuntime {
  readonly runtime: HeldRuntime['runtime'];
  readonly identity: HeldRuntime['identity'];
  assertHeld(): void;
  release(): Promise<void>;
}

export async function holdUpdateRuntime(
  helper: string,
  application: string,
  version: string,
  product: string,
  signal?: AbortSignal,
): Promise<HeldUpdateRuntime> {
  installationArguments(helper, application, version, product);
  if (
    win32.normalize(helper) !== helper ||
    helper.toLowerCase() !==
      win32
        .join(
          win32.dirname(application),
          'resources',
          'audio-host',
          'AudioHost.exe',
        )
        .toLowerCase()
  )
    throw new LocalError(
      'update_installation_helper',
      'Runtime protection requires the original bundled helper.',
    );
  signal?.throwIfAborted();
  const child = spawn(
    helper,
    [
      '--hold-update-runtime',
      String(process.pid),
      application,
      version,
      product,
    ],
    {
      cwd: win32.dirname(helper),
      env: audioHostEnvironment(process.env),
      windowsHide: true,
      stdio: 'pipe',
    },
  );
  const decoder = new FrameDecoder();
  let held: HeldRuntime | null = null;
  let failure: LocalError | null = null;
  let failureFrame = false;
  let exited = false;
  let releasing = false;
  let forced = false;
  let spawned = false;
  let spawnFailed = false;
  let outputBytes = 0;
  let errorBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady!: (value: HeldRuntime) => void;
  let rejectReady!: (error: LocalError) => void;
  const ready = new Promise<HeldRuntime>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed!: (value: {
    code: number | null;
    signal: string | null;
  }) => void;
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      resolveClosed = resolve;
    },
  );
  const stop = () => {
    if (!releasing) {
      releasing = true;
      child.stdin.end();
    }
    if (!exited && killTimer === null)
      killTimer = setTimeout(() => {
        forced = true;
        child.kill();
      }, 5_000);
  };
  const fail = (code: string, message: string) => {
    failure ??= new LocalError(code, message);
    rejectReady(failure);
    stop();
  };
  const abort = () =>
    fail(
      'update_cancelled',
      'Runtime preparation was cancelled. No installer was started.',
    );
  const prepareTimer = setTimeout(
    () =>
      fail(
        'update_runtime_timeout',
        'Runtime preparation timed out. No installer was started.',
      ),
    60_000,
  );
  signal?.addEventListener('abort', abort, { once: true });
  child.once('spawn', () => {
    spawned = true;
  });
  child.once('error', () => {
    spawnFailed = !spawned && child.pid === undefined;
    fail(
      'update_worker_unavailable',
      'The native runtime guardian could not start.',
    );
  });
  child.stdin.on('error', () =>
    fail(
      'update_runtime_transport',
      'The native runtime lease channel failed.',
    ),
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('error', () =>
      fail(
        'update_runtime_transport',
        'The native runtime response channel failed.',
      ),
    );
  child.stdout.on('data', (chunk: Buffer) => {
    spawned = true;
    outputBytes += chunk.length;
    try {
      if (outputBytes > 16_384) throw new Error('Output bound exceeded.');
      for (const frame of decoder.push(chunk)) {
        const rejected = updateRuntimeFailureSchema.safeParse(frame);
        if (rejected.success && !failureFrame) {
          failureFrame = true;
          fail(
            rejected.data.code,
            'The native runtime guardian rejected preparation or release.',
          );
          continue;
        }
        const parsed = heldUpdateRuntimeSchema.safeParse(frame);
        if (held !== null || failure !== null || !parsed.success)
          throw new Error('Invalid runtime response.');
        const runtime = parsed.data.runtime;
        if (
          parsed.data.identity.pid !== process.pid ||
          win32.basename(win32.dirname(runtime.directory)) !==
            'WindowsAINotes.UpdateWorkers' ||
          win32.normalize(runtime.directory) !== runtime.directory ||
          /[:"<>|?*]/u.test(runtime.directory.slice(2)) ||
          !/^worker-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            win32.basename(runtime.directory),
          ) ||
          runtime.executable !== win32.join(runtime.directory, 'AudioHost.exe')
        )
          throw new Error('Mismatched runtime response.');
        held = parsed.data;
        clearTimeout(prepareTimer);
        signal?.removeEventListener('abort', abort);
        resolveReady(held);
      }
    } catch {
      fail(
        'update_verifier_protocol',
        'The native runtime guardian returned invalid metadata.',
      );
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > 16_384)
      fail(
        'update_verifier_protocol',
        'The native runtime guardian exceeded its diagnostic bound.',
      );
  });
  child.once('close', (code, exitSignal) => {
    exited = true;
    clearTimeout(prepareTimer);
    if (killTimer !== null) clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    try {
      decoder.finish();
    } catch {
      failure ??= new LocalError(
        'update_verifier_protocol',
        'The native runtime response was incomplete.',
      );
    }
    if (!releasing || held === null || code !== 0)
      failure ??= new LocalError(
        'update_runtime_closed',
        'The native runtime guardian exited before a successful release.',
      );
    if (failure !== null) rejectReady(failure);
    resolveClosed({ code, signal: exitSignal });
  });
  const finish = async () => {
    stop();
    const result = await closed;
    if (
      !spawnFailed &&
      (forced ||
        result.signal !== null ||
        (result.code !== 0 && !(result.code === 2 && failureFrame)))
    )
      throw new LocalError(
        'update_runtime_lease_uncertain',
        'Runtime lease cleanup could not be confirmed. Restart the app before another installation attempt.',
      );
    if (failure !== null) throw failure;
  };
  try {
    const result = await ready;
    signal?.throwIfAborted();
    if (failure !== null) throw failure;
    if (exited || releasing)
      throw new LocalError(
        'update_runtime_closed',
        'The runtime closed before preparation completed.',
      );
    return {
      runtime: result.runtime,
      identity: result.identity,
      assertHeld() {
        if (failure !== null) throw failure;
        if (exited || releasing)
          throw new LocalError(
            'update_runtime_closed',
            'The runtime is no longer protected for process loading.',
          );
      },
      release: finish,
    };
  } catch (error) {
    await finish();
    throw error;
  }
}
