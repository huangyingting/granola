import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { FrameDecoder } from '@windows-ai-notes/contracts';
import {
  updateStartupAdmittedSchema,
  updateStartupFailureSchema,
} from '@windows-ai-notes/contracts/updates';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';
import { installationArguments } from './update-trust.js';

export async function acquireStartupAdmission(
  helper: string,
  application: string,
  version: string,
): Promise<void> {
  installationArguments(
    helper,
    application,
    version,
    win32.basename(application),
  );
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
      'Startup admission requires the original bundled helper.',
    );
  const child = spawn(
    helper,
    ['--claim-update-startup', String(process.pid), application, version],
    {
      cwd: win32.dirname(helper),
      env: audioHostEnvironment(process.env),
      windowsHide: true,
      stdio: 'pipe',
    },
  );
  const decoder = new FrameDecoder();
  let ready = false;
  let response = false;
  let failure: LocalError | null = null;
  let outputBytes = 0;
  let diagnosticBytes = 0;
  let closed = false;
  let settle!: () => void;
  const stopped = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = (code: string, message: string) => {
    failure ??= new LocalError(code, message);
    if (!closed && killTimer === undefined)
      killTimer = setTimeout(() => {
        child.kill();
      }, 1_000);
  };
  const timer = setTimeout(() => {
    fail(
      'update_startup_timeout',
      'Startup admission timed out. Close and reopen the app after installation finishes. Local data was not opened.',
    );
  }, 30_000);
  child.on('error', () =>
    fail(
      'update_startup_unavailable',
      'Startup protection could not start. Reinstall a complete application package; local data was not opened.',
    ),
  );
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.on('error', () =>
      fail(
        'update_startup_transport',
        'Startup protection lost its private channel. Close and reopen the app; local data was not opened.',
      ),
    );
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    try {
      if (outputBytes > 16_384) throw new Error('Output bound exceeded.');
      for (const frame of decoder.push(chunk)) {
        if (response) throw new Error('Repeated startup response.');
        response = true;
        const rejected = updateStartupFailureSchema.safeParse(frame);
        if (rejected.success) {
          fail(
            rejected.data.code,
            rejected.data.code === 'update_worker_busy'
              ? 'An update or another app process still owns startup admission. Close this window and reopen the app after it finishes. Local data was not opened.'
              : 'Startup protection rejected this application. Close and reopen the app, or reinstall a complete package. Existing local data was not opened.',
          );
          continue;
        }
        const admitted = updateStartupAdmittedSchema.safeParse(frame);
        if (!admitted.success || admitted.data.identity.pid !== process.pid)
          throw new Error('Invalid startup identity.');
        ready = true;
      }
    } catch {
      fail(
        'update_startup_protocol',
        'Startup protection returned invalid metadata. Close and reopen the app; local data was not opened.',
      );
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 16_384)
      fail(
        'update_startup_protocol',
        'Startup protection exceeded its diagnostic bound. Close and reopen the app; local data was not opened.',
      );
  });
  child.once('close', (code, signal) => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    try {
      decoder.finish();
    } catch {
      fail(
        'update_startup_protocol',
        'Startup protection returned an incomplete response. Close and reopen the app; local data was not opened.',
      );
    }
    if (code !== 0 || signal !== null || !ready)
      fail(
        'update_startup_unavailable',
        'Startup admission could not be confirmed. Close and reopen the app; local data was not opened.',
      );
    settle();
  });
  child.stdin.end();
  await stopped;
  if (failure !== null) throw failure;
}
