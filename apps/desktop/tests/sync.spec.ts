import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopFixture } from '../../../packages/client/src/desktop.fixture.js';

test.skip(
  process.platform !== 'win32',
  'Real Windows DPAPI and the sandboxed Electron renderer are required.',
);
async function launch(directory: string) {
  const application = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WINDOWS_NOTES_DATA_DIR: directory,
      WINDOWS_NOTES_ALLOW_LOOPBACK: '1',
    },
  });
  await application.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      const response = await fetch(url, { redirect: 'manual' });
      const redirect = response.headers.get('location');
      if (!redirect) throw new Error('The synthetic issuer did not redirect.');
      const callback = await fetch(redirect);
      if (!callback.ok)
        throw new Error('The native loopback callback rejected sign-in.');
      await callback.arrayBuffer();
    };
  });
  return application;
}
async function close(application: ElectronApplication) {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.close(),
  );
  await closed;
}
async function synchronize(application: ElectronApplication) {
  const page = await application.firstWindow();
  return page.evaluate(async () => {
    const current = await window.notes.invoke({ operation: 'bootstrap' });
    if (!current.ok || !('state' in current))
      throw new Error('No desktop state.');
    return window.notes.invoke({
      operation: 'sync',
      scope: current.state.scope,
    });
  });
}

test('connects through real OIDC, requires offline-copy consent, syncs edits and restores the account across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-account-ui-'));
  const fixture = await desktopFixture();
  const remote = fixture.seed(
    'Synthetic remote meeting text.',
    'Synthetic immutable transcript evidence.',
  );
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Synthetic device-only private text.');
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic remote meeting text.');
    expect([...fixture.state.documents.values()]).toHaveLength(1);
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page
      .getByRole('checkbox', { name: /Copy my device-only drafts/ })
      .check();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect
      .poll(() =>
        [...fixture.state.documents.values()].map((document) => document.notes),
      )
      .toContain('Synthetic device-only private text.');
    await page
      .getByRole('button', { name: 'Synthetic cloud meeting', exact: false })
      .first()
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Synthetic cloud edit from the desktop.');
    await expect
      .poll(() => fixture.state.documents.get(remote.id)?.notes)
      .toBe('Synthetic cloud edit from the desktop.');
    await page
      .getByText('Transcript', { exact: false })
      .filter({ hasText: 'Revision 1' })
      .first()
      .click();
    await expect(
      page
        .getByRole('paragraph')
        .filter({ hasText: 'Synthetic immutable transcript evidence.' }),
    ).toBeVisible();
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic cloud edit from the desktop.');
    expect(fixture.issuer.state.tokenCalls).toBe(1);
    await expect
      .poll(async () => {
        const response = await page.evaluate(() =>
          window.notes.invoke({ operation: 'bootstrap' }),
        );
        return response.ok && 'state' in response
          ? response.state.connection.unsent_count
          : -1;
      })
      .toBe(0);
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page
      .getByRole('button', { name: 'Disconnect account', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm disconnect', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Sign in with browser', exact: true }),
    ).toBeVisible();
    expect(fixture.issuer.state.revoked).toHaveLength(1);
    const state = await page.evaluate(() =>
      window.notes.invoke({ operation: 'bootstrap' }),
    );
    expect(state).toMatchObject({
      ok: true,
      state: {
        documents: [{ status: 'local' }],
        connection: { user_id: null },
      },
    });
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves stale-editor text as a new copy and clears even invalid editor content on confirmed revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-recovery-ui-'));
  const fixture = await desktopFixture();
  const remote = fixture.seed('Synthetic original cloud text.');
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    const editor = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await expect(editor).toHaveText('Synthetic original cloud text.');
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...arguments_) => {
        if (channel !== 'notes:changed') send(channel, ...arguments_);
      };
    });
    fixture.change(remote.id, 'Synthetic newer cloud version.');
    await synchronize(application);
    await editor.fill('Synthetic stale editor text that must not be lost.');
    await expect(page.getByText('NOT SAVED', { exact: true })).toBeVisible();
    await expect(editor).toHaveText(
      'Synthetic stale editor text that must not be lost.',
    );
    await page
      .getByRole('button', { name: 'Save editor as a new copy', exact: true })
      .click();
    await expect(
      page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        [...fixture.state.documents.values()].map((document) => document.notes),
      )
      .toContain('Synthetic stale editor text that must not be lost.');
    expect(fixture.state.documents.get(remote.id)?.notes).toBe(
      'Synthetic newer cloud version.',
    );
    await close(application);
    application = null;
    application = await launch(directory);
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic stale editor text that must not be lost.');
    await restarted
      .getByRole('textbox', { name: 'Meeting tags' })
      .fill('Duplicate, duplicate');
    await expect(
      restarted.getByText('NOT SAVED', { exact: true }),
    ).toBeVisible();
    fixture.state.active = false;
    const running = application;
    await expect
      .poll(async () => {
        await synchronize(running);
        const response = await restarted.evaluate(() =>
          window.notes.invoke({ operation: 'bootstrap' }),
        );
        return response.ok && 'state' in response
          ? response.state.connection.status
          : 'unavailable';
      })
      .toBe('reauth_required');
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveCount(0);
    await expect(
      restarted.getByRole('heading', { name: 'Your notes, in sync.' }),
    ).toBeVisible();
    expect(await restarted.locator('body').innerText()).not.toContain(
      'Synthetic stale editor text that must not be lost.',
    );
    const state = await restarted.evaluate(() =>
      window.notes.invoke({ operation: 'bootstrap' }),
    );
    expect(state).toMatchObject({
      ok: true,
      state: {
        documents: [],
        connection: { status: 'reauth_required', active_workspace: null },
      },
    });
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});
