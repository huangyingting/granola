import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { FrameDecoder, encodeJsonFrame } from '@windows-ai-notes/contracts';
import {
  updateStartupAdmittedSchema,
  updateStartupFailureSchema,
  updateRestartAdmittedSchema,
  updateRestartFailureSchema,
  updateRestartChallengeSchema,
  updateCleanupReportSchema,
  updateCleanupFailureSchema,
  updateInspectionReportSchema,
  updateInspectionFailureSchema,
} from '@windows-ai-notes/contracts/updates';
import type { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';
import { installationArguments } from './update-trust.js';

export async function acquireStartupAdmission(
  helper: string,
  application: string,
  version: string,
  restart?: {
    binding: z.infer<typeof updateRestartChallengeSchema>;
    endpoint: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  await invokeStartupHelper(helper, application, version, restart, signal);
}

export async function cleanupRetiredUpdateSessions(
  helper: string,
  application: string,
  version: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof updateCleanupReportSchema>> {
  const report = await invokeStartupHelper(
    helper,
    application,
    version,
    undefined,
    signal,
    'cleanup',
  );
  if (report?.event !== 'update_cleanup_report')
    throw new LocalError(
      'update_cleanup_protocol',
      'Update session maintenance returned no report.',
    );
  return report;
}

export async function inspectUpdateSessions(
  helper: string,
  application: string,
  version: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof updateInspectionReportSchema>['report']> {
  const response = await invokeStartupHelper(
    helper,
    application,
    version,
    undefined,
    signal,
    'inspection',
  );
  if (response?.event !== 'update_inspection_report')
    throw new LocalError(
      'update_inspection_protocol',
      'Update recovery inspection returned no report.',
    );
  return response.report;
}

async function invokeStartupHelper(
  helper: string,
  application: string,
  version: string,
  restart?: {
    binding: z.infer<typeof updateRestartChallengeSchema>;
    endpoint: string;
  },
  signal?: AbortSignal,
  maintenance?: 'cleanup' | 'inspection',
): Promise<
  | z.infer<typeof updateCleanupReportSchema>
  | z.infer<typeof updateInspectionReportSchema>
  | null
> {
  signal?.throwIfAborted();
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
    [
      maintenance === 'inspection'
        ? '--inspect-update-sessions'
        : maintenance === 'cleanup'
          ? '--cleanup-update-sessions'
          : restart
            ? '--claim-update-restart'
            : '--claim-update-startup',
      String(process.pid),
      application,
      version,
    ],
    {
      cwd: win32.dirname(helper),
      env: audioHostEnvironment(process.env),
      windowsHide: true,
      stdio: 'pipe',
    },
  );
  const decoder = new FrameDecoder();
  let ready = false;
  let report:
    | z.infer<typeof updateCleanupReportSchema>
    | z.infer<typeof updateInspectionReportSchema>
    | null = null;
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
    if (maintenance) {
      code = code.replace(/^update_startup_/u, `update_${maintenance}_`);
      message =
        maintenance === 'cleanup'
          ? 'Update session maintenance could not be confirmed. Unresolved update records and notes were not changed.'
          : code === 'update_worker_busy'
            ? 'Update records are busy. Wait for installation or maintenance to finish, then inspect again. No notes were opened.'
            : 'Update recovery records could not be inspected. No recovery blocks were cleared and no notes were opened.';
    }
    failure ??= new LocalError(code, message);
    if (!closed && killTimer === undefined)
      killTimer = setTimeout(() => {
        child.kill();
      }, 1_000);
  };
  const timer = setTimeout(
    () => {
      fail(
        'update_startup_timeout',
        'Startup admission timed out. Close and reopen the app after installation finishes. Local data was not opened.',
      );
    },
    maintenance === 'cleanup' ? 60_000 : 30_000,
  );
  const abort = () =>
    fail(
      'update_startup_cancelled',
      'Restart startup authentication was cancelled. Local data was not opened.',
    );
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
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
        if (maintenance) {
          const rejected = (
            maintenance === 'cleanup'
              ? updateCleanupFailureSchema
              : updateInspectionFailureSchema
          ).safeParse(frame);
          if (rejected.success) {
            fail(
              rejected.data.code,
              'Update session maintenance was rejected.',
            );
            continue;
          }
          const parsed = (
            maintenance === 'cleanup'
              ? updateCleanupReportSchema
              : updateInspectionReportSchema
          ).parse(frame);
          if (parsed.identity.pid !== process.pid)
            throw new Error('Invalid maintenance identity.');
          report = parsed;
          ready = true;
          continue;
        }
        const rejected = (
          restart ? updateRestartFailureSchema : updateStartupFailureSchema
        ).safeParse(frame);
        if (rejected.success) {
          fail(
            rejected.data.code,
            rejected.data.code === 'update_worker_busy'
              ? 'An update or another app process still owns startup admission. Close this window and reopen the app after it finishes. Local data was not opened.'
              : rejected.data.code.startsWith('update_recovery_')
                ? 'A previous update has incomplete or invalid recovery records. Startup is blocked for recovery; no installer was retried and no backup was restored. Existing notes were not opened or reset.'
                : 'Startup protection rejected this application. Close and reopen the app, or reinstall a complete package. Existing local data was not opened.',
          );
          continue;
        }
        const admitted = (
          restart ? updateRestartAdmittedSchema : updateStartupAdmittedSchema
        ).safeParse(frame);
        if (!admitted.success || admitted.data.identity.pid !== process.pid)
          throw new Error('Invalid startup identity.');
        if (restart) {
          const bound = updateRestartAdmittedSchema.parse(frame);
          if (
            bound.session_id !== restart.binding.session_id ||
            bound.challenge !== restart.binding.challenge ||
            bound.identity.creation_file_time !==
              restart.binding.identity.creation_file_time ||
            bound.application_version !== restart.binding.application_version
          )
            throw new Error('Unbound restart admission.');
        }
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
  child.once('close', (code, exitSignal) => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    try {
      decoder.finish();
    } catch {
      fail(
        'update_startup_protocol',
        'Startup protection returned an incomplete response. Close and reopen the app; local data was not opened.',
      );
    }
    if (code !== 0 || exitSignal !== null || !ready)
      fail(
        'update_startup_unavailable',
        'Startup admission could not be confirmed. Close and reopen the app; local data was not opened.',
      );
    settle();
  });
  child.stdin.end(
    restart
      ? encodeJsonFrame({
          ...restart.binding,
          event: 'update_restart_authenticate',
          endpoint: restart.endpoint,
        })
      : undefined,
  );
  await stopped;
  if (failure !== null) throw failure;
  return report;
}
