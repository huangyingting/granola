import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { documentSchema } from '@windows-ai-notes/contracts/server';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import type { Draft } from '@windows-ai-notes/contracts/desktop';
import type { Track } from '@windows-ai-notes/contracts';
import {
  recordingUploadIntentSchema,
  type LocalRecording,
  type RecordingUploadIntent,
} from '@windows-ai-notes/contracts/recording';
import { LocalStore } from './index.js';

describe('encrypted local drafts and durable outbox', () => {
  let directory: string;
  let path: string;
  let key: Buffer;
  const stores = new Set<LocalStore>();
  const profile = 'synthetic-account';
  const workspace = randomUUID();
  const owner = randomUUID();
  function open(secret = key) {
    const store = new LocalStore(path, secret);
    stores.add(store);
    return store;
  }
  function close(store: LocalStore) {
    store.close();
    stores.delete(store);
  }
  function fields(text: string, title = 'Synthetic meeting') {
    return { title, content: richTextFromPlainText(text), tags: ['Planning'] };
  }
  function tracks(): Track[] {
    return [
      {
        track_id: randomUUID(),
        kind: 'microphone',
        capture_scope: 'endpoint',
        device_selection_policy: 'explicit',
        device_id: 'synthetic-private-microphone',
      },
    ];
  }
  function remote(
    draft: Draft,
    revision = 1,
    overrides: Partial<z.infer<typeof documentSchema>> = {},
  ) {
    return documentSchema.parse({
      id: draft.id,
      workspace_id: workspace,
      owner_id: owner,
      title: draft.title.trim() || 'Untitled meeting',
      notes: richTextToPlainText(draft.content),
      content: draft.content,
      tags: draft.tags,
      revision,
      transcript_revision: 0,
      created_at: draft.created_at,
      updated_at: draft.updated_at,
      ...overrides,
    });
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'windows-notes-local-'));
    path = join(directory, 'notes.sqlite');
    key = randomBytes(32);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.clear();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  function savedUpload(store: LocalStore) {
    const draft = store.create(profile, fields('Private upload journal.'));
    const recording = store.beginRecording(profile, draft.id, tracks());
    store.updateRecording(profile, draft.id, recording.id, { state: 'sealed' });
    const intent = recordingUploadIntentSchema.parse({
      recording_id: recording.id,
      document_id: draft.id,
      state: 'queued',
      verified_chunks: 0,
      total_chunks: 0,
      verified_bytes: 0,
      partial: false,
      attempts: 0,
      retry_at: 0,
      error: null,
      accept_incomplete: false,
      plan: null,
    });
    return { draft, recording, intent };
  }
  function frozen(
    recording: LocalRecording,
    intent: RecordingUploadIntent,
  ): RecordingUploadIntent {
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
    return recordingUploadIntentSchema.parse({
      ...intent,
      total_chunks: 1,
      plan: {
        create: {
          id: recording.id,
          created_at: recording.created_at,
          tracks: recording.tracks.map((track) => ({
            spec: track.spec,
            actual_device_id: track.spec.device_id,
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
  }
  it('persists encrypted scoped upload plans and separate lightweight status across restart without exposing source metadata', () => {
    const store = open();
    const { recording, intent } = savedUpload(store);
    const value = frozen(recording, intent);
    store.saveRecordingUpload(profile, value);
    expect(
      store.recordingUploadStatus(profile, intent.document_id, recording.id),
    ).toEqual(
      expect.not.objectContaining({
        plan: expect.anything(),
        accept_incomplete: expect.anything(),
      }),
    );
    expect(
      JSON.stringify(
        store.recordingUploadStatus(profile, intent.document_id, recording.id),
      ),
    ).not.toContain('synthetic-private-microphone');
    close(store);
    const reopened = open();
    expect(
      reopened.recordingUpload(profile, intent.document_id, recording.id),
    ).toEqual(value);
    expect(reopened.nextRecordingUpload(profile)).toEqual(value);
    expect(reopened.nextRecordingUpload('unrelated-profile')).toBeNull();
    const other = reopened.create(profile);
    expect(() =>
      reopened.recordingUpload(profile, other.id, recording.id),
    ).toThrow('not available in this document');
    for (const file of [path, `${path}-wal`])
      if (existsSync(file))
        expect(
          readFileSync(file).includes(
            Buffer.from('synthetic-private-microphone'),
          ),
        ).toBe(false);
  });
  it('freezes an authenticated plan and refuses invalid counts, source changes and clearing the plan', () => {
    const store = open();
    const { recording, intent } = savedUpload(store);
    const value = frozen(recording, intent);
    store.saveRecordingUpload(profile, value);
    expect(() =>
      store.saveRecordingUpload(profile, { ...value, plan: null }),
    ).toThrow();
    expect(() =>
      store.saveRecordingUpload(profile, {
        ...value,
        plan: {
          ...value.plan!,
          create: { ...value.plan!.create, created_at: '2025-01-01T00:00:00Z' },
        },
      }),
    ).toThrow('frozen recording upload plan');
    expect(() =>
      store.saveRecordingUpload(profile, { ...value, verified_chunks: 2 }),
    ).toThrow();
    expect(
      store.recordingUpload(profile, intent.document_id, recording.id),
    ).toEqual(value);
  });
  it('restores crashed work, orders due retries, and never selects paused, attention or completed uploads', () => {
    const store = open();
    const a = savedUpload(store),
      b = savedUpload(store);
    store.saveRecordingUpload(profile, {
      ...a.intent,
      state: 'waiting',
      retry_at: 3000,
    });
    store.saveRecordingUpload(profile, {
      ...b.intent,
      state: 'uploading',
      retry_at: 1000,
    });
    expect(store.nextRecordingUpload(profile, 999)).toBeNull();
    expect(store.nextRecordingUpload(profile, 1000)?.recording_id).toBe(
      b.recording.id,
    );
    for (const state of ['paused', 'attention', 'complete'] as const) {
      store.saveRecordingUpload(profile, { ...b.intent, state });
      expect(store.nextRecordingUpload(profile, 2999)).toBeNull();
    }
    expect(store.nextRecordingUpload(profile, 3000)?.recording_id).toBe(
      a.recording.id,
    );
    store.saveRecordingUpload(profile, { ...b.intent, state: 'deleting' });
    expect(store.nextRecordingUpload(profile, 0)?.state).toBe('deleting');
  });
  it.each(['state', 'retry_at', 'payload', 'status_payload'] as const)(
    'fails closed on authenticated upload journal tampering of %s',
    (field) => {
      const store = open();
      const { recording, intent } = savedUpload(store);
      store.saveRecordingUpload(profile, frozen(recording, intent));
      const inspect = new DatabaseSync(path);
      try {
        inspect
          .prepare(
            `UPDATE recording_uploads SET ${field}=? WHERE recording_id=?`,
          )
          .run(
            field === 'state'
              ? 'waiting'
              : field === 'retry_at'
                ? 5000
                : new Uint8Array([0]),
            recording.id,
          );
      } finally {
        inspect.close();
      }
      if (field !== 'status_payload')
        expect(() =>
          store.recordingUpload(profile, intent.document_id, recording.id),
        ).toThrow();
      if (field !== 'payload')
        expect(() =>
          store.recordingUploadStatus(
            profile,
            intent.document_id,
            recording.id,
          ),
        ).toThrow();
    },
  );
  it('authenticates plan ownership rather than accepting another recording ciphertext', () => {
    const store = open();
    const a = savedUpload(store),
      b = savedUpload(store);
    store.saveRecordingUpload(profile, frozen(a.recording, a.intent));
    store.saveRecordingUpload(profile, frozen(b.recording, b.intent));
    const inspect = new DatabaseSync(path);
    try {
      inspect
        .prepare(
          'UPDATE recording_uploads SET payload=(SELECT payload FROM recording_uploads WHERE recording_id=?) WHERE recording_id=?',
        )
        .run(a.recording.id, b.recording.id);
    } finally {
      inspect.close();
    }
    expect(() =>
      store.recordingUpload(profile, b.draft.id, b.recording.id),
    ).toThrow('could not be unlocked or verified');
    expect(
      store.recordingUpload(profile, a.draft.id, a.recording.id),
    ).not.toBeNull();
  });
  it('atomically purges upload intents with audio deletion, document deletion and profile revocation', () => {
    const store = open();
    const a = savedUpload(store),
      b = savedUpload(store),
      c = savedUpload(store);
    for (const item of [a, b, c])
      store.saveRecordingUpload(profile, frozen(item.recording, item.intent));
    store.removeRecording(profile, a.draft.id, a.recording.id);
    store.remove(profile, b.draft.id);
    store.purgeProfile(profile);
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        inspect.prepare('SELECT count(*) count FROM recording_uploads').get()
          ?.count,
      ).toBe(0);
    } finally {
      inspect.close();
    }
    expect(store.pendingRecordingDeletions().sort()).toEqual(
      [a.recording.id, b.recording.id, c.recording.id].sort(),
    );
  });
  it.each([2, 3])(
    'upgrades a real v%s table layout without resetting encrypted recordings',
    (version) => {
      const store = open();
      const { recording, draft } = savedUpload(store);
      close(store);
      const inspect = new DatabaseSync(path);
      inspect.exec(
        `DROP TABLE recording_uploads; PRAGMA user_version=${version}`,
      );
      const bytes = inspect
        .prepare('SELECT payload FROM vault WHERE id=?')
        .get(`recording:${recording.id}`)?.payload;
      inspect.close();
      const reopened = open();
      expect(reopened.getRecording(profile, draft.id, recording.id).id).toBe(
        recording.id,
      );
      const after = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          after
            .prepare('SELECT payload FROM vault WHERE id=?')
            .get(`recording:${recording.id}`)?.payload,
        ).toEqual(bytes);
        expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(
          6,
        );
      } finally {
        after.close();
      }
    },
  );
  it('does not recreate an unexpectedly missing current upload journal or reset existing notes', () => {
    const store = open();
    savedUpload(store);
    close(store);
    const inspect = new DatabaseSync(path);
    inspect.exec('DROP TABLE recording_uploads');
    inspect.close();
    expect(() => open()).toThrow('structure is incomplete');
  });
  it.each([4, 5])(
    'upgrades v%s semantics without rewriting encrypted legacy transcript or upload evidence',
    (version) => {
      const store = open();
      const { recording, draft, intent } = savedUpload(store);
      store.saveRecordingUpload(profile, frozen(recording, intent));
      store.applyRemote(profile, remote(draft));
      const transcript = {
        document_id: draft.id,
        revision: 1,
        source: 'manual',
        segments: [
          {
            id: randomUUID(),
            start_ms: 0,
            end_ms: 1,
            text: 'Private cached v4 transcript.',
          },
        ],
      };
      store.putArtifact(profile, draft.id, 'transcript:1', transcript);
      close(store);
      const old = new DatabaseSync(path);
      old.exec(`PRAGMA user_version=${version}`);
      const payloads = old
        .prepare('SELECT profile,id,payload FROM vault ORDER BY profile,id')
        .all();
      old.close();
      const upgraded = open();
      expect(
        upgraded.getArtifact(profile, draft.id, 'transcript:1', z.unknown()),
      ).toEqual(transcript);
      expect(
        upgraded.recordingUpload(profile, draft.id, recording.id)?.plan,
      ).not.toBeNull();
      const inspect = new DatabaseSync(path, { readOnly: true });
      try {
        expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(
          6,
        );
        expect(
          inspect
            .prepare('SELECT profile,id,payload FROM vault ORDER BY profile,id')
            .all(),
        ).toEqual(payloads);
      } finally {
        inspect.close();
      }
    },
  );
  it('durably binds encrypted recording metadata to exactly one document and profile before capture', () => {
    const store = open();
    const draft = store.create('offline', fields('Private offline recording.'));
    const other = store.create('offline', fields('Another document.'));
    const recording = store.beginRecording('offline', draft.id, tracks());
    expect(recording.state).toBe('starting');
    expect(store.activeRecordingOwner()).toEqual({
      profile: 'offline',
      document_id: draft.id,
      recording_id: recording.id,
    });
    expect(() => store.beginRecording('offline', other.id, tracks())).toThrow(
      'Stop the current recording',
    );
    expect(() => store.getRecording(profile, draft.id, recording.id)).toThrow(
      'document is no longer available',
    );
    expect(() => store.getRecording('offline', other.id, recording.id)).toThrow(
      'not available in this document',
    );
    close(store);
    const reopened = open();
    expect(reopened.recordings('offline', draft.id)).toEqual({
      recordings: [recording],
      has_more: false,
    });
    expect(reopened.activeRecordingOwner()?.recording_id).toBe(recording.id);
    for (const file of [path, `${path}-wal`]) {
      if (existsSync(file))
        expect(
          readFileSync(file).includes(
            Buffer.from('synthetic-private-microphone'),
          ),
        ).toBe(false);
    }
    const interrupted = reopened.updateRecording(
      'offline',
      draft.id,
      recording.id,
      {
        state: 'interrupted',
        error: {
          code: 'capture_interrupted',
          message: 'Inspect preserved audio before treating it as complete.',
        },
      },
    );
    expect(interrupted.tracks).toEqual(recording.tracks);
    expect(reopened.activeRecordingOwner()).toBeNull();
    expect(reopened.pendingRecordingDeletions()).toEqual([]);
  });
  it('upgrades v2 vaults without resetting drafts and fences older applications from recording-aware deletion semantics', () => {
    const original = open();
    const draft = original.create('offline', fields('Existing v2 draft.'));
    original.putValue('root', 'synthetic-migration-value', { kept: true });
    close(original);
    const older = new DatabaseSync(path);
    older.exec('PRAGMA user_version=2');
    older.close();
    const upgraded = open();
    expect(upgraded.get('offline', draft.id)).toEqual(draft);
    expect(
      upgraded.getValue(
        'root',
        'synthetic-migration-value',
        z.object({ kept: z.boolean() }),
      ),
    ).toEqual({ kept: true });
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(
        6,
      );
    } finally {
      inspect.close();
    }
  });
  it('pages recording metadata without returning another document or changing historical order on status updates', () => {
    const store = open();
    const draft = store.create('offline');
    const ids: string[] = [];
    for (let index = 0; index < 53; index++) {
      const recording = store.beginRecording('offline', draft.id, tracks());
      ids.push(recording.id);
      store.updateRecording('offline', draft.id, recording.id, {
        state: 'sealed',
      });
    }
    const other = store.create('offline');
    const unrelated = store.beginRecording('offline', other.id, tracks());
    store.updateRecording('offline', other.id, unrelated.id, {
      state: 'sealed',
    });
    store.updateRecording('offline', draft.id, ids[0]!, {
      error: {
        code: 'synthetic_status',
        message: 'Synthetic historical update.',
      },
    });
    const first = store.recordings('offline', draft.id);
    const next = store.recordings('offline', draft.id, 50);
    expect(first.recordings.map((recording) => recording.id)).toEqual(
      ids.slice(3).reverse(),
    );
    expect(first.has_more).toBe(true);
    expect(next.recordings.map((recording) => recording.id)).toEqual(
      ids.slice(0, 3).reverse(),
    );
    expect(next.has_more).toBe(false);
    expect(() => store.recordings('offline', draft.id, -1)).toThrow(
      'supported recording page',
    );
  });
  it('preserves recording identity and monotonically acknowledged saved samples, never reviving terminal capture', () => {
    const store = open();
    const draft = store.create(profile, fields('Capture status.'));
    const recording = store.beginRecording(profile, draft.id, tracks());
    const saved = recording.tracks.map((track) => ({
      ...track,
      actual_device_id: track.spec.device_id,
      saved_samples: 16000,
    }));
    store.updateRecording(profile, draft.id, recording.id, {
      state: 'recording',
      tracks: saved,
    });
    expect(() =>
      store.updateRecording(profile, draft.id, recording.id, {
        tracks: recording.tracks,
      }),
    ).toThrow('saved samples');
    expect(() =>
      store.updateRecording(profile, draft.id, recording.id, {
        tracks: saved.map((track) => ({
          ...track,
          spec: { ...track.spec, track_id: randomUUID() },
        })),
      }),
    ).toThrow('recording identity');
    store.updateRecording(profile, draft.id, recording.id, { state: 'sealed' });
    expect(() =>
      store.updateRecording(profile, draft.id, recording.id, {
        state: 'recording',
      }),
    ).toThrow('active state');
    expect(store.activeRecordingOwner()).toBeNull();
  });
  it.each(['local', 'remote', 'profile'] as const)(
    'journals audio cleanup before %s deletion and retains unrelated recording ownership',
    (mode) => {
      const store = open();
      const draft = store.create(profile, fields('Deleted recording.'));
      store.applyRemote(profile, remote(draft));
      const recording = store.beginRecording(profile, draft.id, tracks());
      store.updateRecording(profile, draft.id, recording.id, {
        state: 'sealed',
      });
      const retained = store.create('offline', fields('Retained recording.'));
      const kept = store.beginRecording('offline', retained.id, tracks());
      if (mode === 'local') store.remove(profile, draft.id);
      else if (mode === 'remote') store.remoteDeleted(profile, draft.id);
      else store.purgeProfile(profile);
      expect(() =>
        store.getRecording(profile, draft.id, recording.id),
      ).toThrow();
      expect(store.pendingRecordingDeletions()).toEqual([recording.id]);
      expect(store.activeRecordingOwner()?.recording_id).toBe(kept.id);
      close(store);
      const reopened = open();
      expect(reopened.pendingRecordingDeletions()).toEqual([recording.id]);
      expect(reopened.getRecording('offline', retained.id, kept.id)).toEqual(
        kept,
      );
      reopened.acknowledgeRecordingDeletion(recording.id);
      reopened.acknowledgeRecordingDeletion(recording.id);
      expect(reopened.pendingRecordingDeletions()).toEqual([]);
    },
  );
  it('rolls back document removal and ownership changes if the durable audio deletion journal cannot be written', () => {
    const store = open();
    const draft = store.create(
      profile,
      fields('Preserved on storage failure.'),
    );
    const recording = store.beginRecording(profile, draft.id, tracks());
    const original = store.putValue.bind(store);
    vi.spyOn(store, 'putValue').mockImplementation((owner, id, value) => {
      if (owner === 'root' && id === 'recording:deletions')
        throw new Error('Synthetic cleanup journal failure.');
      original(owner, id, value);
    });
    expect(() => store.remove(profile, draft.id)).toThrow(
      'cleanup journal failure',
    );
    expect(store.get(profile, draft.id).id).toBe(draft.id);
    expect(store.getRecording(profile, draft.id, recording.id)).toEqual(
      recording,
    );
    expect(store.activeRecordingOwner()?.recording_id).toBe(recording.id);
    expect(store.pendingRecordingDeletions()).toEqual([]);
  });
  it('does not copy or implicitly move private audio when notes are copied into a workspace', () => {
    const store = open();
    const draft = store.create('offline', fields('Copy notes only.'));
    const recording = store.beginRecording('offline', draft.id, tracks());
    store.updateRecording('offline', draft.id, recording.id, {
      state: 'sealed',
    });
    store.copyDrafts('offline', profile, 'all');
    const copy = store.list(profile)[0]!;
    expect(copy.id).not.toBe(draft.id);
    expect(store.recordings(profile, copy.id).recordings).toEqual([]);
    expect(store.getRecording('offline', draft.id, recording.id).state).toBe(
      'sealed',
    );
    expect(() => store.bindOffline(profile)).toThrow('Copy notes explicitly');
    expect(store.getRecording('offline', draft.id, recording.id).state).toBe(
      'sealed',
    );
  });
  it('removes only explicitly selected raw audio while preserving notes and the retryable deletion journal', () => {
    const store = open();
    const draft = store.create('offline', fields('Retain the written notes.'));
    const recording = store.beginRecording('offline', draft.id, tracks());
    store.removeRecording('offline', draft.id, recording.id);
    expect(store.get('offline', draft.id).id).toBe(draft.id);
    expect(store.recordings('offline', draft.id).recordings).toEqual([]);
    expect(store.pendingRecordingDeletions()).toEqual([recording.id]);
    expect(store.activeRecordingOwner()).toBeNull();
  });
  it('pages encrypted summaries without returning full note bodies and reuses unchanged search results', () => {
    const store = open();
    const drafts = Array.from({ length: 57 }, (_, index) =>
      store.create(
        profile,
        fields(`Private body-index-${index}-unique.`, `Meeting ${index}`),
      ),
    );
    const get = vi.spyOn(store, 'get');
    const first = store.page(profile);
    const second = store.page(profile, '', 50);
    expect(first.documents).toHaveLength(50);
    expect(first.has_more).toBe(true);
    expect(second.documents).toHaveLength(7);
    expect(second.has_more).toBe(false);
    expect(
      new Set(
        [...first.documents, ...second.documents].map((draft) => draft.id),
      ).size,
    ).toBe(57);
    expect(first.documents.every((draft) => !('content' in draft))).toBe(true);
    get.mockClear();
    expect(store.page(profile)).toEqual(first);
    expect(get).not.toHaveBeenCalled();
    expect(
      store
        .page(profile, 'BODY-INDEX-56-UNIQUE')
        .documents.map((draft) => draft.id),
    ).toEqual([drafts[56]!.id]);
    get.mockClear();
    expect(store.page(profile, 'BODY-INDEX-56-UNIQUE').documents).toHaveLength(
      1,
    );
    expect(get).not.toHaveBeenCalled();
    store.save(
      profile,
      drafts[0]!.id,
      1,
      fields('body-index-56-unique now matches this edit too.'),
    );
    get.mockClear();
    expect(store.page(profile, 'BODY-INDEX-56-UNIQUE').documents).toHaveLength(
      2,
    );
    expect(get).toHaveBeenCalledTimes(1);
    store.save(
      profile,
      drafts[56]!.id,
      1,
      fields('a'.repeat(300) + ' hidden-search-needle'),
    );
    const hidden = store.page(profile, 'hidden-search-needle');
    expect(hidden.documents.map((draft) => draft.id)).toEqual([drafts[56]!.id]);
    expect(hidden.documents[0]?.preview).toBe('a'.repeat(160));
    expect(() => store.page(profile, '', -1)).toThrow('supported search');
  });
  it('invalidates summary/search caches on rollback, deletion and profile purge without crossing account scopes', () => {
    const store = open();
    const draft = store.create(profile, fields('Original private body.'));
    const before = store.page(profile, 'original');
    expect(() =>
      store.atomic(() => {
        store.save(profile, draft.id, 1, fields('Uncommitted replacement.'));
        expect(store.page(profile, 'uncommitted').documents).toHaveLength(1);
        throw new Error('Synthetic rollback.');
      }),
    ).toThrow('Synthetic rollback');
    expect(store.page(profile, 'original')).toEqual(before);
    store.applyRemote(
      'other-profile',
      remote(draft, 1, {
        notes: 'Another profile private text.',
        content: richTextFromPlainText('Another profile private text.'),
      }),
    );
    expect(store.page('other-profile').documents[0]?.preview).toBe(
      'Another profile private text.',
    );
    expect(store.page(profile).documents[0]?.preview).toBe(
      'Original private body.',
    );
    store.remove(profile, draft.id);
    expect(store.page(profile).documents).toHaveLength(0);
    expect(store.page('other-profile').documents).toHaveLength(1);
    store.purgeProfile('other-profile');
    expect(store.page('other-profile', 'private').documents).toHaveLength(0);
  });
  it('preserves drafts, formatting and credentials across restart without plaintext in SQLite or WAL', () => {
    const title = 'synthetic-private-title-a7b451';
    const text = 'synthetic-private-note-9248b3';
    const token = 'synthetic-refresh-credential-221f80';
    const store = open();
    const draft = store.create(profile, fields(text, title));
    store.putValue(profile, 'refresh', token);
    for (const file of [path, `${path}-wal`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      for (const value of [title, text, token, 'Planning'])
        expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    close(store);
    const restarted = open();
    expect(restarted.get(profile, draft.id)).toEqual(draft);
    expect(restarted.getValue(profile, 'refresh', z.string())).toBe(token);
  });
  it('freezes a retryable request and retains newer typing across its acknowledgement', () => {
    const store = open();
    const original = store.create(profile, fields('First snapshot.'));
    const mutation = store.nextMutation(profile, workspace)!;
    const edited = store.save(
      profile,
      original.id,
      original.local_revision,
      fields('Newer typing.'),
    );
    close(store);
    const restarted = open();
    expect(restarted.nextMutation(profile, workspace)).toEqual(mutation);
    restarted.acknowledge(profile, mutation, remote(original));
    expect(restarted.get(profile, original.id)).toMatchObject({
      local_revision: edited.local_revision,
      status: 'pending',
    });
    expect(
      richTextToPlainText(restarted.get(profile, original.id).content),
    ).toBe('Newer typing.');
    const notes = restarted.nextMutation(profile, workspace)!;
    expect(notes).toMatchObject({
      kind: 'notes',
      body: { base_revision: 1, notes: 'Newer typing.' },
    });
    restarted.acknowledge(
      profile,
      notes,
      remote(edited, 2, { applied_revision: 2 }),
    );
    expect(restarted.get(profile, original.id).status).toBe('synced');
    expect(restarted.nextMutation(profile, workspace)).toBeNull();
  });
  it('submits metadata and notes with sequential server bases without dropping either edit', () => {
    const store = open();
    const source = store.create('fixture', fields('Old note.'));
    store.applyRemote(profile, remote(source));
    const current = store.get(profile, source.id);
    const edited = store.save(
      profile,
      source.id,
      current.local_revision,
      fields('New note.', 'New title'),
    );
    const metadata = store.nextMutation(profile, workspace)!;
    expect(metadata).toMatchObject({
      kind: 'metadata',
      body: { base_revision: 1, title: 'New title' },
    });
    store.acknowledge(
      profile,
      metadata,
      remote(source, 2, { title: 'New title', applied_revision: 2 }),
    );
    expect(store.get(profile, source.id).status).toBe('pending');
    const notes = store.nextMutation(profile, workspace)!;
    expect(notes).toMatchObject({
      kind: 'notes',
      body: { base_revision: 2, notes: 'New note.' },
    });
    store.acknowledge(
      profile,
      notes,
      remote(edited, 3, { applied_revision: 3 }),
    );
    expect(store.get(profile, source.id).status).toBe('synced');
  });
  it('keeps concurrent edits as an explicit conflict and rebases only after a user choice', () => {
    const store = open();
    const source = store.create('fixture', fields('Original.'));
    store.applyRemote(profile, remote(source));
    const current = store.get(profile, source.id);
    store.save(
      profile,
      current.id,
      current.local_revision,
      fields('Local edit.'),
    );
    store.nextMutation(profile, workspace);
    const newer = remote(source, 2, {
      content: richTextFromPlainText('Other device.'),
      notes: 'Other device.',
    });
    store.applyRemote(profile, newer);
    expect(store.get(profile, source.id).status).toBe('conflict');
    expect(richTextToPlainText(store.get(profile, source.id).content)).toBe(
      'Local edit.',
    );
    expect(store.nextMutation(profile, workspace)).toBeNull();
    store.resolve(profile, source.id, 'local');
    expect(store.nextMutation(profile, workspace)).toMatchObject({
      kind: 'notes',
      body: { base_revision: 2, notes: 'Local edit.' },
    });
  });
  it('keeps both versions when resolving a conflict as a new copy', () => {
    const store = open();
    const source = store.create('fixture', fields('Original.'));
    store.applyRemote(profile, remote(source));
    const current = store.get(profile, source.id);
    store.save(
      profile,
      current.id,
      current.local_revision,
      fields('Local edit.'),
    );
    store.applyRemote(
      profile,
      remote(source, 2, {
        content: richTextFromPlainText('Other device.'),
        notes: 'Other device.',
      }),
    );
    const copy = store.resolve(profile, source.id, 'copy')!;
    expect(copy.id).not.toBe(source.id);
    expect(richTextToPlainText(copy.content)).toBe('Local edit.');
    expect(richTextToPlainText(store.get(profile, source.id).content)).toBe(
      'Other device.',
    );
    expect(store.get(profile, source.id).status).toBe('synced');
  });
  it('never recreates a deleted remote ID and requires explicit recovery as a new document', () => {
    const store = open();
    const source = store.create('fixture', fields('Original.'));
    store.applyRemote(profile, remote(source));
    const current = store.get(profile, source.id);
    store.save(
      profile,
      current.id,
      current.local_revision,
      fields('Unsent edit.'),
    );
    store.nextMutation(profile, workspace);
    store.remoteDeleted(profile, source.id);
    expect(store.get(profile, source.id).status).toBe('deleted_remote');
    expect(store.nextMutation(profile, workspace)).toBeNull();
    expect(() => store.resolve(profile, source.id, 'local')).toThrow(
      'only be kept as a new copy',
    );
    const copy = store.resolve(profile, source.id, 'copy')!;
    expect(copy.id).not.toBe(source.id);
    expect(() => store.get(profile, source.id)).toThrow('unavailable');
    expect(store.nextMutation(profile, workspace)).toMatchObject({
      kind: 'create',
      document_id: copy.id,
      body: { id: copy.id },
    });
  });
  it('does not leave an orphan when deletion races an in-flight create', () => {
    const store = open();
    const draft = store.create(profile, fields('Delete during creation.'));
    const create = store.nextMutation(profile, workspace)!;
    store.remove(profile, draft.id);
    expect(store.list(profile)).toHaveLength(0);
    expect(store.nextMutation(profile, workspace)).toEqual(create);
    store.acknowledge(profile, create, remote(draft));
    const deletion = store.nextMutation(profile, workspace)!;
    expect(deletion.kind).toBe('delete');
    store.acknowledge(profile, deletion, null);
    expect(store.nextMutation(profile, workspace)).toBeNull();
  });
  it('rejects stale local writes and invalid acknowledgements while retaining the frozen operation', () => {
    const store = open();
    const draft = store.create(profile, fields('Original.'));
    store.save(profile, draft.id, draft.local_revision, fields('Changed.'));
    expect(() =>
      store.save(profile, draft.id, draft.local_revision, fields('Stale.')),
    ).toThrow('draft changed');
    const operation = store.nextMutation(profile, workspace)!;
    expect(() =>
      store.acknowledge(
        profile,
        operation,
        remote(draft, 1, { applied_revision: 42 }),
      ),
    ).toThrow('does not match');
    expect(store.nextMutation(profile, workspace)).toEqual(operation);
  });
  it('fails closed with a wrong key without replacing or deleting local records', () => {
    const store = open();
    const draft = store.create(
      profile,
      fields('Recoverable only with the original key.'),
    );
    close(store);
    const bytes = readFileSync(path);
    expect(() => new LocalStore(path, randomBytes(32))).toThrow('not reset');
    expect(readFileSync(path)).toEqual(bytes);
    expect(open().get(profile, draft.id)).toEqual(draft);
  });
  it('authenticates entity identity, profile, and synchronization metadata', () => {
    const store = open();
    const first = store.create(profile, fields('First.'));
    const second = store.create(profile, fields('Second.'));
    const raw = new DatabaseSync(path);
    try {
      raw
        .prepare(
          'UPDATE drafts SET payload=(SELECT payload FROM drafts WHERE id=?) WHERE id=?',
        )
        .run(first.id, second.id);
      expect(() => store.get(profile, second.id)).toThrow('not reset');
      expect(store.get(profile, first.id)).toEqual(first);
      raw
        .prepare('UPDATE drafts SET remote_revision=99 WHERE id=?')
        .run(first.id);
      expect(() => store.get(profile, first.id)).toThrow('not reset');
      expect(
        raw.prepare('SELECT count(*) count FROM drafts').get()?.count,
      ).toBe(2);
      store.putValue('a:b', 'c', 'first secret');
      store.putValue('a', 'b:c', 'second secret');
      raw
        .prepare(
          "UPDATE vault SET payload=(SELECT payload FROM vault WHERE profile='a:b' AND id='c') WHERE profile='a' AND id='b:c'",
        )
        .run();
      expect(() => store.getValue('a', 'b:c', z.string())).toThrow('not reset');
    } finally {
      raw.close();
    }
  });
  it('isolates accounts and explicitly binds offline drafts without changing their IDs', () => {
    const store = open();
    const offline = store.create('offline', fields('Offline.'));
    const other = store.create('other-account', fields('Other account.'));
    store.putValue(profile, 'refresh', 'synthetic credential');
    store.bindOffline(profile);
    expect(store.list('offline')).toHaveLength(0);
    expect(store.get(profile, offline.id).content).toEqual(offline.content);
    expect(() => store.get(profile, other.id)).toThrow('unavailable');
    store.purgeProfile(profile);
    expect(store.list(profile)).toHaveLength(0);
    expect(store.getValue(profile, 'refresh', z.string())).toBeNull();
    expect(store.get('other-account', other.id)).toEqual(other);
  });
  it('upgrades the released v1 vault without losing drafts, credentials or frozen retries', () => {
    const store = open();
    const draft = store.create(
      profile,
      fields('An upgrade must preserve this.'),
    );
    const mutation = store.nextMutation(profile, workspace);
    close(store);
    const legacy = new DatabaseSync(path);
    function legacySeal(value: unknown, ...context: string[]) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(
        Buffer.from(JSON.stringify(['windows-ai-notes-local', 1, ...context])),
      );
      return Buffer.concat([
        Buffer.from([1]),
        nonce,
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    }
    try {
      legacy.exec(`ALTER TABLE vault RENAME TO vault_v2;
        CREATE TABLE vault(profile TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(profile,id));
        DROP TABLE vault_v2; DROP TABLE snapshot_candidates; PRAGMA user_version=1;`);
      const insert = legacy.prepare('INSERT INTO vault VALUES(?,?,?)');
      insert.run(
        'root',
        'key-check',
        legacySeal('windows-ai-notes-local-v1', 'vault', 'root', 'key-check'),
      );
      insert.run(
        profile,
        'refresh',
        legacySeal('synthetic-v1-refresh', 'vault', profile, 'refresh'),
      );
    } finally {
      legacy.close();
    }
    const upgraded = open();
    expect(upgraded.get(profile, draft.id)).toEqual(draft);
    expect(upgraded.nextMutation(profile, workspace)).toEqual(mutation);
    expect(upgraded.getValue(profile, 'refresh', z.string())).toBe(
      'synthetic-v1-refresh',
    );
    close(upgraded);
    const restarted = open();
    expect(restarted.getValue(profile, 'refresh', z.string())).toBe(
      'synthetic-v1-refresh',
    );
    expect(restarted.nextMutation(profile, workspace)).toEqual(mutation);
  });
  it('durably reconciles only the snapshot baseline, preserving new own creates and unsent edits', () => {
    let store = open();
    const sources = ['Seen.', 'Deleted.', 'Unsent edit.'].map((text) =>
      store.create('fixtures', fields(text)),
    );
    for (const source of sources) store.applyRemote(profile, remote(source));
    const [seen, removed, edited] = sources as [Draft, Draft, Draft];
    store.putArtifact(profile, removed.id, 'transcript:1', {
      text: 'Private removed evidence.',
    });
    const editing = store.get(profile, edited.id);
    store.save(
      profile,
      edited.id,
      editing.local_revision,
      fields('Preserve unsent typing.'),
    );
    const progress = store.beginSnapshot(profile).bootstrap!;
    store.acceptSnapshot(profile, progress, {
      documents: [remote(seen)],
      cursor: 'synthetic_cursor_1',
      has_more: true,
      next_after: seen.id,
    });
    close(store);
    store = open();
    const own = store.create(
      'fixtures',
      fields('Created after the snapshot began.'),
    );
    store.applyRemote(profile, remote(own));
    store.acceptSnapshot(profile, store.syncCheckpoint(profile).bootstrap!, {
      documents: [],
      cursor: 'synthetic_cursor_1',
      has_more: false,
      next_after: null,
    });
    expect(store.get(profile, seen.id).status).toBe('synced');
    expect(() => store.get(profile, removed.id)).toThrow('unavailable');
    expect(store.get(profile, edited.id).status).toBe('deleted_remote');
    expect(richTextToPlainText(store.get(profile, edited.id).content)).toBe(
      'Preserve unsent typing.',
    );
    expect(store.get(profile, own.id).status).toBe('synced');
    expect(
      store.getArtifact(profile, removed.id, 'transcript:1', z.unknown()),
    ).toBeNull();
    expect(store.syncCheckpoint(profile)).toEqual({
      cursor: 'synthetic_cursor_1',
      bootstrap: null,
    });
  });
  it('rolls back snapshot documents, artifacts and progress together on invalid input', () => {
    const store = open();
    const old = store.create('fixtures', fields('Baseline.'));
    const incoming = store.create('fixtures', fields('Incoming.'));
    store.applyRemote(profile, remote(old));
    const progress = store.beginSnapshot(profile).bootstrap!;
    const page = {
      documents: [remote(incoming)],
      cursor: 'synthetic_cursor_2',
      has_more: false,
      next_after: null,
    };
    expect(() =>
      store.acceptSnapshot(profile, progress, page, [
        { document_id: old.id, id: 'misassociated', value: 'not this page' },
      ]),
    ).toThrow('another page');
    expect(store.syncCheckpoint(profile).bootstrap).toEqual(progress);
    expect(store.get(profile, old.id).status).toBe('synced');
    expect(() => store.get(profile, incoming.id)).toThrow('unavailable');
    store.acceptSnapshot(profile, progress, page);
    expect(store.get(profile, incoming.id).status).toBe('synced');
    expect(() => store.get(profile, old.id)).toThrow('unavailable');
  });
  it('commits changed artifacts and the cursor atomically and rejects late callbacks after purge', () => {
    const store = open();
    const source = store.create('fixtures', fields('Current.'));
    const progress = store.beginSnapshot(profile).bootstrap!;
    store.acceptSnapshot(profile, progress, {
      documents: [remote(source)],
      cursor: 'cursor_10',
      has_more: false,
      next_after: null,
    });
    const changed = remote(source, 2, { title: 'New title' });
    expect(() =>
      store.acceptChanges(profile, 'cursor_10', 'cursor_11', [
        {
          id: source.id,
          document: changed,
          artifacts: [{ id: 'job:1', value: 'private artifact' }],
        },
        { id: randomUUID(), document: changed, artifacts: [] },
      ]),
    ).toThrow('identifier');
    expect(store.get(profile, source.id).title).toBe(source.title);
    expect(
      store.getArtifact(profile, source.id, 'job:1', z.string()),
    ).toBeNull();
    expect(store.syncCheckpoint(profile).cursor).toBe('cursor_10');
    store.acceptChanges(profile, 'cursor_10', 'cursor_11', [
      {
        id: source.id,
        document: changed,
        artifacts: [{ id: 'job:1', value: 'private artifact' }],
      },
    ]);
    expect(store.getArtifact(profile, source.id, 'job:1', z.string())).toBe(
      'private artifact',
    );
    store.purgeProfile(profile);
    expect(() =>
      store.acceptChanges(profile, 'cursor_11', 'cursor_12', [
        { id: source.id, document: changed, artifacts: [] },
      ]),
    ).toThrow('no longer active');
    expect(() =>
      store.putArtifact(profile, source.id, 'job:late', 'late private data'),
    ).toThrow('no longer available');
    expect(store.list(profile)).toHaveLength(0);
  });
  it('deletes only the exact literal artifact prefix in its document and profile', () => {
    const store = open(),
      source = store.create('fixtures', fields('Original.')),
      other = store.create('fixtures', fields('Other.'));
    store.applyRemote(profile, remote(source));
    store.applyRemote(profile, remote(other));
    store.applyRemote('another-account', remote(source));
    store.putArtifact(
      profile,
      source.id,
      'chat-thread:%_:source',
      'Remove only this private source.',
    );
    store.putArtifact(
      profile,
      source.id,
      'chat-thread:other:source',
      'Keep another thread.',
    );
    store.putArtifact(
      profile,
      source.id,
      'summary-source:1',
      'Keep the summary.',
    );
    store.putArtifact(
      profile,
      other.id,
      'chat-thread:%_:source',
      'Keep another document.',
    );
    store.putArtifact(
      'another-account',
      source.id,
      'chat-thread:%_:source',
      'Keep another account.',
    );
    store.deleteArtifactPrefix(profile, source.id, 'chat-thread:%_:');
    expect(
      store.getArtifact(
        profile,
        source.id,
        'chat-thread:%_:source',
        z.string(),
      ),
    ).toBeNull();
    expect(
      store.getArtifact(
        profile,
        source.id,
        'chat-thread:other:source',
        z.string(),
      ),
    ).toBe('Keep another thread.');
    expect(
      store.getArtifact(profile, source.id, 'summary-source:1', z.string()),
    ).toBe('Keep the summary.');
    expect(
      store.getArtifact(profile, other.id, 'chat-thread:%_:source', z.string()),
    ).toBe('Keep another document.');
    expect(
      store.getArtifact(
        'another-account',
        source.id,
        'chat-thread:%_:source',
        z.string(),
      ),
    ).toBe('Keep another account.');
    expect(() => store.deleteArtifactPrefix(profile, source.id, '')).toThrow();
  });
  it('removes artifacts on remote deletion even when local recovery keeps the draft', () => {
    const store = open();
    const source = store.create('fixtures', fields('Original.'));
    store.applyRemote(profile, remote(source));
    store.putArtifact(profile, source.id, 'transcript:1', {
      text: 'Synthetic old transcript.',
    });
    const current = store.get(profile, source.id);
    store.save(
      profile,
      source.id,
      current.local_revision,
      fields('Local recovery.'),
    );
    store.remoteDeleted(profile, source.id);
    expect(store.get(profile, source.id).status).toBe('deleted_remote');
    expect(
      store.getArtifact(profile, source.id, 'transcript:1', z.unknown()),
    ).toBeNull();
    expect(() =>
      store.putArtifact(profile, source.id, 'transcript:2', 'late callback'),
    ).toThrow('no longer available');
  });
  it('does not strand an explicitly deleted draft when a newer remote edit arrives during a pull', () => {
    const store = open();
    const source = store.create('fixtures', fields('Original.'));
    store.applyRemote(profile, remote(source));
    store.remove(profile, source.id);
    store.applyRemote(
      profile,
      remote(source, 2, { title: 'Newer remote title' }),
    );
    expect(store.list(profile)).toHaveLength(0);
    const mutation = store.nextMutation(profile, workspace)!;
    expect(mutation.kind).toBe('delete');
    store.acknowledge(profile, mutation, null);
    expect(store.nextMutation(profile, workspace)).toBeNull();
  });
});
