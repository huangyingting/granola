import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalError } from '@windows-ai-notes/local';
import {
  desktopUpdateCommandSchema,
  desktopUpdateResponseSchema,
  type DesktopUpdateState,
} from '@windows-ai-notes/contracts/updates';
import { DesktopUpdateController } from '../../src/main/update-controller.js';
import type { ReadyUpdate } from '../../src/main/update-downloads.js';

const directory = process.argv.at(-1);
if (!directory)
  throw new Error('Missing isolated update UI fixture directory.');
app.setPath('userData', directory);
async function start() {
  const { preload }: { preload: string } = JSON.parse(
    await readFile(join(directory!, 'fixture.json'), 'utf8'),
  );
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const ready: ReadyUpdate = {
    directory: join(directory!, 'synthetic-only'),
    installer: join(directory!, 'synthetic-only', 'never-executed.exe'),
    feed: {
      version: 1,
      kind: 'windows_update',
      application_version: '0.1.1',
      architecture: 'x64',
      installer: 'windows-ai-notes-0.1.1-x64-signed.exe',
      bytes: 1024 ** 2,
      sha512: Buffer.alloc(64).toString('base64'),
    },
    expected: {
      current_version: '0.1.0',
      version: '0.1.1',
      bytes: 1024 ** 2,
      sha512: Buffer.alloc(64).toString('base64'),
      certificate_sha256: 'ab'.repeat(32),
      publisher: 'Synthetic publisher',
      product_name: 'Windows AI Notes',
    },
  };
  const history: DesktopUpdateState[] = [];
  let finish: (() => void) | null = null;
  let fail = false;
  const controller = new DesktopUpdateController(
    '0.1.0',
    async () => ({
      async recover() {
        return { ready: null, removed: 0, rejected: 1, incomplete: 1 };
      },
      async check() {
        if (fail) {
          fail = false;
          throw new LocalError(
            'update_response_invalid',
            'The synthetic update response was rejected.',
          );
        }
        return ready.feed;
      },
      async download(_feed, signal) {
        return new Promise<ReadyUpdate>((resolve, reject) => {
          const cancel = () => {
            finish = null;
            reject(new DOMException('Cancelled.', 'AbortError'));
          };
          signal!.addEventListener('abort', cancel, { once: true });
          finish = () => {
            signal!.removeEventListener('abort', cancel);
            finish = null;
            resolve(ready);
          };
        });
      },
    }),
    (state) => {
      history.push(state);
      if (!window.isDestroyed())
        window.webContents.send('notes:update-state', state);
    },
  );
  ipcMain.on('fixture:complete', () => finish?.());
  ipcMain.on('fixture:fail-check', () => {
    fail = true;
  });
  ipcMain.on('fixture:stale', () =>
    window.webContents.send('notes:update-state', history[0]),
  );
  ipcMain.handle('notes:update', (event, input: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('Unexpected update UI fixture sender.');
    try {
      return desktopUpdateResponseSchema.parse({
        ok: true,
        state: controller.execute(desktopUpdateCommandSchema.parse(input)),
      });
    } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      return desktopUpdateResponseSchema.parse({
        ok: false,
        error: { code: error.code, message: error.message },
      });
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controller.start();
  await window.loadFile(join(directory!, 'index.html'));
  window.on('closed', () => void controller.close());
  app.on('window-all-closed', () => app.quit());
}
void start().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
