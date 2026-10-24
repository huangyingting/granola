import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopFixture } from '../../../packages/client/src/desktop.fixture.js';

test.skip(
  process.platform !== 'win32',
  'Real Windows DPAPI and Electron Main shutdown are required.',
);

function launch(directory: string, allowLoopback = false) {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WINDOWS_NOTES_DATA_DIR: directory,
      ...(allowLoopback ? { WINDOWS_NOTES_ALLOW_LOOPBACK: '1' } : {}),
    },
  });
}
async function close(application: ElectronApplication) {
  const completed = Promise.all([
    application.waitForEvent('close'),
    once(application.process(), 'exit'),
  ]);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  const [, [code, signal]] = await completed;
  expect(code).toBe(0);
  expect(signal).toBeNull();
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function connect(application: ElectronApplication, url: string) {
  await application.evaluate(({ shell }) => {
    shell.openExternal = async (authorization) => {
      const response = await fetch(authorization, { redirect: 'manual' });
      const redirect = response.headers.get('location');
      if (!redirect) throw new Error('The synthetic issuer did not redirect.');
      const callback = await fetch(redirect);
      if (!callback.ok) throw new Error('The synthetic sign-in was rejected.');
      await callback.arrayBuffer();
    };
  });
  const page = await application.firstWindow();
  await page.getByRole('button', { name: /Account & sync/ }).click();
  await page.getByRole('textbox', { name: 'Service URL' }).fill(url);
  await page
    .getByRole('button', { name: 'Sign in with browser', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: /^Synthetic cloud workspace Open workspace$/,
    }),
  ).toBeVisible();
}
async function observeCancellation(
  application: ElectronApplication,
  target: string,
  marker: string,
) {
  await application.evaluate(
    (_, { target, marker }) => {
      const { writeFileSync } = process.getBuiltinModule('node:fs');
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url !== target) return nativeFetch(input, options);
        const signal = options?.signal;
        if (!signal)
          throw new Error('The account request has no abort signal.');
        const aborted = () => {
          const reason: unknown = signal.reason;
          const owned =
            typeof reason === 'object' &&
            reason !== null &&
            'name' in reason &&
            reason.name === 'AbortError';
          writeFileSync(
            marker,
            owned ? 'caller_cancelled' : 'deadline_or_unknown',
            { flag: 'wx', mode: 0o600, flush: true },
          );
        };
        signal.addEventListener('abort', aborted, { once: true });
        return nativeFetch(input, options).finally(() =>
          signal.removeEventListener('abort', aborted),
        );
      };
    },
    { target, marker },
  );
}

