import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import {
  stageUpdateRuntime,
  verifyUpdateInstallation,
} from '../src/main/update-trust.js';

const executable = process.env.DESKTOP_EXECUTABLE;
test.skip(
  !executable,
  'Run after packaging with DESKTOP_EXECUTABLE set to the unpacked Windows executable.',
);
test('opens the actual packaged sandboxed editor without workspace runtime dependencies', async () => {
  if (!executable) throw new Error('The packaged executable is required.');
  const application = await electron.launch({ executablePath: executable });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByText('Encrypted on this device', { exact: true }),
    ).toBeVisible();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await expect(
      page.getByRole('button', { name: '+ New meeting', exact: true }),
    ).toBeEnabled();
    const { resources, currentVersion, runningExecutable } =
      await application.evaluate(({ app }) => ({
        resources: process.resourcesPath,
        currentVersion: app.getVersion(),
        runningExecutable: process.execPath,
      }));
    await expect(
      verifyUpdateInstallation(
        join(resources, 'audio-host', 'AudioHost.exe'),
        runningExecutable,
        currentVersion,
        'Windows AI Notes Preview',
      ),
    ).rejects.toMatchObject({ code: 'update_installation_missing' });
    const unregisteredRuntime = join(resources, 'unregistered-worker-runtime');
    expect(existsSync(unregisteredRuntime)).toBe(false);
    await expect(
      stageUpdateRuntime(
        join(resources, 'audio-host', 'AudioHost.exe'),
        runningExecutable,
        currentVersion,
        'Windows AI Notes Preview',
        unregisteredRuntime,
      ),
    ).rejects.toMatchObject({ code: 'update_installation_missing' });
    expect(existsSync(unregisteredRuntime)).toBe(false);
    expect(
      [
        'AudioHost.exe',
        'coreclr.dll',
        'hostfxr.dll',
        'System.Private.CoreLib.dll',
        'licenses/NAudio.txt',
        'licenses/ProtectedData.txt',
        'licenses/ProtectedData-THIRD-PARTY-NOTICES.txt',
        'licenses/dotnet/LICENSE.TXT',
        'licenses/dotnet/THIRD-PARTY-NOTICES.TXT',
      ].every((name) => existsSync(join(resources, 'audio-host', name))),
    ).toBe(true);
    const notices = readFileSync(
      join(resources, 'THIRD_PARTY_NOTICES.txt'),
      'utf8',
    );
    expect(notices).toContain('jose@');
    expect(notices).toContain('react@');
    expect(notices).toContain('Permission is hereby granted');
    const devices = await page.evaluate(async () => {
      const initial = await window.notes.invoke({ operation: 'bootstrap' });
      if (!initial.ok || !('state' in initial))
        throw new Error('No packaged desktop state.');
      return window.notes.invoke({
        operation: 'listAudioDevices',
        scope: initial.state.scope,
      });

      test('keeps the real packaged app away from its local key and database while startup admission is owned elsewhere', async () => {
        test.skip(
          process.env.GITHUB_ACTIONS !== 'true' ||
            process.env.RUNNER_ENVIRONMENT !== 'github-hosted',
          'Temporary profile-file isolation is restricted to an isolated hosted Windows runner.',
        );
        if (!executable)
          throw new Error('The packaged executable is required.');
        const baseline = await electron.launch({ executablePath: executable });
        let directory: string;
        try {
          directory = await baseline.evaluate(({ app }) =>
            app.getPath('userData'),
          );
          const page = await baseline.firstWindow();
          await expect(
            page.getByRole('button', { name: '+ New meeting', exact: true }),
          ).toBeEnabled();
          const closed = baseline.waitForEvent('close');
          await baseline.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
          );
          await closed;
        } finally {
          await baseline.close();
        }
        const suffix = `${randomUUID()}.startup-probe-backup`;
        const protectedFiles = [
          'content-key.protected',
          'notes.sqlite',
          'notes.sqlite-wal',
          'notes.sqlite-shm',
        ];
        const moved: string[] = [];
        let blocked: Awaited<ReturnType<typeof electron.launch>> | undefined;
        const programs = process.env.ProgramFiles;
        if (!programs)
          throw new Error(
            'PowerShell 7 is required for the native lease probe.',
          );
        const holder = spawn(
          join(programs, 'PowerShell', '7', 'pwsh.exe'),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference='Stop'; $p=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WindowsAINotes.UpdateLocks\\dbdb543e-07bd-5ef6-99a5-00d80b9bdfb6.startup.lock'; $f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try{[Console]::WriteLine('held'); [Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}",
          ],
          {
            env: audioHostEnvironment(process.env),
            windowsHide: true,
            stdio: 'pipe',
          },
        );
        let output = '';
        let diagnostics = '';
        let resolveHeld!: () => void;
        let rejectHeld!: (error: Error) => void;
        const held = new Promise<void>((resolve, reject) => {
          resolveHeld = resolve;
          rejectHeld = reject;
        });
        holder.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output === 'held\r\n' || output === 'held\n') resolveHeld();
          else if (output.length > 1024)
            rejectHeld(new Error('Invalid synthetic lease-holder response.'));
        });
        holder.stderr.on('data', (chunk: Buffer) => {
          diagnostics += chunk.toString('utf8');
        });
        holder.once('error', rejectHeld);
        const holderClosed = new Promise<void>((resolve) =>
          holder.once('close', (code) => {
            if (code !== 0 || !output.startsWith('held'))
              rejectHeld(
                new Error(
                  `Synthetic lease holder failed: ${code}; ${diagnostics.slice(0, 2048)}`,
                ),
              );
            resolve();
          }),
        );
        try {
          await held;
          for (const file of protectedFiles) {
            if (!existsSync(join(directory, file))) continue;
            await rename(
              join(directory, file),
              join(directory, `${file}.${suffix}`),
            );
            moved.push(file);
          }
          expect(moved).toContain('content-key.protected');
          expect(moved).toContain('notes.sqlite');
          blocked = await electron.launch({ executablePath: executable });
          const page = await blocked.firstWindow();
          await expect(page.getByRole('alert')).toContainText(
            'Local data was not opened.',
          );
          await expect(
            page.getByRole('button', { name: '+ New meeting', exact: true }),
          ).toBeDisabled();
          expect(
            await page.evaluate(() =>
              window.notes.invoke({ operation: 'bootstrap' }),
            ),
          ).toMatchObject({ ok: false, error: { code: 'update_worker_busy' } });
          expect(
            await page.evaluate(() =>
              window.notes.invokeUpdate({ operation: 'getState' }),
            ),
          ).toMatchObject({
            ok: true,
            state: { phase: 'failed', installation_enabled: false },
          });
          holder.stdin.end();
          await holderClosed;
          expect(
            await page.evaluate(() =>
              window.notes.invoke({ operation: 'bootstrap' }),
            ),
          ).toMatchObject({ ok: false, error: { code: 'update_worker_busy' } });
          for (const file of protectedFiles)
            expect(existsSync(join(directory, file))).toBe(false);
        } finally {
          holder.stdin.end();
          await holderClosed;
          if (blocked) {
            const closed = blocked.waitForEvent('close');
            await blocked.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]?.close(),
            );
            await closed;
            await blocked.close();
          }
          for (const file of moved) {
            await rm(join(directory, file), { force: true });
            await rename(
              join(directory, `${file}.${suffix}`),
              join(directory, file),
            );
          }
        }
        const reopened = await electron.launch({ executablePath: executable });
        try {
          const page = await reopened.firstWindow();
          await expect(
            page.getByRole('button', { name: '+ New meeting', exact: true }),
          ).toBeEnabled();
          const closed = reopened.waitForEvent('close');
          await reopened.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
          );
          await closed;
        } finally {
          await reopened.close();
        }
      });
    });
    expect(devices).toMatchObject({
      ok: true,
      audio_devices: { devices: expect.any(Array) },
    });
    const capacity = await page.evaluate(async () => {
      const current = await window.notes.invoke({ operation: 'bootstrap' });
      if (!current.ok || !('state' in current))
        throw new Error('No packaged state.');
      return window.notes.invoke({
        operation: 'checkAudioStorage',
        scope: current.state.scope,
      });
    });
    expect(capacity).toMatchObject({
      ok: true,
      audio_state: {
        state: {
          storage_quota_gib: 5,
          storage: {
            capacity: {
              quota_bytes: 5 * 1024 ** 3,
              state: 'ready',
              code: null,
            },
          },
        },
      },
    });
    await page
      .getByRole('button', { name: 'Audio devices', exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Know what is listening.',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Refresh audio devices', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('heading', { name: 'Microphones', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'System audio', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'About & updates', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'About & updates.' }),
    ).toBeVisible();
    await expect(
      page.getByText('Updates are not enabled for this application package.'),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.notes.invokeUpdate({ operation: 'getState' }),
      ),
    ).toMatchObject({
      ok: true,
      state: { phase: 'disabled', installation_enabled: false },
    });
    await expect(
      page.getByRole('button', {
        name: /check for updates|download update|restart to update/i,
      }),
    ).toHaveCount(0);
    const closed = application.waitForEvent('close');
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await closed;
  } finally {
    await application.close();
  }
});
