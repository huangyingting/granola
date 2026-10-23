import type { ElectronApplication } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { updateParentIdentitySchema } from '@windows-ai-notes/contracts/updates';

export function desktopProbeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(audioHostEnvironment(process.env)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export async function runInstaller(executable: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      // NSIS requires /D= and _?= last and unquoted, even for paths with spaces.
      argv0: `"${executable}"`,
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 90_000,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Installer failed: exit=${code}, signal=${signal}.`));
    });
  });
}

export async function closeInstalled(application: ElectronApplication) {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
}

export async function closeObservedMain(
  identity: z.infer<typeof updateParentIdentitySchema>,
  executable: string,
) {
  updateParentIdentitySchema.parse(identity);
  const programs = process.env.ProgramFiles;
  if (!programs) throw new Error('Windows PowerShell 7 is required.');
  const { stdout } = await promisify(execFile)(
    join(programs, 'PowerShell', '7', 'pwsh.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./close-restarted-main.ps1', import.meta.url)),
      '-ProcessId',
      String(identity.pid),
      '-CreationFileTime',
      identity.creation_file_time,
      '-Executable',
      executable,
    ],
    {
      env: audioHostEnvironment(process.env),
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 16_384,
      windowsHide: true,
    },
  );
  z.strictObject({ version: z.literal(1), closed: z.literal(true) }).parse(
    JSON.parse(stdout),
  );
}
