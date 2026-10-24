import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@windows-ai-notes/contracts';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
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
  function setup(
    mode = 'capture',
    remove = vi.fn(async (_id: string) => {}),
    arguments_: string[] = [],
  ) {
    const observedOwners: (RecordingOwner | null)[] = [];
    const create = vi.fn(
      (observe: ConstructorParameters<typeof AudioHostClient>[2]) => {
        observedOwners.push(local.activeRecordingOwner());
        const client = new AudioHostClient(
          process.execPath,
          [fixture, mode, ...arguments_],
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
    await expect(
      controller.recover('offline', draft.id, active.id, () => {}),
    ).rejects.toThrow('Stop capture');
    expect(controller.capturing).toBe(true);
    await controller.stop(() => {});
  });
  it('retains capture ownership after a failed close until the real helper physically exits', async () => {
    const draft = local.create('offline');
    const { controller, create } = setup();
    await controller.start('offline', draft.id, choices(), () => {});
    const [client] = clients;
    if (!client) throw new Error('The framed capture helper was not created.');
    let stopped = false;
    void client.stopped.then(() => {
      stopped = true;
    });
    const failure = new Error('Synthetic close failure before physical exit.');
    const close = vi.spyOn(client, 'close').mockRejectedValue(failure);
    try {
      await expect(controller.stop(() => {})).rejects.toBe(failure);
      expect(
        (await client.request({ command: 'list_devices' })).event_type,
      ).toBe('devices');
      expect(stopped).toBe(false);
      expect(controller.capturing).toBe(true);
      const snapshot = controller.snapshot('offline', draft.id);
      expect(snapshot.active?.state).toBe('failed');
      expect(snapshot.levels).toBeNull();
      expect(snapshot.error?.code).toBe('audio_operation_failed');
      await expect(
        controller.start('offline', draft.id, choices(), () => {}),
      ).rejects.toThrow('Stop the current recording');
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      await client.close();
    }
    await client.stopped;
    expect(stopped).toBe(true);
    expect(controller.capturing).toBe(false);
    await controller.start('offline', draft.id, choices(), () => {});
    expect(create).toHaveBeenCalledTimes(2);
    await controller.close(() => {});
  });
  it('keeps repeated audio deletion attempts fenced while physical helper closure is unconfirmed', async () => {
    const draft = local.create('offline');
    const { controller, remove } = setup();
    await controller.start('offline', draft.id, choices(), () => {});
    const recording = controller.snapshot('offline', draft.id).active!;
    const [client] = clients;
    if (!client) throw new Error('The framed capture helper was not created.');
    const failure = new Error('Synthetic close failure before physical exit.');
    const close = vi.spyOn(client, 'close').mockRejectedValue(failure);
    local.remove('offline', draft.id);
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(controller.cleanup()).rejects.toBe(failure);
      expect(remove).not.toHaveBeenCalled();
      expect(local.pendingRecordingDeletions()).toEqual([recording.id]);
      expect(controller.capturing).toBe(true);
      expect(
        (await client.request({ command: 'list_devices' })).event_type,
      ).toBe('devices');
    } finally {
      close.mockRestore();
      await client.close();
    }
    await client.stopped;
    await controller.cleanup();
    expect(remove).toHaveBeenCalledExactlyOnceWith(recording.id);
    expect(local.pendingRecordingDeletions()).toEqual([]);
    expect(controller.capturing).toBe(false);
    await controller.close(() => {});
  });
  it.each(['inspect', 'recover'] as const)(
    'retains the %s helper after a failed close until physical exit permits another operation',
    async (operation) => {
      const profile = 'offline',
        draft = local.create(profile),
        tracks = choices();
      const recording = local.beginRecording(profile, draft.id, tracks);
      const { controller, create } = setup(
        operation === 'inspect' ? 'inspection' : 'recovery',
        undefined,
        [JSON.stringify(tracks[0])],
      );
      const pending = controller[operation](
        profile,
        draft.id,
        recording.id,
        () => {},
      );
      const [client] = clients;
      if (!client) throw new Error('The framed review helper was not created.');
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
        expect(controller.snapshot(profile, draft.id).busy).toBe(true);
        for (const next of ['inspect', 'recover'] as const)
          await expect(
            controller[next](profile, draft.id, recording.id, () => {}),
          ).rejects.toMatchObject({ code: 'audio_busy' });
        await expect(
          controller.start(profile, draft.id, choices(), () => {}),
        ).rejects.toMatchObject({ code: 'audio_busy' });
        await expect(controller.listDevices()).rejects.toMatchObject({
          code: 'audio_busy',
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(controller.snapshot(profile, draft.id).error?.code).toBe(
          'audio_operation_failed',
        );
      } finally {
        close.mockRestore();
        await client.close();
      }
      await client.stopped;
      expect(stopped).toBe(true);
      expect(controller.snapshot(profile, draft.id).busy).toBe(false);
      await controller[operation](profile, draft.id, recording.id, () => {});
      expect(create).toHaveBeenCalledTimes(2);
      await controller.close(() => {});
    },
  );
  it.each(['inspect', 'recover'] as const)(
    'preserves the deletion journal until the %s helper physically exits after a failed close',
    async (operation) => {
      const profile = 'offline',
        draft = local.create(profile),
        tracks = choices();
      const recording = local.beginRecording(profile, draft.id, tracks);
      const { controller, remove } = setup(
        operation === 'inspect' ? 'inspection' : 'recovery',
        undefined,
        [JSON.stringify(tracks[0])],
      );
      const pending = controller[operation](
        profile,
        draft.id,
        recording.id,
        () => {},
      );
      const [client] = clients;
      if (!client) throw new Error('The framed review helper was not created.');
      const failure = new Error(
        'Synthetic close failure before physical exit.',
      );
      const close = vi.spyOn(client, 'close').mockRejectedValue(failure);
      try {
        await expect(pending).rejects.toBe(failure);
        local.remove(profile, draft.id);
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(controller.cleanup()).rejects.toBe(failure);
        expect(remove).not.toHaveBeenCalled();
        expect(local.pendingRecordingDeletions()).toEqual([recording.id]);
        expect(
          (await client.request({ command: 'list_devices' })).event_type,
        ).toBe('devices');
      } finally {
        close.mockRestore();
        await client.close();
      }
      await client.stopped;
      await controller.cleanup();
      expect(remove).toHaveBeenCalledExactlyOnceWith(recording.id);
      expect(local.pendingRecordingDeletions()).toEqual([]);
      await controller.close(() => {});
    },
  );
  it('keeps framed level previews ephemeral, profile-scoped and separate from saved audio across pause/resume', async () => {
    const draft = local.create('offline');
    const { controller } = setup('capture-levels');
    const tracks: Track[] = [
      ...choices(),
      {
        track_id: randomUUID(),
        kind: 'loopback',
        capture_scope: 'endpoint',
        device_selection_policy: 'explicit',
        device_id: 'synthetic-output',
      },
    ];
    await controller.start('offline', draft.id, tracks, () => {});
    const before = local.getRecording(
      'offline',
      draft.id,
      local.activeRecordingOwner()!.recording_id,
    );
    const update = vi.spyOn(local, 'updateRecording');
    await vi.waitFor(() =>
      expect(
        controller.snapshot('offline', draft.id).levels?.capture.tracks[0]
          ?.level,
      ).toMatchObject({ peak: 0.5, rms: 0.25, samples: 800 }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(
      controller
        .snapshot('offline', draft.id)
        .levels!.capture.tracks.map((track) => track.track_id),
    ).toEqual(tracks.map((track) => track.track_id));
    expect(local.getRecording('offline', draft.id, before.id)).toEqual(before);
    expect(controller.snapshot('unrelated', null).levels).toBeNull();
    const epoch = controller.snapshot('offline', null).levels!.capture
      .capture_epoch;
    await controller.control('offline', draft.id, before.id, 'pause', () => {});
    expect(controller.snapshot('offline', null).levels).toBeNull();
    await controller.control(
      'offline',
      draft.id,
      before.id,
      'resume',
      () => {},
    );
    await vi.waitFor(() =>
      expect(controller.snapshot('offline', null).levels).not.toBeNull(),
    );
    expect(
      controller.snapshot('offline', null).levels!.capture.capture_epoch,
    ).not.toBe(epoch);
    await controller.stop(() => {});
    expect(controller.snapshot('offline', null).levels).toBeNull();
    const restarted = setup();
    expect(
      restarted.controller.snapshot('offline', draft.id).levels,
    ).toBeNull();
    expect(restarted.create).not.toHaveBeenCalled();
  });
  it.each(['track', 'clock', 'epoch', 'reading'])(
    'rejects inconsistent %s level evidence rather than displaying a healthy signal',
    async (mode) => {
      const draft = local.create('offline');
      const { controller } = setup(`capture-level-bad-${mode}`);
      await controller.start('offline', draft.id, choices(), () => {});
      await vi.waitFor(() => expect(controller.capturing).toBe(false));
      const snapshot = controller.snapshot('offline', draft.id);
      expect(snapshot.levels).toBeNull();
      expect(snapshot.recordings[0]!.state).toBe('failed');
      expect(snapshot.error?.code).toBe('audio_protocol_error');
    },
  );
  it('releases a paused helper after its unsolicited automatic-stop acknowledgement', async () => {
    const draft = local.create('offline');
    const { controller, remove } = setup('capture-auto-stop-paused');
    await controller.start('offline', draft.id, choices(), () => {});
    const active = controller.snapshot('offline', draft.id).active!;
    await controller.control('offline', draft.id, active.id, 'pause', () => {});
    await vi.waitFor(() => expect(controller.capturing).toBe(false));
    const state = controller.snapshot('offline', draft.id);
    expect(state.recordings[0]!.state).toBe('sealed');
    expect(state.error).toBeNull();
    expect(local.activeRecordingOwner()).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
  it('never resumes an interrupted capture or starts a helper during recovery discovery', async () => {
    const draft = local.create('offline');
    const initial = local.beginRecording('offline', draft.id, choices());
    const { controller, create } = setup('capture', undefined, [
      JSON.stringify(initial.tracks[0]!.spec),
    ]);
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
  it.each([
    'inspection-wrong-track',
    'inspection-wrong-source',
    'inspection-bad-count',
    'inspection-lost-acknowledgement',
  ])(
    'does not mark inconsistent native evidence complete after %s',
    async (mode) => {
      const draft = local.create('offline');
      const tracks = choices();
      const initial = local.beginRecording('offline', draft.id, tracks);
      if (mode === 'inspection-lost-acknowledgement')
        local.updateRecording('offline', draft.id, initial.id, {
          tracks: initial.tracks.map((track) => ({
            ...track,
            saved_samples: 32000,
          })),
        });
      const { controller } = setup(mode, undefined, [
        JSON.stringify(tracks[0]),
      ]);
      const before = local.getRecording('offline', draft.id, initial.id);
      await expect(
        controller.inspect('offline', draft.id, initial.id, () => {}),
      ).rejects.toMatchObject({ code: 'audio_protocol_error' });
      expect(local.getRecording('offline', draft.id, initial.id)).toEqual(
        before,
      );
    },
  );
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
  it('drains physical cleanup before shutdown can close its encrypted journal', async () => {
    const draft = local.create('offline');
    const recording = local.beginRecording('offline', draft.id, choices());
    local.updateRecording('offline', draft.id, recording.id, {
      state: 'sealed',
    });
    local.removeRecording('offline', draft.id, recording.id);
    let finish!: () => void;
    const removal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { controller } = setup(
      'capture',
      vi.fn(() => removal),
    );
    const cleanup = controller.cleanup();
    const closed = vi.fn();
    const stopping = controller.stop(() => {}).then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    finish();
    await Promise.all([cleanup, stopping]);
    expect(closed).toHaveBeenCalledOnce();
    expect(local.pendingRecordingDeletions()).toEqual([]);
  });
  it('recovers acknowledged per-track metadata without resuming capture or claiming a sealed tail', async () => {
    const draft = local.create('offline');
    const tracks = choices();
    const initial = local.beginRecording('offline', draft.id, tracks);
    const { controller, create, remove } = setup('recovery', undefined, [
      JSON.stringify(tracks[0]),
    ]);
    await controller.recover('offline', draft.id, initial.id, () => {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(local.getRecording('offline', draft.id, initial.id)).toMatchObject({
      state: 'interrupted',
      tracks: [
        {
          spec: tracks[0],
          actual_device_id: 'synthetic-default-microphone',
          saved_samples: 32000,
        },
      ],
      inspection: {
        state: 'interrupted',
        verified_chunks: 2,
        recovered_chunks: 0,
      },
    });
    expect(controller.capturing).toBe(false);
    expect(local.activeRecordingOwner()).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(controller.snapshot('offline', draft.id).error).toBeNull();
  });
  it.each([
    'recovery-wrong-track',
    'recovery-wrong-source',
    'recovery-bad-count',
    'recovery-claims-sealed',
  ])('rejects inconsistent recovery metadata from %s', async (mode) => {
    const draft = local.create('offline');
    const tracks = choices();
    const initial = local.beginRecording('offline', draft.id, tracks);
    const { controller, remove } = setup(mode, undefined, [
      JSON.stringify(tracks[0]),
    ]);
    const before = local.getRecording('offline', draft.id, initial.id);
    await expect(
      controller.recover('offline', draft.id, initial.id, () => {}),
    ).rejects.toMatchObject({ code: 'audio_protocol_error' });
    expect(local.getRecording('offline', draft.id, initial.id)).toEqual(before);
    expect(remove).not.toHaveBeenCalled();
    expect(controller.capturing).toBe(false);
  });
  it('closes an in-flight recovery before physically deleting revoked audio and never recreates its association', async () => {
    const draft = local.create('cloud-profile');
    const tracks = choices();
    const initial = local.beginRecording('cloud-profile', draft.id, tracks);
    let closed = false;
    const remove = vi.fn(async (_id: string) => {
      expect(closed).toBe(true);
    });
    const { controller, create } = setup('recovery-slow', remove, [
      JSON.stringify(tracks[0]),
    ]);
    const recovering = controller.recover(
      'cloud-profile',
      draft.id,
      initial.id,
      () => {},
    );
    const rejected = expect(recovering).rejects.toMatchObject({
      code: 'recording_review_cancelled',
    });
    const client = create.mock.results[0]!.value;
    const close = client.close.bind(client);
    vi.spyOn(client, 'close').mockImplementation(async () => {
      await close();
      closed = true;
    });
    local.purgeProfile('cloud-profile');
    await controller.reconcile('offline');
    await rejected;
    expect(remove).toHaveBeenCalledWith(initial.id);
    expect(local.pendingRecordingDeletions()).toEqual([]);
    expect(() =>
      local.getRecording('cloud-profile', draft.id, initial.id),
    ).toThrow('no longer available');
    expect(controller.capturing).toBe(false);
  });
  it('fences recovery completion after a scope change and stops temporary helpers on window closure', async () => {
    const draft = local.create('offline');
    const tracks = choices();
    const initial = local.beginRecording('offline', draft.id, tracks);
    const { controller, remove } = setup('recovery-slow', undefined, [
      JSON.stringify(tracks[0]),
    ]);
    const revoked = new ClientError(
      'workspace_changed',
      'Synthetic recovery scope transition.',
    );
    let valid = true;
    const recovering = controller.recover(
      'offline',
      draft.id,
      initial.id,
      () => {
        if (!valid) throw revoked;
      },
    );
    const rejected = expect(recovering).rejects.toBe(revoked);
    valid = false;
    await controller.stop(() => {});
    await rejected;
    expect(local.getRecording('offline', draft.id, initial.id).tracks).toEqual(
      initial.tracks,
    );
    expect(remove).not.toHaveBeenCalled();
  });
  it('rejects stale recovery authorization before spawning a helper', async () => {
    const draft = local.create('offline');
    const initial = local.beginRecording('offline', draft.id, choices());
    const { controller, create } = setup();
    const revoked = new ClientError(
      'workspace_changed',
      'Synthetic stale recovery.',
    );
    await expect(
      controller.recover('offline', draft.id, initial.id, () => {
        throw revoked;
      }),
    ).rejects.toBe(revoked);
    expect(create).not.toHaveBeenCalled();
    expect(
      local.getRecording('offline', draft.id, initial.id).inspection,
    ).toBeNull();
  });
  it('closes recovery and rejects maintenance asynchronously when recording ownership cannot be authenticated', async () => {
    const draft = local.create('offline');
    const tracks = choices();
    const initial = local.beginRecording('offline', draft.id, tracks);
    const { controller, remove } = setup('recovery-slow', undefined, [
      JSON.stringify(tracks[0]),
    ]);
    const recovering = controller.recover(
      'offline',
      draft.id,
      initial.id,
      () => {},
    );
    const rejected = expect(recovering).rejects.toMatchObject({
      code: 'recording_review_cancelled',
    });
    const failure = new LocalError(
      'local_data_corrupt',
      'Synthetic unauthenticated recording ownership.',
    );
    const read = vi.spyOn(local, 'getRecording').mockImplementation(() => {
      throw failure;
    });
    try {
      const maintenance = controller.reconcile('offline');
      await expect(maintenance).rejects.toBe(failure);
      await rejected;
      expect(controller.snapshot('offline', null).error?.code).toBe(
        'local_data_corrupt',
      );
      expect(remove).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
  it('stops capture if ownership cannot be verified and rejects maintenance asynchronously without blocking workspace notifications', async () => {
    const draft = local.create('offline');
    const { controller, remove } = setup();
    await controller.start('offline', draft.id, choices(), () => {});
    const failure = new LocalError(
      'local_data_corrupt',
      'Synthetic recording ownership could not be verified.',
    );
    const read = vi.spyOn(local, 'getRecording').mockImplementation(() => {
      throw failure;
    });
    try {
      const maintenance = controller.reconcile('offline');
      await expect(maintenance).rejects.toBe(failure);
      expect(controller.capturing).toBe(false);
      expect(controller.snapshot('offline', null).error?.code).toBe(
        'local_data_corrupt',
      );
      expect(remove).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
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
