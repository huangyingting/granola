import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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

test('persists the device audio limit and blocks capture without reclaiming unique interrupted files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-storage-ui-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page
      .getByRole('button', { name: '+ New meeting', exact: true })
      .click();
    await page.getByText('Local audio storage', { exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Local audio storage limit' })
      .selectOption('1');
    await expect(page.getByLabel('Measured audio storage')).toContainText(
      '1 GiB limit',
    );
    const source = join(directory, 'recordings', randomUUID());
    await mkdir(source);
    const partial = join(source, 'unique-unuploaded.partial');
    const file = await open(partial, 'wx');
    try {
      await file.truncate(1024 ** 3);
    } finally {
      await file.close();
    }
    const marker = join(source, 'uncommitted.chunk');
    await writeFile(marker, Buffer.from([1, 2, 3]));
    await page
      .getByRole('button', { name: 'Check storage', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('Recording is blocked');
    const rejected = await page.evaluate(async () => {
      const current = await window.notes.invoke({ operation: 'bootstrap' });
      if (!current.ok || !('state' in current) || !current.state.selected_id)
        throw new Error('No current meeting.');
      return window.notes.invoke({
        operation: 'startRecording',
        scope: current.state.scope,
        id: current.state.selected_id,
        tracks: [
          {
            track_id: crypto.randomUUID(),
            kind: 'microphone',
            capture_scope: 'endpoint',
            device_selection_policy: 'explicit',
            device_id: 'synthetic-unavailable-device',
          },
        ],
      });
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'storage_limit' },
    });
    expect((await stat(partial)).size).toBe(1024 ** 3);
    expect(await readFile(marker)).toEqual(Buffer.from([1, 2, 3]));
    expect(
      (await readdir(join(directory, 'recordings'))).filter(
        (name) => name !== 'audio-host.lock',
      ),
    ).toEqual([source.split(/[\\/]/).at(-1)]);
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await page.getByText('Local audio storage', { exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: 'Local audio storage limit' }),
    ).toHaveValue('1');
    await page
      .getByRole('button', { name: 'Check storage', exact: true })
      .click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Recording is blocked' }),
    ).toBeVisible();
    const stale = await page.evaluate(async () => {
      const current = await window.notes.invoke({ operation: 'bootstrap' });
      if (!current.ok || !('state' in current))
        throw new Error('No current workspace.');
      return window.notes.invoke({
        operation: 'setAudioStorageQuota',
        scope: current.state.scope + 1,
        quota_gib: 2,
        confirmed: true,
      });
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'workspace_changed' },
    });
    await page
      .getByRole('combobox', { name: 'Local audio storage limit' })
      .selectOption('2');
    await expect(page.getByLabel('Measured audio storage')).toContainText(
      '2 GiB limit',
    );
    expect((await stat(partial)).size).toBe(1024 ** 3);
    await unlink(partial);
    await page
      .getByRole('button', { name: 'Check storage', exact: true })
      .click();
    await expect(page.getByLabel('Measured audio storage')).toContainText(
      '0.00 GiB saved',
    );
    await expect(
      page.getByRole('alert').filter({ hasText: 'Recording is blocked' }),
    ).toHaveCount(0);
    expect(await readFile(marker)).toEqual(Buffer.from([1, 2, 3]));
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovers audio endpoints through the bundled helper without starting capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-device-ui-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
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
      page.getByText('Checking devices does not start recording.', {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      (await readdir(join(directory, 'recordings'))).filter(
        (name) => name !== 'audio-host.lock',
      ),
    ).toEqual([]);
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('requires explicit source selection, rejects stale capture requests and does not record when configuration is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-capture-ui-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
    await page
      .getByRole('button', { name: '+ New meeting', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Record audio', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Start recording', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: /^Microphone/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: /^System audio/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('region', { name: 'Meeting audio' }),
    ).toContainText('Saved audio uploads only with your consent');
    const rejected = await page.evaluate(async () => {
      const initial = await window.notes.invoke({ operation: 'bootstrap' });
      if (!initial.ok || !('state' in initial) || !initial.state.selected_id)
        throw new Error('No selected draft.');
      return window.notes.invoke({
        operation: 'startRecording',
        scope: initial.state.scope + 1,
        id: initial.state.selected_id,
        tracks: [
          {
            track_id: crypto.randomUUID(),
            kind: 'microphone',
            capture_scope: 'endpoint',
            device_selection_policy: 'default',
            device_id: 'default',
          },
        ],
      });
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'workspace_changed' },
    });
    const staleRecovery = await page.evaluate(async () => {
      const initial = await window.notes.invoke({ operation: 'bootstrap' });
      if (!initial.ok || !('state' in initial) || !initial.state.selected_id)
        throw new Error('No selected draft.');
      return window.notes.invoke({
        operation: 'recoverRecording',
        scope: initial.state.scope + 1,
        id: initial.state.selected_id,
        recording_id: crypto.randomUUID(),
        confirmed: true,
      });
    });
    expect(staleRecovery).toMatchObject({
      ok: false,
      error: { code: 'workspace_changed' },
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Start recording', exact: true }),
    ).toHaveCount(0);
    const state = await page.evaluate(async () => {
      const initial = await window.notes.invoke({ operation: 'bootstrap' });
      if (!initial.ok || !('state' in initial))
        throw new Error('No desktop state.');
      return window.notes.invoke({
        operation: 'getRecordingState',
        scope: initial.state.scope,
        document_id: initial.state.selected_id,
        offset: 0,
      });
    });
    expect(state).toMatchObject({
      ok: true,
      audio_state: { state: { active: null, recordings: [] } },
    });
    expect(
      (await readdir(join(directory, 'recordings'))).filter(
        (name) => name !== 'audio-host.lock',
      ),
    ).toEqual([]);
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('pages meeting summaries and saves the selected editor even when a search excludes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-paging-ui-'));
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page.evaluate(async () => {
      const initial = await window.notes.invoke({ operation: 'bootstrap' });
      if (!initial.ok || !('state' in initial))
        throw new Error('No desktop state.');
      for (let index = 0; index < 55; index++) {
        const created = await window.notes.invoke({
          operation: 'create',
          scope: initial.state.scope,
          value: {
            title: `Synthetic paged meeting ${index}`,
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `Synthetic paged body ${index}.` },
                  ],
                },
              ],
            },
            tags: [],
          },
        });
        if (!created.ok || !('state' in created))
          throw new Error('Synthetic creation failed.');
      }
    });
    await page.reload();
    const editor = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await expect(editor).toHaveText('Synthetic paged body 54.');
    await expect(
      page.getByRole('navigation', { name: 'Meetings' }).getByRole('button'),
    ).toHaveCount(50);
    await page
      .getByRole('button', { name: 'More meetings', exact: true })
      .click();
    await expect(
      page.getByRole('navigation', { name: 'Meetings' }).getByRole('button'),
    ).toHaveCount(5);
    await expect(editor).toHaveText('Synthetic paged body 54.');
    await page
      .getByRole('textbox', { name: 'Search meetings' })
      .fill('Phrase absent from every meeting.');
    await expect(
      page.getByRole('navigation', { name: 'Meetings' }).getByRole('button'),
    ).toHaveCount(0);
    await expect(editor).toHaveText('Synthetic paged body 54.');
    await editor.fill('Synthetic edit saved outside the current search.');
    await expect(
      page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic edit saved outside the current search.');
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
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
      filesystem: ['invoke', 'onChanged', 'onFlush'],
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
