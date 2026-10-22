import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { Configuration } from 'electron-builder';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import {
  stageUpdateRuntime,
  verifyInstallerUpdateArtifact,
  verifyUpdateInstallation,
} from '../src/main/update-trust.js';

test.skip(
  process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.DESKTOP_INSTALLATION_PROBE !== '1',
  'Installation changes are restricted to an explicitly enabled, isolated hosted Windows runner.',
);

async function runInstaller(executable: string, args: string[]) {
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

async function close(application: ElectronApplication) {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
}

async function selectedId(page: Page) {
  return page.evaluate(async () => {
    const current = await window.notes.invoke({ operation: 'bootstrap' });
    if (!current.ok || !('state' in current) || !current.state.selected_id)
      throw new Error('No installed meeting is selected.');
    return current.state.selected_id;
  });
}

async function fingerprint(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function assertInstallerRole(
  file: string,
  version: string,
  product: string,
  uninstaller = false,
) {
  const programs = process.env.ProgramFiles;
  if (!programs)
    throw new Error('The Windows Program Files directory is required.');
  const { stdout } = await promisify(execFile)(
    join(programs, 'PowerShell', '7', 'pwsh.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:NOTES_INSTALLER_FILE); [ordered]@{internal_name=$v.InternalName;original_filename=$v.OriginalFilename;product_name=$v.ProductName;product_version=$v.ProductVersion}|ConvertTo-Json -Compress",
    ],
    {
      env: { ...audioHostEnvironment(process.env), NOTES_INSTALLER_FILE: file },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16_384,
      windowsHide: true,
    },
  );
  expect(JSON.parse(stdout)).toEqual({
    internal_name: `io.github.windowsainotes.desktop.${uninstaller ? 'uninstaller' : 'nsis'}.x64.v1`,
    original_filename: `windows-ai-notes-${version}-x64-${uninstaller ? 'uninstaller' : 'setup'}.exe`,
    product_name: product,
    product_version: version,
  });
}

test('preserves encrypted data and new edits through actual installation, compatible upgrade, rollback and reinstall', async () => {
  test.setTimeout(300_000);
  const desktop = fileURLToPath(new URL('../', import.meta.url));
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const metadata = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')));
  const parts = metadata.version.split('.');
  if (
    parts.length !== 3 ||
    parts.some(
      (part) =>
        !/^(0|[1-9]\d*)$/.test(part) ||
        !Number.isSafeInteger(Number(part)) ||
        Number(part) >= 65_535,
    )
  )
    throw new Error(
      'The installation fixture requires a stable Windows-compatible version.',
    );
  const upgradeVersion = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
  const base: Configuration = JSON.parse(
    await readFile(join(desktop, 'electron-builder.unsigned.json'), 'utf8'),
  );
  if (!base.productName || typeof base.artifactName !== 'string')
    throw new Error('The preview installation identity is missing.');
  const artifact = (version: string) =>
    base.artifactName
      ?.replaceAll('${version}', version)
      .replaceAll('${arch}', 'x64')
      .replaceAll('${ext}', 'exe');
  const baseName = artifact(metadata.version);
  const upgradeName = artifact(upgradeVersion);
  if (!baseName || !upgradeName)
    throw new Error('The preview installer filenames are unavailable.');
  const baselineInstaller = join(repository, 'artifacts', 'desktop', baseName);
  expect(existsSync(baselineInstaller)).toBe(true);
  expect(base.nsis?.deleteAppDataOnUninstall).toBe(false);
  await assertInstallerRole(
    baselineInstaller,
    metadata.version,
    base.productName,
  );
  await expect(
    verifyInstallerUpdateArtifact(
      join(repository, 'artifacts/audio-host/win-x64/AudioHost.exe'),
      baselineInstaller,
      {
        current_version: '0.0.0',
        version: metadata.version,
        certificate_sha256: '0'.repeat(64),
        publisher: 'Synthetic unsigned fixture',
        product_name: base.productName,
        bytes: 1,
        sha512: Buffer.alloc(64).toString('base64'),
      },
    ),
  ).rejects.toMatchObject({ code: 'update_signature_invalid' });

  const root = await mkdtemp(join(tmpdir(), 'notes-installed-roundtrip-'));
  const installation = join(root, 'Installed app');
  const upgradeOutput = join(root, 'Upgrade package');
  const executable = join(installation, `${base.productName}.exe`);
  const uninstaller = join(installation, `Uninstall ${base.productName}.exe`);
  const title = 'Synthetic installer persistence review';
  const originalBody = 'Synthetic private draft before installer upgrade.';
  const upgradedBody =
    'Synthetic new edit after upgrade must survive compatible rollback.';
  const marker = Buffer.from(
    'Synthetic unsealed-file preservation fixture; not a recording.',
  );
  const lifecycle: { application: ElectronApplication | null } = {
    application: null,
  };
  let identity: { name: string; directory: string } | undefined;
  let documentId: string | undefined;
  let keyDigest: string | undefined;
  let markerPath: string | undefined;

  async function openInstalled(version: string) {
    lifecycle.application = await electron.launch({
      executablePath: executable,
    });
    const current = await lifecycle.application.evaluate(
      ({ app, safeStorage }) => ({
        version: app.getVersion(),
        name: app.getName(),
        directory: app.getPath('userData'),
        packaged: app.isPackaged,
        encrypted: safeStorage.isEncryptionAvailable(),
        resources: process.resourcesPath,
      }),
    );
    expect(current).toMatchObject({ version, packaged: true, encrypted: true });
    expect(current.resources.toLowerCase()).toBe(
      join(installation, 'resources').toLowerCase(),
    );
    await assertInstallerRole(uninstaller, version, base.productName!, true);
    expect(
      await verifyUpdateInstallation(
        join(current.resources, 'audio-host', 'AudioHost.exe'),
        executable,
        version,
        base.productName!,
      ),
    ).toEqual({
      directory: installation,
      executable,
      application_version: version,
      product_name: base.productName,
      architecture: 'x64',
    });
    await expect(
      verifyUpdateInstallation(
        join(current.resources, 'audio-host', 'AudioHost.exe'),
        executable,
        '0.0.0',
        base.productName!,
      ),
    ).rejects.toMatchObject({ code: 'update_installation_mismatch' });
    const workerParent = join(root, 'Independent worker runtimes');
    await mkdir(workerParent, { recursive: true });
    const runtime = await stageUpdateRuntime(
      join(current.resources, 'audio-host', 'AudioHost.exe'),
      executable,
      version,
      base.productName!,
      workerParent,
    );
    try {
      expect(runtime.files).toBeGreaterThan(100);
      expect(runtime.bytes).toBeGreaterThan(10 * 1024 ** 2);
      for (const name of [
        'AudioHost.exe',
        'AudioHost.dll',
        'AudioHost.Core.dll',
        'AudioHost.deps.json',
        'AudioHost.runtimeconfig.json',
        'coreclr.dll',
        'hostfxr.dll',
        'System.Private.CoreLib.dll',
      ])
        expect(await fingerprint(join(runtime.directory, name))).toBe(
          await fingerprint(join(current.resources, 'audio-host', name)),
        );
      await expect(
        verifyUpdateInstallation(
          runtime.executable,
          executable,
          version,
          base.productName!,
        ),
      ).rejects.toMatchObject({ code: 'update_installation_helper' });
    } finally {
      await rm(runtime.directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
    }
    const location = relative(installation, current.directory);
    expect(isAbsolute(location) || location.startsWith('..')).toBe(true);
    if (identity) expect(current).toMatchObject(identity);
    else identity = { name: current.name, directory: current.directory };
    const page = await lifecycle.application.firstWindow();
    await expect(
      page.getByText('Encrypted on this device', { exact: true }),
    ).toBeVisible();
    return page;
  }

  async function stopInstalled() {
    if (!lifecycle.application)
      throw new Error('The installed app is not running.');
    await close(lifecycle.application);
    lifecycle.application = null;
  }

  async function preserved(body: string) {
    if (!identity || !keyDigest || !markerPath)
      throw new Error('The original encrypted state has not been established.');
    expect(
      await fingerprint(join(identity.directory, 'content-key.protected')),
    ).toBe(keyDigest);
    expect(await readFile(markerPath)).toEqual(marker);
    for (const name of await readdir(identity.directory)) {
      if (!name.startsWith('notes.sqlite') && name !== 'content-key.protected')
        continue;
      const bytes = await readFile(join(identity.directory, name));
      expect(bytes.includes(Buffer.from(title))).toBe(false);
      expect(bytes.includes(Buffer.from(body))).toBe(false);
    }
  }

  async function checkDraft(page: Page, body: string) {
    expect(await selectedId(page)).toBe(documentId);
    await expect(
      page.getByRole('textbox', { name: 'Meeting title' }),
    ).toHaveValue(title);
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(body);
    await expect(
      page.getByRole('textbox', { name: 'Meeting tags' }),
    ).toHaveValue('Installer, Offline');
  }

  async function uninstall() {
    await runInstaller(uninstaller, [
      '/S',
      '/currentuser',
      `_?=${installation}`,
    ]);
    await expect.poll(() => existsSync(executable)).toBe(false);
  }

  try {
    const { build, Platform, Arch } = await import('electron-builder');
    await build({
      projectDir: desktop,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      publish: 'never',
      config: {
        ...base,
        directories: { ...base.directories, output: upgradeOutput },
        extraMetadata: { ...base.extraMetadata, version: upgradeVersion },
      },
    });
    const upgradeInstaller = join(upgradeOutput, upgradeName);
    expect(existsSync(upgradeInstaller)).toBe(true);
    await assertInstallerRole(
      upgradeInstaller,
      upgradeVersion,
      base.productName,
    );
    await runInstaller(baselineInstaller, [
      '/S',
      '/currentuser',
      `/D=${installation}`,
    ]);
    await assertInstallerRole(
      uninstaller,
      metadata.version,
      base.productName,
      true,
    );
    let page = await openInstalled(metadata.version);
    await expect(
      page.getByRole('button', { name: 'Create your first meeting' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page.getByRole('textbox', { name: 'Meeting title' }).fill(title);
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(originalBody);
    await page
      .getByRole('textbox', { name: 'Meeting tags' })
      .fill('Installer, Offline');
    await expect(
      page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    documentId = await selectedId(page);
    await stopInstalled();
    if (!identity) throw new Error('The installed data directory is missing.');
    keyDigest = await fingerprint(
      join(identity.directory, 'content-key.protected'),
    );
    const interrupted = join(identity.directory, 'recordings', randomUUID());
    await mkdir(interrupted, { recursive: true });
    markerPath = join(interrupted, 'synthetic-unique.partial');
    await writeFile(markerPath, marker, { flag: 'wx' });
    await preserved(originalBody);

    await runInstaller(upgradeInstaller, [
      '/S',
      '/currentuser',
      `/D=${installation}`,
    ]);
    await assertInstallerRole(
      uninstaller,
      upgradeVersion,
      base.productName,
      true,
    );
    page = await openInstalled(upgradeVersion);
    await checkDraft(page, originalBody);
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(upgradedBody);
    await expect(
      page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    await stopInstalled();
    await preserved(upgradedBody);

    await runInstaller(baselineInstaller, [
      '/S',
      '/currentuser',
      `/D=${installation}`,
    ]);
    page = await openInstalled(metadata.version);
    await checkDraft(page, upgradedBody);
    await stopInstalled();
    await uninstall();
    await preserved(upgradedBody);

    await runInstaller(baselineInstaller, [
      '/S',
      '/currentuser',
      `/D=${installation}`,
    ]);
    page = await openInstalled(metadata.version);
    await checkDraft(page, upgradedBody);
    await stopInstalled();
    await uninstall();
    await preserved(upgradedBody);
  } finally {
    if (lifecycle.application) await lifecycle.application.close();
    if (existsSync(executable) && existsSync(uninstaller)) await uninstall();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});
