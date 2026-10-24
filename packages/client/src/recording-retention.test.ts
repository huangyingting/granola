import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '@windows-ai-notes/local';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { recordingUploadIntentSchema } from '@windows-ai-notes/contracts/recording';
import { recordingRetentionSchema } from '@windows-ai-notes/contracts/uploads';
import { ApiClient, ClientError } from './http.js';
import { RecordingController } from './recording.js';
import { AudioHostClient } from './audio.js';
import { uploadSavedRecording } from './recording-upload.js';

describe('Main-owned local audio retention', () => {
  let directory: string;
  let key: Buffer;
  let local: LocalStore;
  const profile = 'synthetic-cloud-account';
  const create = vi.fn(() => {
    throw new Error('Retention must not spawn a capture helper.');
  });
  const remove = vi.fn(async (_id: string) => {});
  const changed = vi.fn();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'notes-local-retention-'));
    key = randomBytes(32);
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    create.mockClear();
    remove.mockReset().mockResolvedValue(undefined);
    changed.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    local.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  function saved() {
    const document = local.create(profile);
    const recording = local.beginRecording(profile, document.id, [
      {
        track_id: randomUUID(),
        kind: 'microphone',
        capture_scope: 'endpoint',
        device_selection_policy: 'explicit',
        device_id: 'synthetic-source',
      },
    ]);
    local.updateRecording(profile, document.id, recording.id, {
      state: 'sealed',
    });
    const chunk = {
      chunk: {
        format_version: 1,
        recording_id: recording.id,
        track_id: recording.tracks[0]!.spec.track_id,
        chunk_id: randomUUID(),
        capture_epoch: randomUUID(),
        sequence: 0,
        sample_start: 0,
        sample_count: 16000,
        sample_rate: 16000,
        channels: 1,
        bits_per_sample: 16,
        clock_start_ms: 0,
        clock_end_ms: 1000,
        pcm_sha256: 'a'.repeat(64),
      },
      size_bytes: 32044,
      sha256: 'b'.repeat(64),
    };
    const intent = recordingUploadIntentSchema.parse({
      recording_id: recording.id,
      document_id: document.id,
      state: 'complete',
      verified_chunks: 1,
      total_chunks: 1,
      verified_bytes: 32044,
      partial: false,
      attempts: 1,
      retry_at: 0,
      error: null,
      accept_incomplete: false,
      plan: {
        create: {
          id: recording.id,
          created_at: recording.created_at,
          tracks: recording.tracks.map((track) => ({
            spec: track.spec,
            actual_device_id: 'synthetic-source',
          })),
        },
        chunks: [chunk],
        seal: {
          native_state: 'sealed',
          accept_incomplete: false,
          tracks: [
            {
              track_id: chunk.chunk.track_id,
              end_sample: 16000,
              chunk_ids: [chunk.chunk.chunk_id],
            },
          ],
          events: [],
          gaps: [],
        },
      },
    });
    local.saveRecordingUpload(profile, intent);
    const status = recordingRetentionSchema.parse({
      id: recording.id,
      document_id: document.id,
      state: 'retained',
      canonical_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      retention_days: 7,
      deletion: null,
    });
    const api = new ApiClient('https://notes.example.test', async () => ({
      Authorization: 'Bearer synthetic-test-only',
    }));
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (_path, schema) => schema.parse(status));
    const reads = new Set<AbortController>();
    const context = { api, profile, scope: 1, authorize: () => {}, reads };
    const controller = new RecordingController(local, create, changed, remove);
    return {
      document,
      recording,
      intent,
      status,
      api,
      request,
      context,
      reads,
      controller,
    };
  }
  async function idle(reads: Set<AbortController>) {
    await vi.waitFor(() => expect(reads.size).toBe(0));
  }
  it.each(['inspect', 'recover'] as const)(
    'rejects %s at the authenticated local deadline before the expiry sweep runs',
    async (operation) => {
      const c = saved();
      local.rememberRecordingRetention(profile, c.api.base, {
        ...c.status,
        retention_days: 0,
      });
      expect(
        local.getRecording(profile, c.document.id, c.recording.id)
          .audio_retired_at,
      ).toBeUndefined();
      await expect(
        c.controller[operation](
          profile,
          c.document.id,
          c.recording.id,
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'local_audio_retired' });
      expect(create).not.toHaveBeenCalled();
      expect(c.request).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(local.pendingRecordingDeletions()).toEqual([]);
      expect(
        local.recordingUpload(profile, c.document.id, c.recording.id),
      ).toEqual(c.intent);
    },
  );
  it('refuses explicit reupload at the local deadline without starting native work or changing its cloud receipt', () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, {
      ...c.status,
      retention_days: 0,
    });
    for (let i = 0; i < 4; i++) c.reads.add(new AbortController());
    c.controller.resumeUploads(c.context);
    expect(() =>
      c.controller.requestUpload(profile, c.document.id, c.recording.id, false),
    ).toThrow('retention deadline');
    expect(create).not.toHaveBeenCalled();
    expect(c.request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(
      local.recordingUpload(profile, c.document.id, c.recording.id),
    ).toEqual(c.intent);
  });
  it('projects logical expiry beyond the fifty-item sweep without mutating cleanup state or hiding cloud metadata', () => {
    const cases: ReturnType<typeof saved>[] = [];
    local.atomic(() => {
      for (let i = 0; i < 51; i++) {
        const c = saved();
        local.rememberRecordingRetention(profile, c.api.base, {
          ...c.status,
          retention_days: 0,
        });
        cases.push(c);
      }
    });
    expect(local.expireRecordingRetention()).toBe(50);
    const remaining = cases.find((c) =>
      local.recordingRetention(profile, c.document.id, c.recording.id),
    );
    if (!remaining) throw new Error('The bounded sweep left no pending proof.');
    const proof = local.recordingRetention(
      profile,
      remaining.document.id,
      remaining.recording.id,
    )!;
    const sweep = vi.spyOn(local, 'expireRecordingRetention');
    const snapshot = remaining.controller.snapshot(
      profile,
      remaining.document.id,
    );
    expect(snapshot.recordings[0]?.audio_retired_at).toBe(
      new Date(proof.delete_after).toISOString(),
    );
    expect(snapshot.uploads[0]?.state).toBe('complete');
    expect(
      local.getRecording(profile, remaining.document.id, remaining.recording.id)
        .audio_retired_at,
    ).toBeUndefined();
    expect(
      local.recordingUpload(
        profile,
        remaining.document.id,
        remaining.recording.id,
      ),
    ).toEqual(remaining.intent);
    expect(local.pendingRecordingDeletions()).toHaveLength(50);
    expect(sweep).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('fences a real native inspection acknowledgement when its deadline passes before completion', async () => {
    const c = saved();
    const proof = local.rememberRecordingRetention(
      profile,
      c.api.base,
      c.status,
    )!;
    const before = local.getRecording(profile, c.document.id, c.recording.id);
    const client = new AudioHostClient(
      process.execPath,
      [
        fileURLToPath(new URL('../fixtures/audio-host.mjs', import.meta.url)),
        'inspection-slow',
        JSON.stringify(c.recording.tracks[0]!.spec),
      ],
      () => {},
    );
    const controller = new RecordingController(
      local,
      () => client,
      changed,
      remove,
    );
    const inspecting = controller.inspect(
      profile,
      c.document.id,
      c.recording.id,
      () => {},
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(proof.delete_after);
    try {
      await expect(inspecting).rejects.toMatchObject({
        code: 'local_audio_retired',
      });
      expect(
        local.getRecording(profile, c.document.id, c.recording.id),
      ).toEqual(before);
      expect(
        local.recordingUpload(profile, c.document.id, c.recording.id),
      ).toEqual(c.intent);
      expect(local.pendingRecordingDeletions()).toEqual([]);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      await client.close();
      await controller.close(() => {});
    }
  });
  it('closes a real due review beyond the current sweep batch before processing independent cleanup', async () => {
    const cases: ReturnType<typeof saved>[] = [];
    local.atomic(() => {
      for (let i = 0; i < 51; i++) {
        const c = saved();
        local.rememberRecordingRetention(profile, c.api.base, c.status);
        cases.push(c);
      }
    });
    const c = cases
      .sort(
        (a, b) =>
          Date.parse(a.status.canonical_at!) -
            Date.parse(b.status.canonical_at!) ||
          a.recording.id.localeCompare(b.recording.id),
      )
      .at(-1)!;
    const proof = local.recordingRetention(
      profile,
      c.document.id,
      c.recording.id,
    )!;
    const client = new AudioHostClient(
      process.execPath,
      [
        fileURLToPath(new URL('../fixtures/audio-host.mjs', import.meta.url)),
        'inspection-slow',
        JSON.stringify(c.recording.tracks[0]!.spec),
      ],
      () => {},
    );
    let physicallyStopped = false;
    void client.stopped.then(() => {
      physicallyStopped = true;
    });
    remove.mockImplementation(async () => {
      expect(physicallyStopped).toBe(true);
    });
    const controller = new RecordingController(
      local,
      () => client,
      changed,
      remove,
    );
    const inspecting = controller
      .inspect(profile, c.document.id, c.recording.id, () => {})
      .catch((error: unknown) => error);
    const now = vi.spyOn(Date, 'now').mockReturnValue(proof.delete_after);
    const sweep = vi.spyOn(local, 'expireRecordingRetention');
    try {
      await controller.reconcile(profile);
      await expect(inspecting).resolves.toMatchObject({
        code: 'recording_review_cancelled',
      });
      expect(physicallyStopped).toBe(true);
      expect(sweep).toHaveReturnedWith(50);
      expect(remove).toHaveBeenCalledTimes(50);
      expect(remove).not.toHaveBeenCalledWith(c.recording.id);
      expect(
        local.getRecording(profile, c.document.id, c.recording.id)
          .audio_retired_at,
      ).toBeUndefined();
      expect(
        local.recordingRetention(profile, c.document.id, c.recording.id),
      ).toEqual(proof);
      expect(local.pendingRecordingDeletions()).toEqual([]);
      expect(
        controller.snapshot(profile, c.document.id).recordings[0]
          ?.audio_retired_at,
      ).toBe(new Date(proof.delete_after).toISOString());
    } finally {
      now.mockRestore();
      await client.close();
      await controller.close(() => {});
    }
  });
  it('does not spawn a native uploader for expired audio even with an older queued intent', async () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, {
      ...c.status,
      retention_days: 0,
    });
    const queued = recordingUploadIntentSchema.parse({
      ...c.intent,
      state: 'queued',
      plan: null,
      total_chunks: 0,
      verified_chunks: 0,
      verified_bytes: 0,
    });
    await expect(
      uploadSavedRecording({
        local,
        profile,
        intent: queued,
        native: create,
        api: c.api,
        check: () => {},
        signal: new AbortController().signal,
        changed,
      }),
    ).rejects.toMatchObject({ code: 'local_audio_retired' });
    expect(create).not.toHaveBeenCalled();
    expect(c.request).not.toHaveBeenCalled();
    expect(
      local.recordingUpload(profile, c.document.id, c.recording.id),
    ).toEqual(c.intent);
  });
  it('checks the deadline after a real native upload inspection before accepting its plan', async () => {
    const c = saved();
    const proof = local.rememberRecordingRetention(
      profile,
      c.api.base,
      c.status,
    )!;
    const queued = recordingUploadIntentSchema.parse({
      ...c.intent,
      state: 'queued',
      plan: null,
      total_chunks: 0,
      verified_chunks: 0,
      verified_bytes: 0,
    });
    const client = new AudioHostClient(
      process.execPath,
      [
        fileURLToPath(new URL('../fixtures/audio-host.mjs', import.meta.url)),
        'inspection-slow',
        JSON.stringify(c.recording.tracks[0]!.spec),
      ],
      () => {},
    );
    const request = vi.spyOn(client, 'request');
    const uploading = uploadSavedRecording({
      local,
      profile,
      intent: queued,
      native: () => client,
      api: c.api,
      check: () => {},
      signal: new AbortController().signal,
      changed,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(proof.delete_after);
    try {
      await expect(uploading).rejects.toMatchObject({
        code: 'local_audio_retired',
      });
      expect(request.mock.calls.map(([value]) => value.command)).toEqual([
        'inspect_recording',
      ]);
      expect(c.request).not.toHaveBeenCalled();
      expect(
        local.recordingUpload(profile, c.document.id, c.recording.id),
      ).toEqual(c.intent);
    } finally {
      now.mockRestore();
      await client.close();
      await client.stopped;
    }
  });
  it('still reconciles an immutable cloud receipt after local logical expiry without reading native audio', async () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, {
      ...c.status,
      retention_days: 0,
    });
    const plan = c.intent.plan!;
    c.request.mockImplementation(async (_path, schema) =>
      schema.parse({
        ...plan.create,
        document_id: c.document.id,
        state: 'ready',
        partial: plan.seal.accept_incomplete,
        seal_sha256: createHash('sha256')
          .update(canonicalJson(plan.seal))
          .digest('hex'),
        chunk_count: plan.chunks.length,
        verified_chunks: plan.chunks.length,
      }),
    );
    const readAudio = vi.spyOn(local, 'getRecordingForAudio');
    await uploadSavedRecording({
      local,
      profile,
      intent: c.intent,
      native: create,
      api: c.api,
      check: () => {},
      signal: new AbortController().signal,
      changed,
    });
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(readAudio).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(
      local.recordingUpload(profile, c.document.id, c.recording.id),
    ).toEqual(c.intent);
    expect(local.pendingRecordingDeletions()).toEqual([]);
  });
  it('waits for a cancelled retention read to settle before shutdown returns', async () => {
    const c = saved();
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    c.request.mockImplementation(async (_path, schema, options) => {
      signal = options?.signal;
      await pending;
      return schema.parse(c.status);
    });
    const remember = vi.spyOn(local, 'rememberRecordingRetention');
    c.controller.resumeUploads(c.context);
    let stopped = false;
    const stopping = c.controller
      .close(() => {})
      .then(() => {
        stopped = true;
      });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(c.reads.size).toBe(0);
    expect(remember).not.toHaveBeenCalled();
  });
  it('reads authorized metadata only, caches a bounded deadline and deletes only local audio offline after restart', async () => {
    const c = saved();
    c.controller.resumeUploads(c.context);
    await idle(c.reads);
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(c.request.mock.calls[0]?.[0]).toBe(
      `/v1/recordings/${c.recording.id}/retention`,
    );
    expect(c.request.mock.calls[0]?.[2]).not.toHaveProperty('method');
    expect(c.controller.snapshot(profile, c.document.id).retention).toEqual([
      {
        recording_id: c.recording.id,
        document_id: c.document.id,
        canonical_at: c.status.canonical_at,
        delete_after: Date.parse(c.status.canonical_at!) + 7 * 86_400_000,
      },
    ]);
    c.controller.resumeUploads(null);
    local.setRecordingRetentionDays(profile, 0);
    const unique = local.beginRecording(profile, c.document.id, [
      c.recording.tracks[0]!.spec,
    ]);
    local.updateRecording(profile, c.document.id, unique.id, {
      state: 'interrupted',
    });
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    const restarted = new RecordingController(local, create, changed, remove);
    await restarted.reconcile('offline');
    expect(remove.mock.calls).toEqual([[c.recording.id]]);
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(local.pendingRecordingDeletions()).toEqual([]);
    expect(local.get(profile, c.document.id).id).toBe(c.document.id);
    expect(local.getRecording(profile, c.document.id, unique.id).id).toBe(
      unique.id,
    );
  });
  it('persists native cleanup failure for retry, without restoring deleted input or requiring a remote DELETE', async () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, c.status);
    local.setRecordingRetentionDays(profile, 0);
    remove.mockRejectedValueOnce(new Error('Synthetic locked file.'));
    await expect(c.controller.reconcile(profile)).rejects.toThrow(
      'locked file',
    );
    expect(c.controller.snapshot(profile, c.document.id)).toMatchObject({
      pending_deletions: 1,
      cleanup_error: { code: 'recording_cleanup_failed' },
    });
    expect(local.pendingRecordingDeletions()).toEqual([c.recording.id]);
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    const restarted = new RecordingController(local, create, changed, remove);
    await restarted.reconcile('offline');
    expect(local.pendingRecordingDeletions()).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(c.request).not.toHaveBeenCalled();
  });
  it('closes a real in-flight native inspection before expiring its files and fences the late acknowledgement', async () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, c.status);
    const client = new AudioHostClient(
      process.execPath,
      [
        fileURLToPath(new URL('../fixtures/audio-host.mjs', import.meta.url)),
        'inspection-slow',
        JSON.stringify(c.recording.tracks[0]!.spec),
      ],
      () => {},
    );
    let closed = false;
    const close = client.close.bind(client);
    vi.spyOn(client, 'close').mockImplementation(async () => {
      await close();
      closed = true;
    });
    const removal = vi.fn(async () => {
      expect(closed).toBe(true);
    });
    const controller = new RecordingController(
      local,
      () => client,
      changed,
      removal,
    );
    try {
      const inspecting = controller.inspect(
        profile,
        c.document.id,
        c.recording.id,
        () => {},
      );
      const rejected = expect(inspecting).rejects.toMatchObject({
        code: 'recording_review_cancelled',
      });
      local.setRecordingRetentionDays(profile, 0);
      await controller.reconcile(profile);
      await rejected;
      expect(removal).toHaveBeenCalledWith(c.recording.id);
      expect(local.pendingRecordingDeletions()).toEqual([]);
      expect(local.recordings(profile, c.document.id).recordings).toMatchObject(
        [
          {
            id: c.recording.id,
            audio_retired_at: expect.any(String),
            inspection: null,
          },
        ],
      );
      expect(
        local.recordingUpload(profile, c.document.id, c.recording.id),
      ).toEqual(c.intent);
      await expect(
        controller.inspect(profile, c.document.id, c.recording.id, () => {}),
      ).rejects.toMatchObject({ code: 'local_audio_retired' });
    } finally {
      await client.close();
    }
  });
  it('keeps cloud deletion control and immutable paid-request input after native expiry without respawning or reuploading', async () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, c.status);
    local.setRecordingRetentionDays(profile, 0);
    await c.controller.reconcile(profile);
    expect(
      local.recordingUpload(profile, c.document.id, c.recording.id),
    ).toEqual(c.intent);
    await c.controller.removeSavedAudio(profile, c.document.id, c.recording.id);
    expect(
      local.recordingUpload(profile, c.document.id, c.recording.id),
    ).toMatchObject({
      state: 'delete_pending',
      plan: c.intent.plan,
    });
    expect(c.request).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(
      local.recordingRetentionCandidates(profile, null).recordings,
    ).toEqual([]);
  });
  it('does not let one unavailable recording starve confirmation of another eligible recording', async () => {
    const a = saved(),
      b = saved();
    a.request.mockImplementation(async (path, schema) => {
      if (path.includes(a.recording.id))
        throw new ClientError(
          'recording_not_found',
          'Synthetic missing source.',
          404,
        );
      return schema.parse(b.status);
    });
    a.controller.resumeUploads(a.context);
    await idle(a.reads);
    expect(a.request).toHaveBeenCalledTimes(2);
    expect(
      local.recordingRetention(profile, b.document.id, b.recording.id),
    ).not.toBeNull();
    expect(
      local.recordingRetention(profile, a.document.id, a.recording.id),
    ).toBeNull();
    expect(
      a.controller.snapshot(profile, b.document.id).retention_error,
    ).not.toBeNull();
    a.controller.resumeUploads(null);
  });
  it.each(['scope', 'revocation', 'stop'])(
    'fences a late response after %s without recaching proof or restoring input',
    async (transition) => {
      const c = saved();
      let finish!: (value: typeof c.status) => void;
      const pending = new Promise<typeof c.status>((resolve) => {
        finish = resolve;
      });
      c.request.mockImplementation(async (_path, schema) =>
        schema.parse(await pending),
      );
      c.controller.resumeUploads(c.context);
      expect(c.reads.size).toBe(1);
      if (transition === 'scope')
        c.controller.resumeUploads({ ...c.context, scope: 2 });
      if (transition === 'revocation') local.remove(profile, c.document.id);
      if (transition === 'stop') await c.controller.stop(() => {});
      finish(c.status);
      await idle(c.reads);
      if (transition !== 'revocation')
        expect(
          local.recordingRetention(profile, c.document.id, c.recording.id),
        ).toBeNull();
      else
        expect(() =>
          local.getRecording(profile, c.document.id, c.recording.id),
        ).toThrow();
      expect(remove).not.toHaveBeenCalled();
      c.controller.resumeUploads(null);
    },
  );
  it('shares the four-read budget and does not infer confirmation from an incomplete upload or a candidate transcript', async () => {
    const c = saved();
    for (let i = 0; i < 4; i++) c.reads.add(new AbortController());
    c.controller.resumeUploads(c.context);
    expect(c.request).not.toHaveBeenCalled();
    c.reads.clear();
    c.request.mockImplementation(async (_path, schema) =>
      schema.parse({ ...c.status, canonical_at: null }),
    );
    c.controller.resumeUploads(c.context);
    await idle(c.reads);
    expect(
      local.recordingRetention(profile, c.document.id, c.recording.id),
    ).toBeNull();
    local.saveRecordingUpload(profile, {
      ...c.intent,
      verified_chunks: 0,
      verified_bytes: 0,
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    c.controller.resumeUploads(c.context);
    await idle(c.reads);
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(local.expireRecordingRetention(Date.now() + 40 * 86_400_000)).toBe(
      0,
    );
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['binding', 'unavailable'])(
    'reports %s confirmation failures, preserves audio and retries without paid work',
    async (kind) => {
      const c = saved();
      if (kind === 'binding')
        c.request.mockImplementation(async (_path, schema) =>
          schema.parse({ ...c.status, id: randomUUID() }),
        );
      else
        c.request.mockRejectedValue(
          new ClientError(
            'service_unavailable',
            'Synthetic metadata outage.',
            503,
            true,
          ),
        );
      c.controller.resumeUploads(c.context);
      await idle(c.reads);
      expect(
        c.controller.snapshot(profile, c.document.id).retention_error?.code,
      ).toBe('audio_retention_confirmation_failed');
      expect(
        local.recordingRetention(profile, c.document.id, c.recording.id),
      ).toBeNull();
      expect(local.pendingRecordingDeletions()).toEqual([]);
      expect(create).not.toHaveBeenCalled();
      c.request.mockImplementation(async (_path, schema) =>
        schema.parse(c.status),
      );
      const clock = vi.spyOn(Date, 'now');
      clock.mockReturnValue(Date.now() + 120_000);
      c.controller.resumeUploads(c.context);
      await idle(c.reads);
      clock.mockReturnValue(Date.now() + 120_000);
      c.controller.resumeUploads(c.context);
      await idle(c.reads);
      clock.mockReturnValue(Date.now() + 120_000);
      c.controller.resumeUploads(c.context);
      await idle(c.reads);
      expect(
        local.recordingRetention(profile, c.document.id, c.recording.id),
      ).not.toBeNull();
      expect(
        c.controller.snapshot(profile, c.document.id).retention_error,
      ).toBeNull();
      expect(remove).not.toHaveBeenCalled();
      c.controller.resumeUploads(null);
    },
  );
  it('scopes preference changes, rejects stale commands before mutation and does not extend old deadlines', async () => {
    const c = saved();
    local.rememberRecordingRetention(profile, c.api.base, c.status);
    await expect(
      c.controller.setRetentionDays(profile, 0, () => {
        throw new ClientError('workspace_changed', 'Stale scope.');
      }),
    ).rejects.toThrow('Stale scope');
    expect(local.recordingRetentionDays(profile)).toBe(7);
    await c.controller.setRetentionDays(profile, 2, () => {});
    await c.controller.setRetentionDays(profile, 7, () => {});
    expect(
      c.controller.snapshot(profile, c.document.id).retention[0]?.delete_after,
    ).toBe(Date.parse(c.status.canonical_at!) + 2 * 86_400_000);
    expect(c.controller.snapshot('offline', null).retention_days).toBe(7);
  });
});
