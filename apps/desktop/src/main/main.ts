import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import {
  exportMeeting,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import {
  desktopCommandSchema,
  desktopResponseSchema,
  type DesktopState,
  type DesktopResponse,
} from '@windows-ai-notes/contracts/desktop';

let store: LocalStore | null = null;
let window: BrowserWindow | null = null;
let failure: { code: string; message: string } | null = null;
let closeNonce: string | null = null;
let allowClose = false;
let dataDirectory = '';
const profile = 'offline';

function localKey(directory: string): Buffer {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text')
  )
    throw new LocalError(
      'encryption_unavailable',
      'Secure operating-system encryption is unavailable. No unprotected fallback was used.',
    );
  const path = join(directory, 'content-key.protected');
  if (existsSync(path)) {
    try {
      const bytes = readFileSync(path);
      if (bytes.length > 65_536) throw new Error('Invalid key envelope.');
      const text = safeStorage.decryptString(bytes);
      const key = Buffer.from(text, 'base64');
      if (key.length !== 32 || key.toString('base64') !== text)
        throw new Error('Invalid key.');
      return key;
    } catch {
      throw new LocalError(
        'local_key_unavailable',
        'The content key cannot be unlocked. Use the original Windows account; existing data was not reset.',
      );
    }
  }
  if (existsSync(join(directory, 'notes.sqlite')))
    throw new LocalError(
      'local_key_missing',
      'The content key is missing. Existing local notes were preserved; do not delete or reset their files.',
    );
  const key = randomBytes(32);
  const pending = `${path}.${randomUUID()}.partial`;
  writeFileSync(pending, safeStorage.encryptString(key.toString('base64')), {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
  renameSync(pending, path);
  return key;
}
function database(): LocalStore {
  if (!store)
    throw new LocalError(
      failure?.code ?? 'storage_unavailable',
      failure?.message ?? 'Local storage is unavailable.',
    );
  return store;
}
function state(): DesktopState {
  const db = database();
  const documents = db.list(profile);
  const requested = db.getValue(profile, 'selected-document', z.uuidv4());
  const selected =
    documents.find((document) => document.id === requested)?.id ??
    documents[0]?.id ??
    null;
  return { documents, selected_id: selected, storage: 'encrypted' };
}
function safeError(error: unknown) {
  if (error instanceof LocalError)
    return { code: error.code, message: error.message };
  console.error(
    JSON.stringify({
      code: 'desktop_operation_failed',
      kind: error instanceof Error ? error.name : 'unknown',
    }),
  );
  return {
    code: 'desktop_operation_failed',
    message:
      'The operation could not be completed. Existing data was preserved.',
  };
}
async function start() {
  if (
    !app.isPackaged &&
    process.env.NODE_ENV === 'test' &&
    process.env.WINDOWS_NOTES_DATA_DIR
  )
    app.setPath('userData', process.env.WINDOWS_NOTES_DATA_DIR);
  dataDirectory = app.getPath('userData');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const key = localKey(dataDirectory);
    try {
      store = new LocalStore(join(dataDirectory, 'notes.sqlite'), key);
    } finally {
      key.fill(0);
    }
  } catch (error) {
    failure = safeError(error);
    console.error(JSON.stringify({ code: failure.code }));
  }
  const directory = dirname(fileURLToPath(import.meta.url));
  const page = pathToFileURL(join(directory, '../renderer/index.html')).href;
  window = new BrowserWindow({
    width: 1250,
    height: 840,
    minWidth: 850,
    minHeight: 600,
    title: 'Windows AI Notes',
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: join(directory, '../preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  const current = window;
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event, url) => {
    if (url !== page) event.preventDefault();
  });
  current.webContents.on('will-redirect', (event) => event.preventDefault());
  current.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  current.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  current.webContents.session.setPermissionCheckHandler(() => false);
  ipcMain.handle(
    'notes:invoke',
    async (event, input: unknown): Promise<DesktopResponse> => {
      try {
        if (
          event.sender !== current.webContents ||
          event.senderFrame !== current.webContents.mainFrame ||
          event.senderFrame.url !== page
        )
          throw new LocalError(
            'untrusted_sender',
            'This window cannot access local notes.',
          );
        const parsed = desktopCommandSchema.safeParse(input);
        if (!parsed.success)
          throw new LocalError(
            'invalid_desktop_request',
            'The desktop request is invalid.',
          );
        const command = parsed.data;
        if (command.operation === 'closeReady') {
          if (!closeNonce || command.nonce !== closeNonce)
            throw new LocalError(
              'invalid_close_request',
              'No matching close operation is pending.',
            );
          allowClose = true;
          current.close();
          return {
            ok: true,
            state: { documents: [], selected_id: null, storage: 'encrypted' },
          };
        }
        if (command.operation === 'openRecoveryFolder') {
          if (await shell.openPath(dataDirectory))
            throw new LocalError(
              'recovery_folder_failed',
              'The recovery folder could not be opened.',
            );
          return failure
            ? { ok: false, error: failure }
            : { ok: true, state: state() };
        }
        const db = database();
        if (command.operation === 'create') {
          const draft = db.create(profile, command.value);
          db.putValue(profile, 'selected-document', draft.id);
        } else if (command.operation === 'select') {
          db.get(profile, command.id);
          db.putValue(profile, 'selected-document', command.id);
        } else if (command.operation === 'save') {
          db.save(profile, command.id, command.local_revision, command.value);
        } else if (command.operation === 'delete') {
          db.remove(profile, command.id);
        } else if (command.operation === 'export') {
          const draft = db.get(profile, command.id);
          const suffix = command.format === 'markdown' ? 'md' : 'txt';
          const name =
            draft.title
              .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
              .trim()
              .replace(/[. ]+$/g, '')
              .slice(0, 100) || 'Meeting';
          const result = await dialog.showSaveDialog(current, {
            title: 'Export unencrypted notes',
            defaultPath: join(app.getPath('documents'), `${name}.${suffix}`),
            filters: [
              {
                name: command.format === 'markdown' ? 'Markdown' : 'Plain text',
                extensions: [suffix],
              },
            ],
            properties: ['showOverwriteConfirmation'],
          });
          if (result.canceled || !result.filePath)
            return { ok: true, state: state(), notice: 'export_cancelled' };
          const temporary = `${result.filePath}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              exportMeeting(
                {
                  ...draft,
                  notes: richTextToPlainText(draft.content),
                },
                command.format,
              ),
              { flag: 'wx', mode: 0o600, flush: true },
            );
            await rename(temporary, result.filePath);
          } finally {
            await rm(temporary, { force: true });
          }
          return { ok: true, state: state(), notice: 'exported' };
        }
        return desktopResponseSchema.parse({ ok: true, state: state() });
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    },
  );
  current.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    closeNonce ??= randomUUID();
    current.webContents.send('notes:flush', closeNonce);
  });
  current.on('closed', () => {
    store?.close();
    store = null;
    window = null;
  });
  await current.loadURL(page);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          code: 'desktop_start_failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
      app.exit(1);
    });
}
