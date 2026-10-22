import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleMain } from '../bundle.mjs';

test.skip(
  process.platform !== 'win32' && !process.env.DISPLAY,
  'Requires a real sandboxed Electron renderer and a display.',
);
async function launch() {
  const directory = await mkdtemp(join(tmpdir(), 'notes-updates-ui-'));
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([
      bundleMain(
        fileURLToPath(new URL('./fixtures/updates-main.ts', import.meta.url)),
        join(directory, 'main.mjs'),
      ),
      build({
        entryPoints: [
          fileURLToPath(new URL('./fixtures/updates.tsx', import.meta.url)),
        ],
        outfile: join(directory, 'updates.js'),
        bundle: true,
        platform: 'browser',
        target: 'chrome140',
        jsx: 'automatic',
      }),
      copyFile(
        new URL('./fixtures/updates.html', import.meta.url),
        join(directory, 'index.html'),
      ),
      writeFile(
        join(directory, 'fixture.json'),
        JSON.stringify({
          preload: fileURLToPath(
            new URL('../dist/preload.cjs', import.meta.url),
          ),
        }),
      ),
    ]);
    application = await electron.launch({
      timeout: 15_000,
      args: [join(directory, 'main.mjs'), directory],
    });
    return {
      directory,
      application,
      page: await application.firstWindow({ timeout: 10_000 }),
    };
  } catch (error) {
    try {
      await application?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
test('checks, cancels and stages through the actual sandboxed bridge without offering installation', async () => {
  const f = await launch();
  try {
    await expect(
      f.page.getByRole('heading', { name: 'About & updates.' }),
    ).toBeVisible();
    await expect(
      f.page.getByText('Check when you are ready.', { exact: false }),
    ).toBeVisible();
    await expect(
      f.page.getByText('1 cached update(s)', { exact: false }),
    ).toBeVisible();
    await f.page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(f.page.getByText('Version 0.1.1 is available.')).toBeVisible();
    await f.page.getByRole('button', { name: 'Download update' }).click();
    await expect(
      f.page.getByText('Downloading and verifying the update...'),
    ).toBeVisible();
    await expect(
      f.page.getByRole('button', { name: 'Check for updates' }),
    ).toBeDisabled();
    await f.page
      .getByRole('button', { name: 'Cancel update operation' })
      .click();
    await expect(
      f.page.getByText('Update operation cancelled.', { exact: false }),
    ).toBeVisible();
    await f.page.getByRole('button', { name: 'Download update' }).click();
    await expect(
      f.page.getByRole('button', { name: 'Cancel update operation' }),
    ).toBeEnabled();
    await f.application.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:complete');
    });
    const staged = f.page.getByText(
      'Version 0.1.1 is verified and saved on this device.',
    );
    await expect(staged).toBeVisible();
    await expect(
      f.page.getByRole('button', { name: /install|restart/i }),
    ).toHaveCount(0);
    await expect(
      f.page.getByRole('button', { name: 'Download update' }),
    ).toHaveCount(0);
    await f.application.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:stale');
    });
    await f.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(staged).toBeVisible();
    await f.page.getByRole('button', { name: 'Toggle update panel' }).click();
    await expect(staged).toHaveCount(0);
    await f.page.getByRole('button', { name: 'Toggle update panel' }).click();
    await expect(staged).toBeVisible();
    expect(
      await f.page.evaluate(() =>
        window.notes.invokeUpdate({ operation: 'getState' }),
      ),
    ).toMatchObject({
      ok: true,
      state: { phase: 'ready', installation_enabled: false },
    });
  } finally {
    await f.application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test('surfaces failed checks and disconnected IPC without changing note or installation controls', async () => {
  const f = await launch();
  try {
    await expect(
      f.page.getByRole('button', { name: 'Check for updates' }),
    ).toBeEnabled();
    await f.application.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:fail-check');
    });
    await f.page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(f.page.getByRole('alert')).toContainText(
      'The synthetic update response was rejected.',
    );
    await f.page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(f.page.getByText('Version 0.1.1 is available.')).toBeVisible();
    await expect(f.page.getByRole('alert')).toHaveCount(0);
    await f.application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('notes:update');
    });
    await f.page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(f.page.getByRole('alert')).toContainText(
      'The desktop update connection failed.',
    );
    await expect(
      f.page.getByRole('button', { name: 'Retry update connection' }),
    ).toBeEnabled();
    await expect(
      f.page.getByRole('button', { name: /install|restart/i }),
    ).toHaveCount(0);
  } finally {
    await f.application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
