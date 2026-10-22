import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '@windows-ai-notes/contracts/desktop';
import { desktopUpdateStateSchema } from '@windows-ai-notes/contracts/updates';

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, value: DesktopBridge) => void>(),
  invoke: vi.fn<(channel: string, value: unknown) => Promise<unknown>>(),
  on: vi.fn<
    (
      channel: string,
      listener: (event: unknown, value: unknown) => void,
    ) => void
  >(),
  remove: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.remove,
  },
}));
import './preload.js';

const bridge = electron.expose.mock.calls[0]![1];
const state = desktopUpdateStateSchema.parse({
  version: 1,
  revision: 3,
  installed_version: '0.1.0',
  phase: 'idle',
  available_version: null,
  download_bytes: null,
  can_check: true,
  can_download: false,
  can_cancel: false,
  installation_enabled: false,
  cache: null,
  error: null,
});
afterEach(() => {
  electron.invoke.mockReset();
  electron.on.mockClear();
  electron.remove.mockClear();
});
describe('isolated desktop update bridge', () => {
  it('exposes only the explicit note and update bridge methods', () => {
    expect(Object.keys(bridge).sort()).toEqual([
      'invoke',
      'invokeUpdate',
      'onChanged',
      'onFlush',
      'onUpdateState',
    ]);
  });
  it('forwards a validated action to its own channel and validates the response', async () => {
    electron.invoke.mockResolvedValue({ ok: true, state });
    expect(await bridge.invokeUpdate({ operation: 'check' })).toEqual({
      ok: true,
      state,
    });
    expect(electron.invoke).toHaveBeenCalledWith('notes:update', {
      operation: 'check',
    });
    electron.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'update_busy', message: 'An update is already running.' },
    });
    expect(await bridge.invokeUpdate({ operation: 'download' })).toMatchObject({
      ok: false,
      error: { code: 'update_busy' },
    });
  });
  it('rejects renderer-supplied update authority before IPC', async () => {
    await expect(
      bridge.invokeUpdate({
        operation: 'download',
        path: 'C:\\Synthetic\\setup.exe',
      } as never),
    ).rejects.toThrow();
    await expect(
      bridge.invokeUpdate({ operation: 'install' } as never),
    ).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it('rejects success-shaped responses with paths or an enabled installer', async () => {
    for (const extra of [
      { installer: 'C:\\Synthetic\\setup.exe' },
      { installation_enabled: true },
      { revision: -1 },
    ]) {
      electron.invoke.mockResolvedValue({
        ok: true,
        state: { ...state, ...extra },
      });
      await expect(
        bridge.invokeUpdate({ operation: 'getState' }),
      ).rejects.toThrow();
    }
  });
  it('validates pushed state and unsubscribes the exact event listener', () => {
    const observe = vi.fn();
    const stop = bridge.onUpdateState(observe);
    const [channel, listener] = electron.on.mock.calls[0]!;
    expect(channel).toBe('notes:update-state');
    listener(undefined, state);
    expect(observe).toHaveBeenCalledWith(state);
    expect(() =>
      listener(undefined, { ...state, certificate_sha256: 'ab'.repeat(32) }),
    ).toThrow();
    expect(observe).toHaveBeenCalledTimes(1);
    stop();
    expect(electron.remove).toHaveBeenCalledWith(channel, listener);
  });
});
