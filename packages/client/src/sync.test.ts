import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createServer } from '@windows-ai-notes/api/server';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import { z } from 'zod';
import { ApiClient, ClientError } from './http.js';
import { SyncEngine, workspaceProfile } from './sync.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'real HTTP, PostgreSQL and encrypted SQLite synchronization',
  () => {
    let admin: Database;
    let db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    let directory: string;
    let key: Buffer;
    let local: LocalStore;
    let api: ApiClient;
    let engine: SyncEngine;
    let actor: { user_id: string; workspace_id: string };
    let subject: string;
    const stores = new Set<LocalStore>();
    const schema = `notes_client_${randomUUID().replaceAll('-', '')}`;
    function open(name = 'notes.sqlite') {
      const store = new LocalStore(join(directory, name), key);
      stores.add(store);
      return store;
    }
    function fields(text: string) {
      return {
        title: 'Synthetic client meeting',
        content: richTextFromPlainText(text),
        tags: [],
      };
    }
    async function seed(text = 'Original remote note.') {
      return db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic remote meeting',
          notes: text,
        },
        randomUUID(),
      );
    }
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
    });
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), 'windows-notes-sync-'));
      key = randomBytes(32);
      local = open();
      subject = randomUUID();
      actor = await db.provision('urn:windows-ai-notes:development', subject);
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      api = new ApiClient(base, async () => ({ 'x-dev-subject': subject }), {
        allowLoopback: true,
      });
      engine = new SyncEngine(local, api, actor.user_id, actor.workspace_id);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      engine?.stop();
      await app?.close();
      for (const store of stores) store.close();
      stores.clear();
      key?.fill(0);
      rmSync(directory, { recursive: true, force: true });
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    it('retries a committed request after a lost response and restart before pulling, preserving newer typing', async () => {
      const draft = local.create('offline', fields('Original frozen request.'));
      local.bindOffline(engine.profile);
      const fetch = globalThis.fetch;
      let lost = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const response = await fetch(input, init);
        if (
          !lost &&
          String(input).endsWith('/v1/documents') &&
          init?.method === 'POST'
        ) {
          lost = true;
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost response after commit.');
        }
        return response;
      });
      await expect(engine.synchronize()).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      const frozen = local.nextMutation(engine.profile, actor.workspace_id)!;
      expect(frozen.document_id).toBe(draft.id);
      local.save(
        engine.profile,
        draft.id,
        draft.local_revision,
        fields('New typing after the lost response.'),
      );
      local.close();
      stores.delete(local);
      local = open();
      expect(local.nextMutation(engine.profile, actor.workspace_id)).toEqual(
        frozen,
      );
      engine = new SyncEngine(local, api, actor.user_id, actor.workspace_id);
      await engine.synchronize();
      const remote = await db.document(actor.user_id, draft.id);
      expect(remote.notes).toBe('New typing after the lost response.');
      expect(remote.revision).toBe(2);
      expect(local.get(engine.profile, draft.id).status).toBe('synced');
      expect(
        (
          await db.pool.query('SELECT count(*) FROM documents WHERE id=$1', [
            draft.id,
          ])
        ).rows[0].count,
      ).toBe('1');
    });
    it('keeps another device edit as a conflict and uploads a new copy only after an explicit resolution', async () => {
      const remote = await seed();
      await engine.synchronize();
      const other = open('second-device.sqlite');
      const second = new SyncEngine(
        other,
        api,
        actor.user_id,
        actor.workspace_id,
      );
      await second.synchronize();
      const firstDraft = local.get(engine.profile, remote.id);
      const secondDraft = other.get(second.profile, remote.id);
      local.save(
        engine.profile,
        remote.id,
        firstDraft.local_revision,
        fields('Device A.'),
      );
      other.save(
        second.profile,
        remote.id,
        secondDraft.local_revision,
        fields('Device B.'),
      );
      await engine.synchronize();
      await second.synchronize();
      expect(other.get(second.profile, remote.id).status).toBe('conflict');
      expect(
        richTextToPlainText(other.get(second.profile, remote.id).content),
      ).toBe('Device B.');
      expect((await db.document(actor.user_id, remote.id)).notes).toBe(
        'Device A.',
      );
      const copy = other.resolve(second.profile, remote.id, 'copy')!;
      expect(copy.id).not.toBe(remote.id);
      await second.synchronize();
      expect((await db.document(actor.user_id, copy.id)).notes).toBe(
        'Device B.',
      );
      expect((await db.document(actor.user_id, remote.id)).notes).toBe(
        'Device A.',
      );
      expect(other.get(second.profile, remote.id).status).toBe('synced');
      second.stop();
    });
    it('resnapshots after history expiry without resurrecting missing IDs or losing pending edits', async () => {
      const retained = await seed('Retained.');
      const removed = await seed('Removed.');
      const edited = await seed('Old local version.');
      await engine.synchronize();
      const current = local.get(engine.profile, edited.id);
      local.save(
        engine.profile,
        edited.id,
        current.local_revision,
        fields('Unsent recovery text.'),
      );
      await db.deleteDocument(actor.user_id, removed.id);
      await db.deleteDocument(actor.user_id, edited.id);
      const incoming = await seed('Created while this client was offline.');
      await db.pool.query(
        'UPDATE workspaces SET sync_floor=sync_seq WHERE id=$1',
        [actor.workspace_id],
      );
      await engine.synchronize();
      expect(local.get(engine.profile, retained.id).status).toBe('synced');
      expect(local.get(engine.profile, incoming.id).status).toBe('synced');
      expect(() => local.get(engine.profile, removed.id)).toThrow(
        'unavailable',
      );
      expect(local.get(engine.profile, edited.id).status).toBe(
        'deleted_remote',
      );
      expect(
        richTextToPlainText(local.get(engine.profile, edited.id).content),
      ).toBe('Unsent recovery text.');
      expect(local.nextMutation(engine.profile, actor.workspace_id)).toBeNull();
      const raw = await db.pool.query(
        'SELECT deleted_at FROM documents WHERE id=$1',
        [edited.id],
      );
      expect(raw.rows[0].deleted_at).not.toBeNull();
    });
    it('paginates a full snapshot and caches immutable transcript evidence and private job history', async () => {
      const documents = [];
      for (let index = 0; index < 13; index++)
        documents.push(await seed(`Synthetic paginated note ${index}.`));
      const first = documents[0]!;
      await db.editTranscript(actor.user_id, first.id, 0, [
        {
          id: randomUUID(),
          start_ms: 0,
          end_ms: 1000,
          text: 'Synthetic cached transcript.',
        },
      ]);
      await engine.synchronize();
      expect(local.list(engine.profile)).toHaveLength(13);
      expect(local.syncCheckpoint(engine.profile).bootstrap).toBeNull();
      expect(
        local.getArtifact(
          engine.profile,
          first.id,
          'transcript:1',
          z.object({
            revision: z.number(),
            segments: z.array(z.object({ text: z.string() })),
          }),
        ),
      ).toMatchObject({
        revision: 1,
        segments: [{ text: 'Synthetic cached transcript.' }],
      });
      expect(
        local.getArtifact(
          engine.profile,
          first.id,
          'job-history',
          z.object({ jobs: z.array(z.unknown()) }),
        ),
      ).toEqual({ jobs: [] });
    });
    it('commits neither a newer transcript revision nor its cursor when the first page fetch fails', async () => {
      const remote = await seed();
      const segment = {
        id: randomUUID(),
        start_ms: 0,
        end_ms: 1,
        text: 'Original immutable evidence.',
      };
      await db.editTranscript(actor.user_id, remote.id, 0, [segment]);
      await engine.synchronize();
      const checkpoint = local.syncCheckpoint(engine.profile);
      const newer = Array.from({ length: 1207 }, (_, index) => ({
        ...segment,
        id: randomUUID(),
        text: `New meeting segment ${index}.`,
      }));
      await db.transaction((tx) =>
        db.transcripts.write(
          tx,
          actor.user_id,
          remote.id,
          1,
          'azure_speech_fast',
          newer,
        ),
      );
      const read = vi
        .spyOn(api, 'transcriptPage')
        .mockRejectedValueOnce(
          new ClientError(
            'service_unavailable',
            'Synthetic page retrieval failed.',
            503,
            true,
          ),
        );
      await expect(engine.synchronize()).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(local.syncCheckpoint(engine.profile)).toEqual(checkpoint);
      expect(local.details(engine.profile, remote.id).transcript_revision).toBe(
        1,
      );
      expect(
        local.getArtifact(
          engine.profile,
          remote.id,
          'transcript:2',
          z.unknown(),
        ),
      ).toBeNull();
      expect(
        local.getArtifact(
          engine.profile,
          remote.id,
          'transcript:1',
          z.object({ segments: z.array(z.unknown()) }),
        ),
      ).toMatchObject({ segments: [segment] });
      read.mockRestore();
      await engine.synchronize();
      expect(local.details(engine.profile, remote.id).transcript_revision).toBe(
        2,
      );
      expect(
        local.getArtifact(
          engine.profile,
          remote.id,
          'transcript:2',
          z.object({
            total_segments: z.number(),
            segments: z.array(z.unknown()),
          }),
        ),
      ).toEqual({ total_segments: 1207, segments: newer.slice(0, 50) });
    });
    it('purges only the revoked workspace, including artifacts and queued writes, without deleting account credentials', async () => {
      const remote = await seed();
      await engine.synchronize();
      local.putArtifact(
        engine.profile,
        remote.id,
        'transcript:1',
        'Private cached evidence.',
      );
      const current = local.get(engine.profile, remote.id);
      local.save(
        engine.profile,
        remote.id,
        current.local_revision,
        fields('Private unsent edit.'),
      );
      local.nextMutation(engine.profile, actor.workspace_id);
      local.putValue('account:synthetic', 'refresh', 'synthetic-secret-only');
      const other = local.create(
        'another-workspace',
        fields('Keep this other workspace.'),
      );
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',
        [actor.user_id, actor.workspace_id],
      );
      await expect(engine.synchronize()).rejects.toMatchObject({
        code: 'workspace_access_revoked',
      });
      expect(local.list(engine.profile)).toHaveLength(0);
      expect(local.nextMutation(engine.profile, actor.workspace_id)).toBeNull();
      expect(local.getValue('account:synthetic', 'refresh', z.string())).toBe(
        'synthetic-secret-only',
      );
      expect(local.get('another-workspace', other.id)).toEqual(other);
      expect(local.syncCheckpoint(engine.profile).cursor).toBeNull();
    });
    it('never sends a pending write with another account identity', async () => {
      const draft = local.create(
        engine.profile,
        fields('Account-isolated note.'),
      );
      subject = randomUUID();
      await db.provision('urn:windows-ai-notes:development', subject);
      await expect(engine.synchronize()).rejects.toMatchObject({
        code: 'account_mismatch',
      });
      expect(local.get(engine.profile, draft.id)).toEqual(draft);
      expect(
        (
          await db.pool.query('SELECT id FROM documents WHERE id=$1', [
            draft.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        workspaceProfile(api.base, actor.user_id, actor.workspace_id, true),
      ).toBe(engine.profile);
      expect(
        workspaceProfile(api.base, randomUUID(), actor.workspace_id, true),
      ).not.toBe(engine.profile);
      expect(
        workspaceProfile(
          'http://127.0.0.1:1',
          actor.user_id,
          actor.workspace_id,
          true,
        ),
      ).not.toBe(engine.profile);
    });
    it('removes cached workspace content when the provisioned identity is deactivated', async () => {
      await seed();
      await engine.synchronize();
      expect(local.list(engine.profile)).toHaveLength(1);
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        actor.user_id,
      ]);
      await expect(engine.synchronize()).rejects.toMatchObject({
        code: 'identity_not_provisioned',
        status: 403,
      });
      expect(local.list(engine.profile)).toHaveLength(0);
    });
    it('is single-flight and cannot repopulate a purged profile after a delayed response is cancelled', async () => {
      await seed();
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const snapshot = api.snapshot.bind(api);
      vi.spyOn(api, 'snapshot').mockImplementation(async (...arguments_) => {
        const page = await snapshot(...arguments_);
        ready();
        await gate;
        return page;
      });
      const first = engine.synchronize();
      const rejection = expect(first).rejects.toMatchObject({
        code: 'sync_cancelled',
      });
      expect(engine.synchronize()).toBe(first);
      await started;
      engine.stop();
      local.purgeProfile(engine.profile);
      release();
      await rejection;
      expect(local.list(engine.profile)).toHaveLength(0);
      expect(local.syncCheckpoint(engine.profile)).toEqual({
        cursor: null,
        bootstrap: null,
      });
    });
  },
);
