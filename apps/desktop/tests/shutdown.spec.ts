import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test.skip(
  process.platform !== 'win32',
  'Real Windows DPAPI and Electron Main shutdown are required.',
);

function launch(directory: string) {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WINDOWS_NOTES_DATA_DIR: directory,
    },
  });
}
async function close(application: ElectronApplication) {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
}

test('drains an admitted export and rejects new commands before closing storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-close-drain-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const current = application;
    const page = await current.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Latest text before the shutdown barrier.');
    await current.evaluate(({ dialog, ipcMain }) => {
      dialog.showSaveDialog = async () =>
        new Promise((resolve) => {
          ipcMain.once('fixture:release-export', () =>
            resolve({ canceled: true, filePath: '' }),
          );
        });
    });
    await page
      .getByRole('button', { name: 'Export Markdown', exact: true })
      .click();
    await expect
      .poll(() =>
        current.evaluate(({ ipcMain }) =>
          ipcMain.listenerCount('fixture:release-export'),
        ),
      )
      .toBe(1);
    const scope = await page.evaluate(async () => {
      const response = await window.notes.invoke({ operation: 'bootstrap' });
      if (!response.ok || !('state' in response))
        throw new Error('Workspace unavailable.');
      return response.state.scope;
    });
    await current.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect(
      page.getByText('Closing safely', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    expect(
      await page.evaluate(
        (scope) => window.notes.invoke({ operation: 'create', scope }),
        scope,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'desktop_closing' },
    });
    expect(
      await page.evaluate(() =>
        window.notes.invokeUpdate({ operation: 'getState' }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'desktop_closing' },
    });
    const closed = current.waitForEvent('close');
    await current.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-export');
    });
    await closed;
    application = null;
    application = await launch(directory);
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Latest text before the shutdown barrier.');
    await expect(
      restarted
        .getByRole('navigation', { name: 'Meetings' })
        .getByRole('button'),
    ).toHaveCount(1);
    await close(application);
    application = null;
  } finally {
    if (application) {
      await application.evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-export');
      });
      await application.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps a failed shutdown read-only and retries close without resaving into the disposed workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-close-retry-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Saved before the failed close.');
    await application.evaluate(() => {
      const prototype =
        process.getBuiltinModule('node:sqlite').DatabaseSync.prototype;
      const original = prototype.close;
      prototype.close = function () {
        prototype.close = original;
        throw new Error('Synthetic one-time database close failure.');
      };
    });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect(
      page.getByText('The window was kept open', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    expect(
      await page.evaluate(() =>
        window.notes.invoke({ operation: 'bootstrap' }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'desktop_closing' },
    });
    const closed = application.waitForEvent('close');
    await page
      .getByRole('button', { name: 'Retry close', exact: true })
      .click();
    await closed;
    application = null;
    application = await launch(directory);
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Saved before the failed close.');
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
