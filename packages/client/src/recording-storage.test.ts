import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_GIB, type Track } from '@windows-ai-notes/contracts';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import { AudioHostClient, AudioHostError } from './audio.js';
import { RecordingController } from './recording.js';

const fixture = fileURLToPath(
  new URL('../fixtures/audio-host.mjs', import.meta.url),
);
describe('Main-owned device-wide native storage capacity', () => {
  let directory: string;
  let key: Buffer;
  let local: LocalStore;
  const clients = new Set<AudioHostClient>();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'notes-storage-'));
    key = randomBytes(32);
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
  });
  afterEach(async () => {
    for (const client of clients) {
      try {
        await client.close();
      } catch (error) {
        if (
          !(error instanceof AudioHostError) ||
          error.code !== 'storage_limit'
        )
          throw error;
      }
    }
    clients.clear();
    local.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  function setup(initial = 'capture-storage') {
    let mode = initial;
    const create = vi.fn(
      (observe: ConstructorParameters<typeof AudioHostClient>[2]) => {
        const client = new AudioHostClient(
          process.execPath,
          [fixture, mode],
          observe,
        );
        clients.add(client);
        return client;
      },
    );
    const changed = vi.fn();
    const remove = vi.fn(async (_id: string) => {});
    const controller = new RecordingController(local, create, changed, remove);
    return {
      controller,
      create,
      changed,
      remove,
      mode: (value: string) => {
        mode = value;
      },
    };
  }
  function tracks(): Track[] {
    return [
      {
        track_id: randomUUID(),
        kind: 'microphone',
        capture_scope: 'endpoint',
        device_selection_policy: 'default',
        device_id: 'default',
      },
    ];
  }
  it('defaults to five GiB without spawning and persists only a confirmed device-wide limit across restart', async () => {
    const { controller, create } = setup();
    expect(controller.snapshot('offline', null)).toMatchObject({
      storage_quota_gib: 5,
      storage: null,
      storage_error: null,
    });
    expect(create).not.toHaveBeenCalled();
    await controller.checkStorage(() => {});
    expect(
      controller.snapshot('offline', null).storage?.capacity,
    ).toMatchObject({
      quota_bytes: 5 * AUDIO_GIB,
      used_bytes: 4096,
      state: 'ready',
      code: null,
    });
    await controller.checkStorage(() => {}, 2);
    expect(local.recordingQuotaGiB()).toBe(2);
    expect(controller.snapshot('another-account', null).storage_quota_gib).toBe(
      2,
    );
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    const restarted = setup();
    expect(restarted.controller.snapshot('offline', null)).toMatchObject({
      storage_quota_gib: 2,
      storage: null,
    });
    await restarted.controller.checkStorage(() => {});
    expect(
      restarted.controller.snapshot('offline', null).storage?.capacity
        .quota_bytes,
    ).toBe(2 * AUDIO_GIB);
  });
  it('seeds the native capture policy and reuses its exclusive helper for capacity checks', async () => {
    local.setRecordingQuotaGiB(2);
    const draft = local.create('offline');
    const { controller, create } = setup();
    await controller.start('offline', draft.id, tracks(), () => {});
    expect(
      controller.snapshot('offline', draft.id).storage?.capacity.quota_bytes,
    ).toBe(2 * AUDIO_GIB);
    await controller.checkStorage(() => {});
    await controller.listDevices();
    expect(create).toHaveBeenCalledTimes(1);
    await expect(controller.checkStorage(() => {}, 1)).rejects.toThrow(
      'Stop capture',
    );
    expect(local.recordingQuotaGiB()).toBe(2);
    expect(controller.capturing).toBe(true);
    await controller.stop(() => {});
  });
  it.each(['devices', 'storage'] as const)(
    'retains a temporary %s helper after a rejected close and refuses replacement until physical exit',
    async (operation) => {
      const { controller, create } = setup();
      const pending =
        operation === 'devices'
          ? controller.listDevices()
          : controller.checkStorage(() => {}, 2);
      const [client] = clients;
      if (!client)
        throw new Error('The framed temporary helper was not created.');
      let stopped = false;
      void client.stopped.then(() => {
        stopped = true;
      });
      const failure = new Error(
        'Synthetic close failure before physical exit.',
      );
      const close = vi.spyOn(client, 'close').mockRejectedValue(failure);
      try {
        await expect(pending).rejects.toBe(failure);
        expect(
          (await client.request({ command: 'list_devices' })).event_type,
        ).toBe('devices');
        expect(stopped).toBe(false);
        expect(controller.snapshot('offline', null)).toMatchObject({
          busy: true,
          storage: null,
          storage_quota_gib: 5,
          error: { code: 'audio_operation_failed' },
        });
        await expect(controller.listDevices()).rejects.toMatchObject({
          code: 'audio_busy',
        });
        await expect(
          controller.checkStorage(() => {}, 2),
        ).rejects.toMatchObject({
          code: 'audio_busy',
        });
        const draft = local.create('offline');
        await expect(
          controller.start('offline', draft.id, tracks(), () => {}),
        ).rejects.toMatchObject({ code: 'audio_busy' });
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(controller.close(() => {})).rejects.toBe(failure);
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
        await client.close();
      }
      await client.stopped;
      expect(stopped).toBe(true);
      expect(controller.snapshot('offline', null).busy).toBe(false);
      await controller.checkStorage(() => {}, 2);
      expect(create).toHaveBeenCalledTimes(2);
      expect(local.recordingQuotaGiB()).toBe(2);
      await controller.close(() => {});
    },
  );
  it('waits for physical temporary-helper closure before confirming the native storage policy', async () => {
    const { controller } = setup();
    let settled = false;
    const pending = controller
      .checkStorage(() => {}, 2)
      .then(() => {
        settled = true;
      });
    const [client] = clients;
    if (!client)
      throw new Error('The framed temporary helper was not created.');
    const close = vi.spyOn(client, 'close').mockResolvedValue(undefined);
    try {
      for (let round = 0; round < 2; round++)
        expect(
          (await client.request({ command: 'list_devices' })).event_type,
        ).toBe('devices');
      expect(close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(local.recordingQuotaGiB()).toBe(5);
      expect(controller.snapshot('offline', null)).toMatchObject({
        busy: true,
        storage: null,
      });
    } finally {
      close.mockRestore();
      await client.close();
      await pending;
    }
    expect(settled).toBe(true);
    expect(local.recordingQuotaGiB()).toBe(2);
    expect(controller.snapshot('offline', null).busy).toBe(false);
    await controller.close(() => {});
  });
  it.each([0, 0.5, 51, Number.POSITIVE_INFINITY])(
    'rejects invalid device limit %s before spawning or changing persistence',
    async (quota) => {
      const { controller, create } = setup();
      await expect(controller.checkStorage(() => {}, quota)).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
      expect(local.recordingQuotaGiB()).toBe(5);
    },
  );
  it('does not persist a policy or accept late capacity after workspace authorization changes', async () => {
    const { controller } = setup('storage-slow');
    let authorized = true;
    const operation = controller.checkStorage(() => {
      if (!authorized)
        throw new LocalError('workspace_changed', 'Workspace changed.');
    }, 2);
    authorized = false;
    await expect(operation).rejects.toThrow('Workspace changed');
    expect(local.recordingQuotaGiB()).toBe(5);
    expect(controller.snapshot('offline', null).storage).toBeNull();
  });
  it('refuses a helper response for a different policy without recording false confirmation', async () => {
    const { controller } = setup('storage-wrong-quota');
    await expect(controller.checkStorage(() => {}, 2)).rejects.toThrow(
      'requested device audio limit',
    );
    expect(local.recordingQuotaGiB()).toBe(5);
    expect(controller.snapshot('offline', null)).toMatchObject({
      storage: null,
      storage_error: { code: 'audio_protocol_error' },
    });
  });
  it('surfaces a failed measurement, clears stale healthy evidence and allows an explicit retry', async () => {
    const configured = setup();
    await configured.controller.checkStorage(() => {});
    configured.mode('storage-error');
    await expect(configured.controller.checkStorage(() => {})).rejects.toThrow(
      'storage_unavailable',
    );
    expect(configured.controller.snapshot('offline', null)).toMatchObject({
      storage: null,
      storage_error: { code: 'storage_unavailable' },
    });
    configured.mode('capture-storage');
    await configured.controller.checkStorage(() => {});
    expect(
      configured.controller.snapshot('offline', null).storage_error,
    ).toBeNull();
  });
  it('keeps metadata and unique audio on a native capacity stop without claiming a seal or triggering cleanup', async () => {
    const draft = local.create('offline');
    const { controller, remove } = setup('capture-storage-fail');
    await controller.start('offline', draft.id, tracks(), () => {});
    await vi.waitFor(() => expect(controller.capturing).toBe(false));
    const state = controller.snapshot('offline', draft.id);
    expect(state.recordings[0]).toMatchObject({
      state: 'failed',
      error: { code: 'storage_limit' },
    });
    expect(state.storage?.capacity).toMatchObject({
      state: 'blocked',
      code: 'storage_limit',
    });
    expect(state.recordings[0]!.audio_retired_at).toBeUndefined();
    expect(local.pendingRecordingDeletions()).toEqual([]);
    expect(local.get('offline', draft.id).id).toBe(draft.id);
    expect(remove).not.toHaveBeenCalled();
  });
});
