import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desktopCommandSchema,
  desktopResponseSchema,
} from '@windows-ai-notes/contracts/desktop';
import {
  audioStateSchema,
  livePreviewSchema,
} from '@windows-ai-notes/contracts/recording';

const directory = process.env.NOTES_LIVE_UI_FIXTURE;
if (!directory) throw new Error('Missing isolated live UI fixture directory.');
app.setPath('userData', directory);
async function start() {
  const fixture = JSON.parse(
    await readFile(join(directory, 'fixture.json'), 'utf8'),
  );
  let audio = audioStateSchema.parse(fixture.audio);
  const initialLive = livePreviewSchema.parse(fixture.live);
  const commands = [];
  let version = 1;
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1400,
    height: 1000,
    webPreferences: {
      preload: fileURLToPath(
        new URL('../../dist/preload.cjs', import.meta.url),
      ),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const changed = () =>
    window.webContents.send('notes:changed', {
      kind: 'audio',
      scope: 7,
      version: version++,
    });
  ipcMain.on('fixture:audio', (_event, value) => {
    audio = audioStateSchema.parse(value);
    changed();
  });
  ipcMain.on('fixture:commands', (result) => {
    result.commands = structuredClone(commands);
  });
  ipcMain.handle('notes:invoke', (event, value) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('Unexpected UI fixture sender.');
    const command = desktopCommandSchema.parse(value);
    if (!('scope' in command) || command.scope !== 7)
      return {
        ok: false,
        error: { code: 'workspace_changed', message: 'Stale fixture scope.' },
      };
    if (command.operation === 'getRecordingState') {
      return desktopResponseSchema.parse({
        ok: true,
        audio_state: {
          scope: 7,
          state: { ...audio, document_id: command.document_id },
        },
      });
    }
    if (
      !('id' in command) ||
      command.id !== audio.active?.document_id ||
      !('recording_id' in command) ||
      command.recording_id !== audio.active.id
    )
      throw new Error('Unexpected UI fixture recording.');
    commands.push(command);
    if (command.operation === 'startLivePreview') {
      audio.live = { ...structuredClone(initialLive), locale: command.locale };
    } else if (command.operation === 'stopLivePreview') {
      audio.live = livePreviewSchema.parse({
        ...audio.live,
        running: false,
        phase: 'stopped',
      });
    } else if (command.operation === 'controlRecording') {
      audio.active.state =
        command.action === 'pause'
          ? 'paused'
          : command.action === 'resume'
            ? 'recording'
            : 'sealed';
      if (audio.live)
        audio.live = { ...audio.live, running: false, phase: 'stopped' };
    } else
      throw new Error(`Unexpected UI fixture command: ${command.operation}`);
    changed();
    return desktopResponseSchema.parse({
      ok: true,
      audio_state: { scope: 7, state: audio },
    });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(join(directory, 'index.html'), {
    query: { document: audio.active.document_id },
  });
  app.on('window-all-closed', () => app.quit());
}
// Playwright releases app readiness only after evaluating the entry module.
void start().catch((error) => {
  console.error(error);
  app.exit(1);
});
