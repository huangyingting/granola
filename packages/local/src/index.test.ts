import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { documentSchema } from '@windows-ai-notes/contracts/server';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import type { Draft } from '@windows-ai-notes/contracts/desktop';
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
    for (const store of stores) store.close();
    stores.clear();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
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
});
