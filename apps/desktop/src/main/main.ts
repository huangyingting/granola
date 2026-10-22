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
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import { ClientError } from '@windows-ai-notes/client/http';
import { WorkspaceController } from '@windows-ai-notes/client/workspace';
import { RecordingController } from '@windows-ai-notes/client/recording';
import { DesktopDelivery } from '@windows-ai-notes/client/delivery';
import {
  AudioHostClient,
  AudioHostError,
} from '@windows-ai-notes/client/audio';
import type { AudioEvent } from '@windows-ai-notes/contracts';
import { resourceId } from '@windows-ai-notes/contracts/server';
import {
  exportMeeting,
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import {
  desktopCommandSchema,
  desktopResponseSchema,
  type DesktopState,
  type DesktopResponse,
} from '@windows-ai-notes/contracts/desktop';
import {
  desktopUpdateCommandSchema,
  desktopUpdateResponseSchema,
  type DesktopUpdateResponse,
} from '@windows-ai-notes/contracts/updates';
import {
  loadPackagedUpdatePolicy,
  UpdateDownloads,
} from './update-downloads.js';
import { DesktopUpdateController } from './update-controller.js';

let store: LocalStore | null = null;
let controller: WorkspaceController | null = null;
let window: BrowserWindow | null = null;
let failure: { code: string; message: string } | null = null;
let closeNonce: string | null = null;
let allowClose = false;
let closingAudio = false;
let dataDirectory = '';
let recordings: RecordingController | null = null;
let delivery: DesktopDelivery | null = null;
let updates: DesktopUpdateController | null = null;

function audioHostExecutable() {
  if (process.platform !== 'win32')
    throw new LocalError(
      'platform_unsupported',
      'The audio helper requires Windows.',
    );
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'audio-host', 'AudioHost.exe')
    : join(
        app.getAppPath(),
        '../../artifacts/audio-host/win-x64/AudioHost.exe',
      );
  if (!existsSync(executable))
    throw new LocalError(
      'audio_host_missing',
      app.isPackaged
        ? 'The bundled audio helper is missing. Reinstall a complete application package; no external helper was used.'
        : 'Build the audio helper with pnpm audio:publish before checking audio devices.',
    );
  return executable;
}
function createAudioHost(observe: (event: AudioEvent) => void) {
  return new AudioHostClient(
    audioHostExecutable(),
    ['--data-dir', join(dataDirectory, 'recordings')],
    observe,
  );
}
function audio(): RecordingController {
  if (!recordings)
    throw new LocalError(
      'audio_unavailable',
      'The audio coordinator is unavailable.',
    );
  return recordings;
}
function audioMaintenance() {
  if (!recordings || !controller || closingAudio || allowClose) return;
  recordings.resumeUploads(controller.recordingUploadContext());
  void recordings
    .reconcile(controller.profile)
    .then(() => {
      if (!closingAudio && !allowClose && recordings && controller)
        recordings.resumeUploads(controller.recordingUploadContext());
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          code: 'recording_cleanup_pending',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
    });
}

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
function workspace(): WorkspaceController {
  if (!controller)
    throw new LocalError(
      failure?.code ?? 'workspace_unavailable',
      failure?.message ?? 'The workspace is unavailable.',
    );
  return controller;
}
function state(): DesktopState {
  return workspace().snapshot();
}
function safeError(error: unknown) {
  if (
    error instanceof LocalError ||
    error instanceof ClientError ||
    error instanceof AudioHostError
  )
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
      delivery = new DesktopDelivery();
      controller = new WorkspaceController(
        store,
        (url) => shell.openExternal(url),
        (change) => {
          if (change.kind !== 'audio') audioMaintenance();
          if (window && !window.isDestroyed())
            window.webContents.send('notes:changed', change);
        },
        {
          delivery,
          allowLoopback:
            !app.isPackaged &&
            ['test', 'development'].includes(process.env.NODE_ENV ?? '') &&
            process.env.WINDOWS_NOTES_ALLOW_LOOPBACK === '1',
        },
      );
      recordings = new RecordingController(
        store,
        createAudioHost,
        () => controller?.audioChanged(),
        async (id) => {
          resourceId.parse(id);
          await rm(join(dataDirectory, 'recordings', id), {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        },
        delivery,
      );
    } finally {
      key.fill(0);
    }
  } catch (error) {
    failure = safeError(error);
    controller?.dispose();
    delivery?.close();
    controller = null;
    store?.close();
    store = null;
    recordings = null;
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
  const authorizeSender = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== current.webContents ||
      event.senderFrame !== current.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      throw new LocalError(
        'untrusted_sender',
        'This window cannot access desktop operations.',
      );
  };
  updates = new DesktopUpdateController(
    app.getVersion(),
    async () => {
      const policy = await loadPackagedUpdatePolicy(
        process.resourcesPath,
        app.isPackaged,
      );
      return policy
        ? new UpdateDownloads(
            join(dataDirectory, 'updates'),
            audioHostExecutable(),
            policy,
            app.getVersion(),
          )
        : null;
    },
    (state) => {
      if (!current.isDestroyed())
        current.webContents.send('notes:update-state', state);
    },
  );
  updates.start();
  ipcMain.handle(
    'notes:update',
    (event, input: unknown): DesktopUpdateResponse => {
      try {
        authorizeSender(event);
        const command = desktopUpdateCommandSchema.safeParse(input);
        if (!command.success)
          throw new LocalError(
            'invalid_desktop_request',
            'The update request is invalid.',
          );
        if (!updates)
          throw new LocalError(
            'update_closed',
            'The update service is unavailable.',
          );
        return desktopUpdateResponseSchema.parse({
          ok: true,
          state: updates.execute(command.data),
        });
      } catch (error) {
        return desktopUpdateResponseSchema.parse({
          ok: false,
          error: safeError(error),
        });
      }
    },
  );
  ipcMain.handle(
    'notes:invoke',
    async (event, input: unknown): Promise<DesktopResponse> => {
      try {
        authorizeSender(event);
        const parsed = desktopCommandSchema.safeParse(input);
        if (!parsed.success)
          throw new LocalError(
            'invalid_desktop_request',
            'The desktop request is invalid.',
          );
        const command = parsed.data;
        if (command.operation === 'observePresentation') {
          workspace().assertScope(command.scope);
          const current = workspace().snapshot();
          return {
            ok: true,
            observed:
              current.selected_id === command.id &&
              (delivery?.present(command.scope, command.id, command.token) ??
                false),
          };
        }
        if (command.operation === 'closeReady') {
          if (!closeNonce || command.nonce !== closeNonce)
            throw new LocalError(
              'invalid_close_request',
              'No matching close operation is pending.',
            );
          closingAudio = true;
          try {
            await recordings?.stop(() => {});
          } catch (error) {
            closingAudio = false;
            throw error;
          }
          await updates?.close();
          allowClose = true;
          current.close();
          return { ok: true, closing: true };
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
        if (command.operation === 'getChat') {
          const view = await workspace().chat.read(command);
          return desktopResponseSchema.parse({
            ok: true,
            chat_view: { scope: command.scope, view },
          });
        }
        if (command.operation === 'watchChat') {
          const active = workspace();
          await active.chat.watch(command);
          return desktopResponseSchema.parse({
            ok: true,
            state: active.snapshot(),
          });
        }
        if (command.operation === 'getChatSource') {
          const source = await workspace().chat.source(command);
          return desktopResponseSchema.parse({
            ok: true,
            chat_source: { scope: command.scope, source },
          });
        }
        if (
          command.operation === 'askMeeting' ||
          command.operation === 'controlChatTurn' ||
          command.operation === 'deleteChatThread'
        ) {
          const active = workspace();
          let thread: string | null;
          if (command.operation === 'deleteChatThread') {
            await active.chat.remove(command);
            thread = null;
          } else {
            const turn =
              command.operation === 'askMeeting'
                ? await active.chat.start(command)
                : await active.chat.control(command);
            thread = turn.thread_id;
          }
          const view = await active.chat.read({
            operation: 'getChat',
            scope: command.scope,
            id: command.id,
            thread_id: thread,
            offset: 0,
            refresh: false,
          });
          return desktopResponseSchema.parse({
            ok: true,
            chat_view: { scope: command.scope, view },
          });
        }
        if (command.operation === 'getAccountUsage') {
          const account = await workspace().accountUsage(command.scope);
          return desktopResponseSchema.parse({
            ok: true,
            account_usage: { scope: command.scope, account },
          });
        }
        if (command.operation === 'getTranscriptPage') {
          const page = await workspace().transcriptPage(
            command.scope,
            command.id,
            command.revision,
            command.offset,
          );
          return desktopResponseSchema.parse({
            ok: true,
            transcript_page: {
              scope: command.scope,
              page,
              presentation: delivery
                ?.markers(command.scope, command.id)
                .find(
                  (value) =>
                    value.kind === 'transcript_page' &&
                    value.revision === page.revision &&
                    value.offset === page.offset,
                ),
            },
          });
        }
        if (command.operation === 'getTranscriptTimeline') {
          const page = await workspace().transcriptTimeline(
            command.scope,
            command.id,
            command.revision,
            command.offset,
          );
          return desktopResponseSchema.parse({
            ok: true,
            transcript_timeline: { scope: command.scope, page },
          });
        }
        if (command.operation === 'finalizeRecordingTranscript')
          return desktopResponseSchema.parse({
            ok: true,
            state: await workspace().finalizeRecording(command),
          });
        if (command.operation === 'controlTranscriptionJob')
          return desktopResponseSchema.parse({
            ok: true,
            state: await workspace().controlTranscription(command),
          });
        if (command.operation === 'applyTranscript')
          return desktopResponseSchema.parse({
            ok: true,
            state: await workspace().applyTranscript(command),
          });
        if (command.operation === 'getSummaryTemplates') {
          const catalog = await workspace().summaries.templates(
            command.scope,
            command.id,
          );
          return desktopResponseSchema.parse({
            ok: true,
            summary_templates: {
              scope: command.scope,
              document_id: command.id,
              catalog,
            },
          });
        }
        if (command.operation === 'getSummaryProgress') {
          const progress = await workspace().summaries.progress(command);
          return desktopResponseSchema.parse({
            ok: true,
            summary_progress: { scope: command.scope, progress },
          });
        }
        if (command.operation === 'watchSummary') {
          const active = workspace();
          active.assertScope(command.scope);
          if (command.action === 'start')
            await active.summaries.events.start(
              command.scope,
              command.id,
              command.job_id,
            );
          else active.summaries.events.stop(command.job_id);
          return desktopResponseSchema.parse({
            ok: true,
            state: active.snapshot(),
          });
        }
        if (
          command.operation === 'startSummary' ||
          command.operation === 'controlSummary' ||
          command.operation === 'applySummaryReview'
        ) {
          const active = workspace();
          if (command.operation === 'startSummary')
            await active.summaries.start(command);
          else if (command.operation === 'controlSummary')
            await active.summaries.control(command);
          else await active.summaries.apply(command);
          return desktopResponseSchema.parse({
            ok: true,
            state: active.snapshot(),
          });
        }
        if (
          command.operation === 'openSummaryReview' ||
          command.operation === 'saveSummaryReview'
        ) {
          const active = workspace();
          const review =
            command.operation === 'openSummaryReview'
              ? await active.summaries.open(command)
              : active.summaries.save(command);
          return desktopResponseSchema.parse({
            ok: true,
            summary_review: { scope: command.scope, review },
          });
        }
        if (command.operation === 'getSummarySource') {
          const source = await workspace().summaries.source(command);
          return desktopResponseSchema.parse({
            ok: true,
            summary_source: { scope: command.scope, source },
          });
        }
        if (command.operation === 'listAudioDevices') {
          const active = workspace();
          active.assertScope(command.scope);
          const devices = await audio().listDevices();
          active.assertScope(command.scope);
          return desktopResponseSchema.parse({
            ok: true,
            audio_devices: { scope: command.scope, devices },
          });
        }
        if (
          command.operation === 'getRecordingState' ||
          command.operation === 'startRecording' ||
          command.operation === 'controlRecording' ||
          command.operation === 'inspectRecording' ||
          command.operation === 'recoverRecording' ||
          command.operation === 'removeRecording' ||
          command.operation === 'uploadRecording' ||
          command.operation === 'pauseRecordingUpload' ||
          command.operation === 'startLivePreview' ||
          command.operation === 'stopLivePreview' ||
          command.operation === 'retryRecordingCleanup' ||
          command.operation === 'checkAudioStorage' ||
          command.operation === 'setAudioStorageQuota' ||
          command.operation === 'setAudioRetentionDays'
        ) {
          const active = workspace();
          const profile = active.profile;
          const authorize = () => active.assertScope(command.scope);
          authorize();
          const capture = audio();
          if (!closingAudio && !allowClose)
            capture.resumeUploads(active.recordingUploadContext());
          if (command.operation === 'startRecording')
            await capture.start(profile, command.id, command.tracks, authorize);
          else if (command.operation === 'startLivePreview')
            capture.startLive(profile, command.id, command.recording_id, {
              locale: command.locale,
              confirmed: command.confirmed,
              context: active.recordingUploadContext(),
              authorize,
              prepare: async () => {
                await active.synchronize();
                authorize();
              },
            });
          else if (command.operation === 'stopLivePreview')
            capture.stopLive(
              profile,
              command.id,
              command.recording_id,
              authorize,
            );
          else if (command.operation === 'controlRecording')
            await capture.control(
              profile,
              command.id,
              command.recording_id,
              command.action,
              authorize,
            );
          else if (command.operation === 'inspectRecording')
            await capture.inspect(
              profile,
              command.id,
              command.recording_id,
              authorize,
            );
          else if (command.operation === 'recoverRecording')
            await capture.recover(
              profile,
              command.id,
              command.recording_id,
              authorize,
            );
          else if (command.operation === 'removeRecording') {
            await capture.removeSavedAudio(
              profile,
              command.id,
              command.recording_id,
            );
          } else if (command.operation === 'uploadRecording')
            capture.requestUpload(
              profile,
              command.id,
              command.recording_id,
              command.accept_incomplete,
            );
          else if (command.operation === 'pauseRecordingUpload')
            await capture.pauseUpload(
              profile,
              command.id,
              command.recording_id,
            );
          else if (command.operation === 'retryRecordingCleanup')
            await capture.cleanup();
          else if (command.operation === 'setAudioRetentionDays')
            await capture.setRetentionDays(profile, command.days, authorize);
          else if (
            command.operation === 'checkAudioStorage' ||
            command.operation === 'setAudioStorageQuota'
          )
            await capture.checkStorage(
              authorize,
              command.operation === 'setAudioStorageQuota'
                ? command.quota_gib
                : undefined,
            );
          authorize();
          const document =
            command.operation === 'getRecordingState'
              ? command.document_id
              : 'id' in command
                ? command.id
                : null;
          return desktopResponseSchema.parse({
            ok: true,
            audio_state: {
              scope: command.scope,
              state: capture.snapshot(
                profile,
                document,
                command.operation === 'getRecordingState' ? command.offset : 0,
              ),
            },
          });
        }
        if (
          command.operation === 'export' ||
          command.operation === 'exportSummaryReview'
        ) {
          const active = workspace();
          active.assertScope(command.scope);
          const profile = active.profile;
          const draft = db.get(profile, command.id);
          const summary =
            command.operation === 'exportSummaryReview'
              ? await active.summaries.export(command)
              : null;
          const suffix = command.format === 'markdown' ? 'md' : 'txt';
          let name =
            Array.from(
              draft.title
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
                .trim()
                .replace(/[. ]+$/g, ''),
            )
              .slice(0, 100)
              .join('') || 'Meeting';
          if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))
            name = `_${name}`;
          const result = await dialog.showSaveDialog(current, {
            title:
              summary === null
                ? 'Export unencrypted notes'
                : 'Export unencrypted summary draft',
            defaultPath: join(
              app.getPath('documents'),
              `${name}${summary === null ? '' : '-summary'}.${suffix}`,
            ),
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
          active.assertScope(command.scope);
          db.get(profile, command.id);
          if (command.operation === 'exportSummaryReview')
            active.summaries.assertExport(command);
          const temporary = `${result.filePath}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              exportMeeting(
                {
                  ...draft,
                  ...(summary === null
                    ? {}
                    : {
                        title: `${draft.title} - Summary draft`,
                        content: richTextFromPlainText(summary),
                      }),
                  notes: summary ?? richTextToPlainText(draft.content),
                },
                command.format,
              ),
              { flag: 'wx', mode: 0o600, flush: true },
            );
            active.assertScope(command.scope);
            db.get(profile, command.id);
            if (command.operation === 'exportSummaryReview')
              active.summaries.assertExport(command);
            await rename(temporary, result.filePath);
          } finally {
            await rm(temporary, { force: true });
          }
          return { ok: true, state: state(), notice: 'exported' };
        }
        if (
          recordings?.capturing &&
          [
            'connect',
            'activateWorkspace',
            'workOffline',
            'disconnect',
          ].includes(command.operation)
        )
          throw new LocalError(
            'recording_in_progress',
            'Stop recording before changing accounts or workspaces.',
          );
        if (command.operation === 'delete' && recordings?.capturing) {
          workspace().assertScope(command.scope);
          const active = recordings.snapshot(workspace().profile, null).active;
          if (active?.document_id === command.id)
            await recordings.control(
              workspace().profile,
              command.id,
              active.id,
              'stop',
              () => workspace().assertScope(command.scope),
            );
        }
        const result = await workspace().execute(command);
        audioMaintenance();
        return desktopResponseSchema.parse({
          ok: true,
          state: result,
        });
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
    void updates?.close();
    updates = null;
    controller?.dispose();
    delivery?.close();
    controller = null;
    store?.close();
    store = null;
    window = null;
  });
  await current.loadURL(page);
  audioMaintenance();
  const audioTimer = setInterval(audioMaintenance, 30_000);
  audioTimer.unref();
  current.once('closed', () => clearInterval(audioTimer));
  controller?.start();
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
