import { contextBridge, ipcRenderer } from 'electron';
import {
  desktopCommandSchema,
  desktopResponseSchema,
  type DesktopBridge,
} from '@windows-ai-notes/contracts/desktop';

const bridge: DesktopBridge = {
  async invoke(command) {
    const request = desktopCommandSchema.parse(command);
    return desktopResponseSchema.parse(
      await ipcRenderer.invoke('notes:invoke', request),
    );
  },
  onFlush(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value))
        callback(value);
    };
    ipcRenderer.on('notes:flush', listener);
    return () => ipcRenderer.removeListener('notes:flush', listener);
  },
};
contextBridge.exposeInMainWorld('notes', bridge);
