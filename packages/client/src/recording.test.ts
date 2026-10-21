import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@windows-ai-notes/contracts';
import { LocalStore } from '@windows-ai-notes/local';
import { AudioHostClient, AudioHostError } from './audio.js';
import { RecordingController } from './recording.js';
import { ClientError } from './http.js';
import type { RecordingOwner } from '@windows-ai-notes/contracts/recording';

const fixture = fileURLToPath(
  new URL('../fixtures/audio-host.mjs', import.meta.url),
);
describe('durable desktop capture coordination with a real framed helper process', () => {
  let directory: string;
  let local: LocalStore;
  let key: Buffer;
  const clients = new Set<AudioHostClient>();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'notes-capture-'));
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
          !['device_lost', 'audio_protocol_error'].includes(error.code)
        )
          throw error;
      }
    }
    clients.clear();
    local.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  function choices(): Track[] {
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
  function setup(mode = 'capture', remove = vi.fn(async (_id: string) => {})) {
    const observedOwners: (RecordingOwner | null)[] = [];
    const create = vi.fn(
      (observe: ConstructorParameters<typeof AudioHostClient>[2]) => {
        observedOwners.push(local.activeRecordingOwner());
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
    const controller = new RecordingController(local, create, changed, remove);
    return { controller, create, changed, remove, observedOwners };
  }
  it('commits ownership before spawning, reuses the active helper for devices and seals pause/resume/stop acknowledgements', async () => {
    const draft = local.create('offline');
    const { controller, create, observedOwners } = setup();
    await controller.start('offline', draft.id, choices(), () => {});
    expect(create).toHaveBeenCalledTimes(1);
    let active = controller.snapshot('offline', draft.id).active!;
    expect(observedOwners[0]).toEqual({
      profile: 'offline',
      document_id: draft.id,
      recording_id: active.id,
    });
    expect(active.state).toBe('recording');
    expect(active.tracks[0]!.actual_device_id).toBe(
      'synthetic-default-microphone',
    );
    expect(controller.snapshot('unrelated', null).active).toBeNull();
    await controller.listDevices();
    expect(create).toHaveBeenCalledTimes(1);
    await controller.control('offline', draft.id, active.id, 'pause', () => {});
    expect(controller.snapshot('offline', draft.id).active?.state).toBe(
      'paused',
    );
    await controller.control(
      'offline',
      draft.id,
      active.id,
      'resume',
      () => {},
    );
    await controller.stop(() => {});
    const state = controller.snapshot('offline', draft.id);
    expect(state.active).toBeNull();
    expect(state.recordings[0]!.state).toBe('sealed');
    expect(state.recordings[0]!.tracks[0]!.saved_samples).toBe(64000);
    expect(state.error).toBeNull();
    expect(controller.capturing).toBe(false);
    expect(local.activeRecordingOwner()).toBeNull();
  });
  it('fences stale commands without stopping a healthy capture and bounds concurrent operations', async () => {
    const draft = local.create('offline');
    const { controller } = setup();
    const starting = controller.start('offline', draft.id, choices(), () => {});
    await expect(controller.listDevices()).rejects.toThrow(
      'current audio operation',
    );
    await starting;
    const active = controller.snapshot('offline', draft.id).active!;
    await expect(
      controller.control(
        'another-profile',
        draft.id,
        active.id,
        'stop',
        () => {},
      ),
    ).rejects.toThrow('document is no longer available');
    await expect(
      controller.control('offline', draft.id, active.id, 'resume', () => {}),
    ).rejects.toThrow('cannot perform that action');
    expect(controller.snapshot('offline', draft.id).active?.state).toBe(
      'recording',
    );
    await controller.stop(() => {});
  });
  it('never resumes an interrupted capture or starts a helper during recovery discovery', async () => {
    const draft = local.create('offline');
    const initial = local.beginRecording('offline', draft.id, choices());
    const { controller, create } = setup();
    expect(create).not.toHaveBeenCalled();
    expect(local.activeRecordingOwner()).toBeNull();
    expect(
      controller.snapshot('offline', draft.id).recordings[0],
    ).toMatchObject({ id: initial.id, state: 'interrupted' });
    await controller.inspect('offline', draft.id, initial.id, () => {});
    expect(
      controller.snapshot('offline', draft.id).recordings[0],
    ).toMatchObject({ state: 'sealed', inspection: { verified_chunks: 1 } });
    expect(controller.capturing).toBe(false);
  });
  it('stops the subprocess before deleting revoked audio and durably retains failed cleanup for retry', async () => {
    const draft = local.create('cloud-profile');
    const remove = vi.fn(async (_id: string): Promise<void> => {
      expect(controller.capturing).toBe(false);
      throw new Error('Synthetic file removal failure.');
    });
    const { controller } = setup('capture', remove);
    await controller.start('cloud-profile', draft.id, choices(), () => {});
    const id = local.activeRecordingOwner()!.recording_id;
    local.purgeProfile('cloud-profile');
    await expect(controller.reconcile('offline')).rejects.toThrow(
      'file removal failure',
    );
    expect(controller.capturing).toBe(false);
    expect(controller.snapshot('offline', null).active).toBeNull();
    expect(controller.snapshot('offline', null).cleanup_error).not.toBeNull();
    expect(local.pendingRecordingDeletions()).toEqual([id]);
    remove.mockImplementation(async () => {});
    await controller.cleanup();
    expect(local.pendingRecordingDeletions()).toEqual([]);
    expect(controller.snapshot('offline', null).cleanup_error).toBeNull();
  });
  it('rejects stale authorization before starting and closes capture if its authorization changes while awaiting the helper', async () => {
    const draft = local.create('offline');
    const { controller, create, remove } = setup();
    const revoked = new ClientError(
      'workspace_changed',
      'Synthetic workspace transition.',
    );
    await expect(
      controller.start('offline', draft.id, choices(), () => {
        throw revoked;
      }),
    ).rejects.toBe(revoked);
    expect(create).not.toHaveBeenCalled();
    expect(local.recordings('offline', draft.id).recordings).toEqual([]);
    let calls = 0;
    await expect(
      controller.start('offline', draft.id, choices(), () => {
        if (++calls === 2) throw revoked;
      }),
    ).rejects.toBe(revoked);
    expect(controller.capturing).toBe(false);
    expect(local.activeRecordingOwner()).toBeNull();
    expect(local.recordings('offline', draft.id).recordings[0]).toMatchObject({
      state: 'failed',
      error: { code: 'workspace_changed' },
    });
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(['capture-fail', 'capture-fail-immediate'])(
    'surfaces %s without deleting saved audio or claiming a successful stop',
    async (mode) => {
      const draft = local.create('offline');
      const { controller, remove } = setup(mode);
      await controller.start('offline', draft.id, choices(), () => {});
      await vi.waitFor(() => expect(controller.capturing).toBe(false));
      const state = controller.snapshot('offline', draft.id);
      expect(state.recordings[0]).toMatchObject({
        state: 'failed',
        error: { code: 'device_lost' },
      });
      expect(state.error?.code).toBe('device_lost');
      expect(remove).not.toHaveBeenCalled();
      expect(local.pendingRecordingDeletions()).toEqual([]);
    },
  );
  it('rejects substituted track identities and preserves recoverable metadata when capture cannot start', async () => {
    const draft = local.create('offline');
    const { controller } = setup('capture-wrong-track');
    await expect(
      controller.start('offline', draft.id, choices(), () => {}),
    ).rejects.toThrow('capture source');
    expect(controller.capturing).toBe(false);
    expect(controller.snapshot('offline', draft.id).recordings[0]!.state).toBe(
      'failed',
    );
    expect(local.pendingRecordingDeletions()).toEqual([]);
  });
});
