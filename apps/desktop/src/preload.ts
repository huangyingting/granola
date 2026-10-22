import { contextBridge, ipcRenderer } from 'electron';
import {
  desktopCommandSchema,
  desktopResponseSchema,
  desktopChangeSchema,
  type DesktopBridge,
} from '@windows-ai-notes/contracts/desktop';
import {
  desktopUpdateCommandSchema,
  desktopUpdateResponseSchema,
  desktopUpdateStateSchema,
} from '@windows-ai-notes/contracts/updates';

const bridge: DesktopBridge = {
  async invoke(command) {
    const request = desktopCommandSchema.parse(command);
    return desktopResponseSchema.parse(
      await ipcRenderer.invoke('notes:invoke', request),
    );
  },
  async invokeUpdate(command) {
    return desktopUpdateResponseSchema.parse(
      await ipcRenderer.invoke(
        'notes:update',
        desktopUpdateCommandSchema.parse(command),
      ),
    );
  },
  onUpdateState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
      callback(desktopUpdateStateSchema.parse(value));
    ipcRenderer.on('notes:update-state', listener);
    return () => ipcRenderer.removeListener('notes:update-state', listener);
  },
  onFlush(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value))
        callback(value);
    };
    ipcRenderer.on('notes:flush', listener);
    return () => ipcRenderer.removeListener('notes:flush', listener);
  },
  onChanged(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
      callback(desktopChangeSchema.parse(value));
    ipcRenderer.on('notes:changed', listener);
    return () => ipcRenderer.removeListener('notes:changed', listener);
  },
};
contextBridge.exposeInMainWorld('notes', bridge);
