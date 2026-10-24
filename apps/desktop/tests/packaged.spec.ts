import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { FrameDecoder } from '@windows-ai-notes/contracts';
import {
  stageUpdateRuntime,
  verifyUpdateInstallation,
} from '../src/main/update-trust.js';
import { updateParentIdentitySchema } from '@windows-ai-notes/contracts/updates';
import {
  closeObservedMain,
  desktopProbeEnvironment,
} from './installer-support.js';
import { assertAppIcon } from './app-icon.js';
import { iconImages, readIconAssets } from '../icons.mjs';

const executable = process.env.DESKTOP_EXECUTABLE;
async function rejectedMainActivation(application: ElectronApplication) {
  return application.evaluate(async ({ app }) => {
    const { join } = process.getBuiltinModule('node:path');
    const filename = join(app.getAppPath(), 'dist/main/main.js');
    const require = process
      .getBuiltinModule('node:module')
      .createRequire(filename);
    const main: typeof import('../src/main/main.js') = require(filename);
    try {
      await main.activateReadyUpdate();
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        typeof error.code !== 'string'
      )
        throw error;
      return error.code;
    }
    throw new Error(
      'A packaged Main without an admitted verified candidate must reject activation.',
    );
  });
}
async function verifyNativeRuntimeSeal(resources: string, version: string) {
  const root = await mkdtemp(join(tmpdir(), 'notes-packaged-runtime-seal-'));
  const source = join(resources, 'audio-host', 'AudioHost.exe');
  const original = createHash('sha256')
    .update(readFileSync(source))
    .digest('hex');
  const native = join(root, 'runtime');
  const run = promisify(execFile);
  const options = {
    env: audioHostEnvironment(process.env),
    encoding: 'utf8' as const,
    timeout: 30_000,
    maxBuffer: 16_384,
    windowsHide: true,
  };
  try {
    await test.step('Copy the complete self-contained runtime', () =>
      cp(join(resources, 'audio-host'), native, {
        recursive: true,
        force: false,
        errorOnExist: true,
      }));
    const sealed = await test.step('Embed the exact payload inventory', () =>
      run(source, ['--seal-update-runtime', native, version], options));
    expect(JSON.parse(sealed.stdout)).toEqual({
      version: 1,
      operation: '--seal-update-runtime',
      success: true,
      code: 'update_runtime_sealed',
    });
    expect(
      createHash('sha256')
        .update(readFileSync(join(native, 'AudioHost.exe')))
        .digest('hex'),
    ).not.toBe(original);
    for (const [operation, args, code] of [
      [
        '--seal-update-runtime',
        [native, version],
        'update_runtime_already_sealed',
      ],
      [
        '--verify-update-runtime',
        [native, version, '0'.repeat(64), 'Synthetic untrusted publisher'],
        'update_signature_invalid',
      ],
    ] as const) {
      let rejection: unknown;
      try {
        await test.step(`Reject untrusted or repeated provenance: ${operation}`, () =>
          run(join(native, 'AudioHost.exe'), [operation, ...args], options));
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({ code: 2 });
      if (
        !(rejection instanceof Error) ||
        !('stdout' in rejection) ||
        typeof rejection.stdout !== 'string'
      )
        throw new Error(
          'The sealed packaged helper did not return a native rejection.',
          { cause: rejection },
        );
      expect(JSON.parse(rejection.stdout)).toEqual({
        version: 1,
        operation,
        success: false,
        code,
      });
    }
    expect(
      createHash('sha256').update(readFileSync(source)).digest('hex'),
    ).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test.skip(
  !executable,
  'Run after packaging with DESKTOP_EXECUTABLE set to the unpacked Windows executable.',
);
test('rejects forged restart startup before unlocking or modifying existing local data', async () => {
  if (!executable) throw new Error('The packaged executable is required.');
  const root = await mkdtemp(join(tmpdir(), 'notes-forged-first-start-'));
  const key = Buffer.from('Synthetic protected-key canary, never a real key.');
  const database = Buffer.from(
    'Synthetic database canary, never an actual database.',
  );
  await writeFile(join(root, 'content-key.protected'), key);
  await writeFile(join(root, 'notes.sqlite'), database);
  const session = randomUUID();
  const nonce = 'a'.repeat(64);
  const application = await electron.launch({
    executablePath: executable,
    args: [
      `--user-data-dir=${root}`,
      `--update-restart=${session}`,
      `--update-health=WindowsAINotes.Restart.${session.replaceAll('-', '')}.${nonce}`,
      `--update-auth=WindowsAINotes.RestartAuth.${session.replaceAll('-', '')}.${nonce}`,
    ],
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByText(/Restart startup could not be confirmed/u),
    ).toBeVisible();
    expect(
      await application.evaluate(({ app }) => app.getPath('userData')),
    ).toBe(root);
    const startup = await page.evaluate(() =>
      window.notes.invoke({ operation: 'bootstrap' }),
    );
    if (startup.ok) throw new Error('Forged startup must remain unavailable.');
    expect(await rejectedMainActivation(application)).toBe(startup.error.code);
    expect(await page.evaluate(() => Object.keys(window.notes))).not.toContain(
      'activateReadyUpdate',
    );
    expect(readFileSync(join(root, 'content-key.protected'))).toEqual(key);
    expect(readFileSync(join(root, 'notes.sqlite'))).toEqual(database);
    const invoke = (operation: string) =>
      application.evaluate(
        async ({ app }, input) => {
          const { spawn } = process.getBuiltinModule('node:child_process');
          const { join, dirname } = process.getBuiltinModule('node:path');
          const helper = join(
            process.resourcesPath,
            'audio-host',
            'AudioHost.exe',
          );
          return new Promise<{ code: number | null; stdout: string }>(
            (resolve, reject) => {
              const child = spawn(
                helper,
                [
                  input.operation,
                  String(process.pid),
                  process.execPath,
                  app.getVersion(),
                ],
                {
                  cwd: dirname(helper),
                  env: input.environment,
                  windowsHide: true,
                  stdio: 'pipe',
                },
              );
              const output: Buffer[] = [];
              const timer = setTimeout(() => child.kill(), 15_000);
              child.on('error', reject);
              child.stdout.on('data', (bytes: Buffer) => output.push(bytes));
              child.once('close', (code) => {
                clearTimeout(timer);
                resolve({
                  code,
                  stdout: Buffer.concat(output).toString('base64'),
                });
              });
              child.stdin.end();
            },
          );
        },
        { operation, environment: audioHostEnvironment(process.env) },
      );
    const rejected = await invoke('--claim-update-restart');
    expect(rejected.code).toBe(2);
    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.from(rejected.stdout, 'base64'));
    decoder.finish();
    expect(frames).toEqual([
      expect.objectContaining({ version: 1, event: 'update_restart_failed' }),
    ]);
    const maintenance = await invoke('--cleanup-update-sessions');
    expect(maintenance.code).toBe(0);
    const maintenanceDecoder = new FrameDecoder();
    expect(
      maintenanceDecoder.push(Buffer.from(maintenance.stdout, 'base64')),
    ).toEqual([
      expect.objectContaining({
        version: 1,
        event: 'update_cleanup_report',
        status: 'complete',
        retired: 0,
        removed: 0,
        incomplete: 0,
        rejected: 0,
      }),
    ]);
    maintenanceDecoder.finish();
    const inspection = await invoke('--inspect-update-sessions');
    expect(inspection.code).toBe(0);
    const inspectionDecoder = new FrameDecoder();
    expect(
      inspectionDecoder.push(Buffer.from(inspection.stdout, 'base64')),
    ).toEqual([
      expect.objectContaining({
        version: 1,
        event: 'update_inspection_report',
        report: expect.objectContaining({
          status: 'complete',
          active: 0,
          retired: 0,
          unverifiable: 0,
          limited: false,
          omitted: 0,
          sessions: [],
        }),
      }),
    ]);
    inspectionDecoder.finish();
    await page
      .getByRole('button', { name: 'Inspect update recovery', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'About & updates.' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Inspect recovery records', exact: true })
      .click();
    await expect(
      page.getByText('No update session records were found.', { exact: false }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.notes.invokeUpdate({ operation: 'getState' }),
      ),
    ).toMatchObject({
      ok: true,
      state: {
        phase: 'failed',
        can_inspect: true,
        installation_enabled: false,
        inspection: { status: 'complete', active: 0, retired: 0, sessions: [] },
      },
    });
    await expect(
      page.getByText(/Restart startup could not be confirmed/u).first(),
    ).toBeVisible();
    expect(readFileSync(join(root, 'content-key.protected'))).toEqual(key);
    expect(readFileSync(join(root, 'notes.sqlite'))).toEqual(database);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('opens the actual packaged sandboxed editor without workspace runtime dependencies', async () => {
  if (!executable) throw new Error('The packaged executable is required.');
  const application = await electron.launch({ executablePath: executable });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByText('Encrypted on this device', { exact: true }),
    ).toBeVisible();
    await assertAppIcon(application, page);
    await test.step('Read updated native resources despite a stale Electron icon cache', async () => {
      const root = await mkdtemp(join(tmpdir(), 'notes-icon-cache-'));
      try {
        const assets = await readIconAssets();
        const black = Buffer.from(assets.ico);
        for (const { size, bitmap } of iconImages(black))
          for (let offset = 40; offset < 40 + size * size * 4; offset += 4)
            bitmap.fill(0, offset, offset + 3);
        const blackIcon = join(root, 'black.ico');
        const sourceIcon = join(root, 'source.ico');
        await Promise.all([
          writeFile(blackIcon, black, { flag: 'wx' }),
          writeFile(sourceIcon, assets.ico, { flag: 'wx' }),
        ]);
        const file = join(root, 'cached.dll');
        const source = join(root, 'source.dll');
        const programs = process.env.ProgramFiles;
        if (!programs)
          throw new Error('The Windows Program Files directory is required.');
        const { stdout, stderr } = await promisify(execFile)(
          join(programs, 'PowerShell', '7', 'pwsh.exe'),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'public class BlackIconFixture {}' -OutputAssembly $env:NOTES_BLACK_DLL -CompilerOptions ('/win32icon:'+$env:NOTES_BLACK_ICON); Add-Type -TypeDefinition 'public class SourceIconFixture {}' -OutputAssembly $env:NOTES_SOURCE_DLL -CompilerOptions ('/win32icon:'+$env:NOTES_SOURCE_ICON)",
          ],
          {
            env: {
              ...audioHostEnvironment(process.env),
              NOTES_BLACK_DLL: file,
              NOTES_SOURCE_DLL: source,
              NOTES_BLACK_ICON: blackIcon,
              NOTES_SOURCE_ICON: sourceIcon,
            },
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        );
        if (stdout || stderr)
          throw new Error(
            'Native icon fixture compilation emitted diagnostics.',
          );
        const cachedPixels = () =>
          application.evaluate(async ({ app }, file) => {
            const icon = await app.getFileIcon(file, { size: 'normal' });
            if (icon.isEmpty())
              throw new Error(
                'The cache regression fixture must have an icon.',
              );
            return icon.toBitmap({ scaleFactor: 1 }).toString('hex');
          }, file);
        const cached = await cachedPixels();
        expect(Buffer.from(cached, 'hex')).toHaveLength(4096);
        const offset = (4 * 32 + 16) * 4;
        expect(
          Buffer.from(cached, 'hex')
            .subarray(offset, offset + 4)
            .toString('hex'),
        ).toBe('000000ff');
        await writeFile(file, readFileSync(source));
        expect(await cachedPixels()).toBe(cached);
        await assertAppIcon(application, page, [file]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await rejectedMainActivation(application)).toBe('update_not_ready');
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
    });

    async function verifyStartupAdmission() {
      if (!executable) throw new Error('The packaged executable is required.');
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
        throw new Error('PowerShell 7 is required for the native lease probe.');
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
    }
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
    if (
      process.env.GITHUB_ACTIONS === 'true' &&
      process.env.RUNNER_ENVIRONMENT === 'github-hosted'
    )
      await verifyStartupAdmission();
  } finally {
    await application.close();
  }
});
test('seals a real self-contained runtime copy without granting unsigned provenance', async () => {
  test.setTimeout(180_000);
  if (!executable) throw new Error('The packaged executable is required.');
  const application = await electron.launch({
    executablePath: executable,
    env: desktopProbeEnvironment(),
  });
  let metadata: { resources: string; version: string };
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole('button', { name: '+ New meeting', exact: true }),
    ).toBeEnabled();
    metadata = await application.evaluate(({ app }) => ({
      resources: process.resourcesPath,
      version: app.getVersion(),
    }));
    const closed = application.waitForEvent('close');
    const observed = await application.evaluate(async () => {
      const { execFile } = process.getBuiltinModule('node:child_process');
      const { join } = process.getBuiltinModule('node:path');
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          join(process.resourcesPath, 'audio-host', 'AudioHost.exe'),
          ['--verify-update-parent', String(process.pid), process.execPath],
          {
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 16_384,
            windowsHide: true,
          },
          (error, output) => (error ? reject(error) : resolve(output)),
        );
      });
      return JSON.parse(stdout) as unknown;
    });
    expect(observed).toMatchObject({
      version: 1,
      matched: true,
      code: 'update_parent_matched',
    });
    if (
      typeof observed !== 'object' ||
      observed === null ||
      !('parent' in observed)
    )
      throw new Error(
        'Actual packaged Main did not report its observed parent identity.',
      );
    const identity = updateParentIdentitySchema.parse(observed.parent);
    await expect(
      closeObservedMain(
        {
          ...identity,
          creation_file_time: (
            BigInt(identity.creation_file_time) + 1n
          ).toString(),
        },
        executable,
      ),
    ).rejects.toThrow();
    await expect(
      closeObservedMain(identity, `${executable}.wrong`),
    ).rejects.toThrow();
    expect(application.process().exitCode).toBeNull();
    await expect(
      page.getByRole('button', { name: '+ New meeting', exact: true }),
    ).toBeEnabled();
    await closeObservedMain(identity, executable);
    await closed;
  } finally {
    await application.close();
  }
  await verifyNativeRuntimeSeal(metadata.resources, metadata.version);
});
