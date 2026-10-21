import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test.skip(
  process.platform !== 'win32',
  'Real Windows DPAPI and the sandboxed Electron renderer are required.',
);
const secret = 'Synthetic private planning note 439056.';
const secondLine = '\u7b2c\u4e8c\u884c synthetic follow-up.';
async function launch(directory: string) {
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

test('persists rich text across restart, isolates the renderer and keeps local files encrypted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-ui-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting title' })
      .fill('Synthetic design review');
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(secret);
    const editor = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await editor.press('Shift+Enter');
    await editor.pressSequentially(secondLine);
    await editor.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong').first()).toContainText(secret);
    await page
      .getByRole('textbox', { name: 'Meeting tags' })
      .fill('Planning, Review');
    await expect(
      page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    const exportPath = join(directory, 'explicit-unencrypted-export.md');
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportPath);
    await page
      .getByRole('button', { name: 'Export Markdown', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Unencrypted export saved.' }),
    ).toBeVisible();
    const exported = await readFile(exportPath, 'utf8');
    expect(exported).toContain('# Synthetic design review');
    expect(exported).toContain('**');
    expect(exported).toContain(secondLine.replace(/[.-]/gu, '\\$&'));
    expect(
      await page.evaluate(() => ({
        node: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        filesystem: Object.keys(
          (window as unknown as { notes: object }).notes,
        ).sort(),
      })),
    ).toEqual({
      node: 'undefined',
      process: 'undefined',
      filesystem: ['invoke', 'onFlush'],
    });
    expect(
      await application.evaluate(({ BrowserWindow, safeStorage }) => ({
        sandbox:
          BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()
            .sandbox,
        isolation:
          BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()
            .contextIsolation,
        encrypted: safeStorage.isEncryptionAvailable(),
      })),
    ).toEqual({ sandbox: true, isolation: true, encrypted: true });
    expect(
      await page.evaluate(async () => {
        try {
          await fetch('https://example.com/');
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => window.open('https://example.com/')),
    ).toBeNull();
    expect(application.windows()).toHaveLength(1);
    await close(application);
    application = null;
    for (const name of await readdir(directory)) {
      if (!name.startsWith('notes.sqlite') && name !== 'content-key.protected')
        continue;
      const bytes = await readFile(join(directory, name));
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from(secondLine))).toBe(false);
      expect(bytes.includes(Buffer.from('Synthetic design review'))).toBe(
        false,
      );
    }
    application = await launch(directory);
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting title' }),
    ).toHaveValue('Synthetic design review');
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toContainText(secret);
    await expect(
      restarted
        .getByRole('textbox', { name: 'Meeting notes', exact: true })
        .locator('strong')
        .first(),
    ).toContainText(secret);
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toContainText(secondLine);
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting tags' }),
    ).toHaveValue('Planning, Review');
    await restarted
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('');
    await expect(
      restarted.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    await close(application);
    application = null;
    application = await launch(directory);
    const empty = await application.firstWindow();
    await expect(
      empty.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toBeEmpty();
    await empty.getByRole('button', { name: 'Delete', exact: true }).click();
    await empty
      .getByRole('button', { name: 'Delete meeting', exact: true })
      .click();
    await expect(
      empty.getByRole('button', { name: 'Create your first meeting' }),
    ).toBeVisible();
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('blocks closing and document switches while edits are invalid, then flushes the corrected latest text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-flush-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting tags' })
      .fill('Duplicate, duplicate');
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Latest text must survive.');
    await expect(page.getByText('NOT SAVED', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: '+ New meeting', exact: true })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting tags' }),
    ).toHaveValue('Duplicate, duplicate');
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect(page.getByText('NOT SAVED', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Meeting tags' }).fill('Corrected');
    await close(application);
    application = null;
    application = await launch(directory);
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Latest text must survive.');
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting tags' }),
    ).toHaveValue('Corrected');
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed instead of replacing a missing or invalid operating-system-wrapped content key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-key-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(secret);
    await close(application);
    application = null;
    const path = join(directory, 'content-key.protected');
    const key = await readFile(path);
    const original = await readFile(join(directory, 'notes.sqlite'));
    await unlink(path);
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(page.getByRole('alert')).toContainText(
      'content key is missing',
    );
    await expect(
      page.getByRole('button', { name: 'Create your first meeting' }),
    ).toBeDisabled();
    await close(application);
    application = null;
    expect(await readFile(join(directory, 'notes.sqlite'))).toEqual(original);
    await writeFile(path, Buffer.from('Not a DPAPI envelope.'));
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(page.getByRole('alert')).toContainText('cannot be unlocked');
    await close(application);
    application = null;
    expect(await readFile(join(directory, 'notes.sqlite'))).toEqual(original);
    await writeFile(path, key);
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(secret);
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
