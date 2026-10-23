import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import { ApiClient } from './http.js';
import { SyncEngine } from './sync.js';
import { acceptanceDatabaseUrl, responseLossProxy } from './load.fixture.js';
import {
  launchService as launch,
  unusedServicePort as unusedPort,
} from './service-process.fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl || process.platform !== 'linux')(
  'actual isolated Linux service process lifecycle',
  () => {
    const schema = `notes_api_process_${randomUUID().replaceAll('-', '')}`;
    const children: ReturnType<typeof launch>[] = [];
    let admin: Database | undefined;
    let db: Database | undefined;
    let scoped: URL;
    let created = false;
    function database() {
      if (!db) throw new Error('The isolated database is not open.');
      return db;
    }
    async function start(port?: number, entry: 'api' | 'worker' = 'api') {
      const url = new URL(scoped);
      url.searchParams.set('application_name', schema);
      const child = launch(url.href, port ?? (await unusedPort()), entry, {
        health: entry === 'worker',
      });
      children.push(child);
      return child;
    }
    beforeAll(async () => {
      if (!databaseUrl)
        throw new Error(
          'A disposable loopback PostgreSQL database is required.',
        );
      scoped = acceptanceDatabaseUrl(databaseUrl);
      admin = new Database(scoped.href);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(scoped.href);
      await db.migrate();
    });
    afterEach(async () => {
      const stopped = await Promise.allSettled(
        children.splice(0).map(async (child) => {
          if (!child.result) child.child.kill('SIGKILL');
          await child.closed;
        }),
      );
      const failures = stopped.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Owned service process cleanup failed.',
        );
    });
    afterAll(async () => {
      try {
        await db?.close();
      } finally {
        try {
          if (created && admin)
            await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin?.close();
        }
      }
    });
    it.each(['api', 'worker'] as const)(
      'does not announce %s readiness after SIGTERM during blocked startup',
      async (entry) => {
        if (!admin)
          throw new Error('The isolated control database is not open.');
        const control = admin;
        const lock = await database().pool.connect();
        let child: Awaited<ReturnType<typeof start>>;
        try {
          await lock.query(
            'BEGIN; LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE',
          );
          child = await start(undefined, entry);
          await vi.waitFor(
            async () =>
              expect(
                (
                  await control.pool.query(
                    "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND state='active'",
                    [schema],
                  )
                ).rowCount,
              ).toBe(1),
            { timeout: 10_000, interval: 20 },
          );
          if (entry === 'worker') {
            expect((await fetch(`${child.base}/health`)).status).toBe(503);
            expect((await fetch(`${child.base}/health/live`)).status).toBe(200);
          }
          expect(child.child.kill('SIGTERM')).toBe(true);
          await child.observed(`${entry}_stopping`);
          if (entry === 'worker')
            expect((await fetch(`${child.base}/health`)).status).toBe(503);
        } finally {
          try {
            await lock.query('ROLLBACK');
          } finally {
            lock.release();
          }
        }
        expect(await child.exit()).toEqual({
          code: 0,
          signal: null,
          error: undefined,
        });
        expect(child.stdout).not.toContain(`"code":"${entry}_ready"`);
        expect(child.stderr).toBe('');
      },
    );
    it('serves actual Worker startup/database readiness and closes its listener on physical exit', async () => {
      expect((await database().pool.query('SELECT 1 FROM jobs')).rowCount).toBe(
        0,
      );
      const child = await start(undefined, 'worker');
      await child.observed('worker_ready');
      const response = await fetch(`${child.base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      expect(child.child.kill('SIGTERM')).toBe(true);
      expect(await child.exit()).toEqual({
        code: 0,
        signal: null,
        error: undefined,
      });
      await expect(fetch(`${child.base}/health`)).rejects.toThrow();
      expect(child.stderr).toBe('');
    });
    it.each(['SIGTERM', 'SIGINT'] as const)(
      'drains an actual open SSE connection and closes naturally on %s',
      async (signal) => {
        const subject = randomUUID();
        const actor = await database().provision(
          'urn:windows-ai-notes:development',
          subject,
        );
        const document = await database().createDocument(
          actor.user_id,
          {
            workspace_id: actor.workspace_id,
            title: 'Synthetic graceful shutdown',
            notes: 'Synthetic source for an unprocessed summary.',
          },
          randomUUID(),
        );
        const job = await database().enqueueSummary(
          actor.user_id,
          document.id,
          { note_revision: 1, transcript_revision: 0, language: 'en' },
          randomUUID(),
        );
        const child = await start();
        await child.observed('api_ready');
        const response = await fetch(`${child.base}/v1/jobs/${job.id}/events`, {
          headers: { 'x-dev-subject': subject },
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const drained = response.text();
        expect(child.child.kill(signal)).toBe(true);
        const [exit, body] = await Promise.all([child.exit(), drained]);
        expect(exit).toEqual({
          code: 0,
          signal: null,
          error: undefined,
        });
        expect(body).toContain('event: job.accepted');
        expect(child.stderr).toBe('');
        expect((await database().job(actor.user_id, job.id)).state).toBe(
          'queued',
        );
      },
    );
    it('replays a durably frozen mutation after actual SIGKILL without duplicating or losing newer typing', async () => {
      const root = await mkdtemp(join(tmpdir(), 'notes-api-process-'));
      const key = randomBytes(32);
      const file = join(root, 'notes.sqlite');
      let store: LocalStore | undefined;
      let engine: SyncEngine | undefined;
      let proxy: Awaited<ReturnType<typeof responseLossProxy>> | undefined;
      try {
        const subject = randomUUID();
        const actor = await database().provision(
          'urn:windows-ai-notes:development',
          subject,
        );
        const child = await start();
        await child.observed('api_ready');
        const forwarding = await responseLossProxy(child.base);
        proxy = forwarding;
        const client = () =>
          new ApiClient(
            forwarding.base,
            async () => ({ 'x-dev-subject': subject }),
            {
              allowLoopback: true,
            },
          );
        const fields = (text: string) => ({
          title: 'Synthetic physical API termination',
          content: richTextFromPlainText(text),
          tags: [],
        });
        store = new LocalStore(file, key);
        engine = new SyncEngine(
          store,
          client(),
          actor.user_id,
          actor.workspace_id,
        );
        const draft = store.create(
          'offline',
          fields('Original frozen request.'),
        );
        store.bindOffline(engine.profile);
        proxy.arm();
        await expect(engine.synchronize()).rejects.toMatchObject({
          code: 'service_unavailable',
        });
        expect(proxy.dropped).toBe(1);
        const frozen = store.nextMutation(engine.profile, actor.workspace_id);
        expect(frozen?.document_id).toBe(draft.id);
        expect((await database().document(actor.user_id, draft.id)).notes).toBe(
          'Original frozen request.',
        );
        store.save(
          engine.profile,
          draft.id,
          draft.local_revision,
          fields('New typing after the lost response.'),
        );
        expect(child.child.kill('SIGKILL')).toBe(true);
        expect(await child.exit()).toEqual({
          code: null,
          signal: 'SIGKILL',
          error: undefined,
        });
        engine.stop();
        store.close();
        store = undefined;
        const restarted = await start(child.port);
        await restarted.observed('api_ready');
        store = new LocalStore(file, key);
        engine = new SyncEngine(
          store,
          client(),
          actor.user_id,
          actor.workspace_id,
        );
        expect(store.nextMutation(engine.profile, actor.workspace_id)).toEqual(
          frozen,
        );
        await engine.synchronize();
        await engine.synchronize();
        expect(
          store.nextMutation(engine.profile, actor.workspace_id),
        ).toBeNull();
        expect(
          richTextToPlainText(store.get(engine.profile, draft.id).content),
        ).toBe('New typing after the lost response.');
        expect(
          await database().document(actor.user_id, draft.id),
        ).toMatchObject({
          notes: 'New typing after the lost response.',
          revision: 2,
        });
        expect(
          (
            await database().pool.query(
              'SELECT id FROM documents WHERE owner_id=$1',
              [actor.user_id],
            )
          ).rows,
        ).toEqual([{ id: draft.id }]);
        expect(proxy.unexpectedErrors).toBe(0);
        expect(restarted.child.kill('SIGTERM')).toBe(true);
        expect(await restarted.exit()).toEqual({
          code: 0,
          signal: null,
          error: undefined,
        });
      } finally {
        engine?.stop();
        store?.close();
        key.fill(0);
        try {
          await proxy?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    });
  },
);