for (const path of ['/v1/me', '/v1/workspaces'] as const) {
  test(`closes the real Windows process during held workspace selection at ${path} without a timeout or late copy`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'windows-notes-close-account-'),
    );
    const fixture = await desktopFixture();
    const ready = gate(),
      release = gate();
    const marker = join(directory, 'account-cancellation.fixture');
    let application: ElectronApplication | null = null;
    try {
      application = await launch(directory, true);
      let page = await application.firstWindow();
      await page
        .getByRole('button', { name: 'Create your first meeting' })
        .click();
      const text = 'Synthetic offline note must not be copied during close.';
      await page
        .getByRole('textbox', { name: 'Meeting notes', exact: true })
        .fill(text);
      await connect(application, fixture.url);
      await page
        .getByRole('checkbox', { name: /Copy my device-only drafts/ })
        .check();
      fixture.state.accountGate = {
        path,
        started: ready.resolve,
        release: release.promise,
      };
      await observeCancellation(application, `${fixture.url}${path}`, marker);
      await page
        .getByRole('button', {
          name: /^Synthetic cloud workspace Open workspace$/,
        })
        .click();
      await ready.promise;
      await close(application);
      application = null;
      expect(await readFile(marker, 'utf8')).toBe('caller_cancelled');
      expect(fixture.state.documents.size).toBe(0);
      application = await launch(directory, true);
      page = await application.firstWindow();
      await expect(
        page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
      ).toHaveText(text);
      expect(
        await page.evaluate(() =>
          window.notes.invoke({ operation: 'bootstrap' }),
        ),
      ).toMatchObject({
        ok: true,
        state: {
          connection: { active_workspace: null, user_id: fixture.state.user },
          documents: [{ status: 'local' }],
        },
      });
      expect(fixture.state.documents.size).toBe(0);
      await close(application);
      application = null;
    } finally {
      release.resolve();
      if (application) await application.close();
      await fixture.close();
      expect(fixture.state.failures).toEqual([]);
      expect(fixture.issuer.state.failures).toEqual([]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('closes the real Windows process during held committed revocation without resurrecting credentials', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'windows-notes-close-revoke-'),
  );
  const fixture = await desktopFixture();
  fixture.seed('Synthetic cached cloud note must be removed.');
  const ready = gate(),
    release = gate();
  const marker = join(directory, 'revocation-cancellation.fixture');
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory, true);
    let page = await application.firstWindow();
    const text = 'Synthetic original device-only draft survives disconnect.';
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(text);
    await connect(application, fixture.url);
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace Open workspace$/,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic cached cloud note must be removed.');
    await page.getByRole('button', { name: /Account & sync/ }).click();
    fixture.issuer.state.revocationStarted = ready.resolve;
    fixture.issuer.state.revocationGate = release.promise;
    await observeCancellation(
      application,
      `${fixture.issuer.state.issuer}revoke`,
      marker,
    );
    await page
      .getByRole('button', { name: 'Disconnect account', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm disconnect', exact: true })
      .click();
    await ready.promise;
    expect(fixture.issuer.state.revoked).toHaveLength(1);
    await close(application);
    application = null;
    expect(await readFile(marker, 'utf8')).toBe('caller_cancelled');
    application = await launch(directory, true);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(text);
    expect(
      await page.evaluate(() =>
        window.notes.invoke({ operation: 'bootstrap' }),
      ),
    ).toMatchObject({
      ok: true,
      state: {
        connection: { status: 'offline', user_id: null },
        documents: [{ status: 'local' }],
      },
    });
    expect(fixture.issuer.state.revoked).toHaveLength(1);
    await close(application);
    application = null;
  } finally {
    release.resolve();
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('closes the real Windows sign-in callback and unused TCP socket while the browser opener never completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-close-login-'));
  const fixture = await desktopFixture();
  let application: ElectronApplication | null = null;
  let socket: Socket | null = null;
  const socketErrors: string[] = [];
  try {
    application = await launch(directory, true);
    const current = application;
    await current.evaluate(({ ipcMain, shell }) => {
      shell.openExternal = async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri');
        if (!redirect) throw new Error('The loopback callback is unavailable.');
        ipcMain.once(
          'fixture:callback-port',
          (_event, resolve: (port: number) => void) =>
            resolve(Number(new URL(redirect).port)),
        );
        await new Promise<void>(() => {});
      };
    });
    let page = await current.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await expect
      .poll(() =>
        current.evaluate(({ ipcMain }) =>
          ipcMain.listenerCount('fixture:callback-port'),
        ),
      )
      .toBe(1);
    const port = await current.evaluate(
      ({ ipcMain }) =>
        new Promise<number>((resolve) => {
          ipcMain.emit('fixture:callback-port', null, resolve);
        }),
    );
    const client = createConnection({ host: '127.0.0.1', port });
    socket = client;
    client.on('error', (error: NodeJS.ErrnoException) =>
      socketErrors.push(error.code ?? 'unknown'),
    );
    const disconnected = new Promise<void>((resolve) =>
      client.once('close', () => resolve()),
    );
    await once(client, 'connect');
    await Promise.all([close(current), disconnected]);
    application = null;
    expect(socket.destroyed).toBe(true);
    expect(socketErrors.every((code) => code === 'ECONNRESET')).toBe(true);
    expect(fixture.issuer.state.tokenCalls).toBe(0);
    application = await launch(directory, true);
    page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await expect(
      page.getByRole('button', { name: 'Sign in with browser', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.notes.invoke({ operation: 'bootstrap' }),
      ),
    ).toMatchObject({
      ok: true,
      state: { connection: { status: 'offline', user_id: null } },
    });
    await close(application);
    application = null;
  } finally {
    socket?.destroy();
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

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
