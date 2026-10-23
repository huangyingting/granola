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
import { Database, isDatabaseUnavailable } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import { createServer } from '../../../apps/api/dist/server.js';
import { ApiClient } from './http.js';
import { SyncEngine } from './sync.js';
import { acceptanceDatabaseUrl } from './load.fixture.js';
import { databaseResponseLossProxy } from './database-timeout.fixture.js';
import { launchService, unusedServicePort } from './service-process.fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const privateMarker = 'private-database-timeout-content-marker';

async function withinReadDeadline<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), 17_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!databaseUrl)(
  'real stalled PostgreSQL response recovery',
  () => {
    const schema = `notes_read_timeout_${randomUUID().replaceAll('-', '')}`;
    let admin: Database | undefined;
    let control: Database | undefined;
    let scoped: URL;
    let created = false;
    beforeAll(async () => {
      if (!databaseUrl)
        throw new Error('A private loopback test database is required.');
      scoped = acceptanceDatabaseUrl(databaseUrl);
      admin = new Database(scoped.href);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      control = new Database(scoped.href);
      await control.migrate();
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      try {
        await control?.close();
      } finally {
        try {
          if (created && admin)
            await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin?.close();
        }
      }
    });
    function database() {
      if (!control)
        throw new Error('The private control database is not open.');
      return control;
    }
    it('rolls back an actual server-side statement cancellation and safely reuses that connection', async () => {
      const db = new Database(scoped.href);
      try {
        const initial = await db.pool.query('SELECT pg_backend_pid() pid');
        const failure = await db
          .transaction(async (tx) => {
            await tx.query("SET LOCAL statement_timeout='50ms'");
            await tx.query('SELECT pg_sleep(0.2)');
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(failure).toMatchObject({ code: '57014' });
        expect(isDatabaseUnavailable(failure)).toBe(false);
        expect(
          (await db.pool.query('SELECT pg_backend_pid() pid')).rows,
        ).toEqual(initial.rows);
        expect(db.pool.totalCount).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('bounds shared readiness, retains liveness and replaces a stalled pooled connection', async () => {
      const proxy = await databaseResponseLossProxy(scoped.href);
      const db = new Database(proxy.url);
      const app = await createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
      });
      let pending: Promise<unknown> | undefined;
      try {
        await app.ready();
        proxy.arm('SELECT 1');
        const responses = Promise.all(
          Array.from({ length: 8 }, () =>
            app.inject('/health').then((response) => response),
          ),
        );
        pending = responses;
        await vi.waitFor(
          () => expect(proxy.observations.droppedBytes).toBeGreaterThan(0),
          { timeout: 5000, interval: 10 },
        );
        expect(proxy.observations.faults).toBe(1);
        expect((await app.inject('/health/live')).statusCode).toBe(200);
        const result = await withinReadDeadline(responses);
        expect(result.completed).toBe(true);
        if (!result.completed)
          throw new Error('Stalled readiness exceeded the client read bound.');
        for (const response of result.value) {
          expect(response.statusCode).toBe(503);
          expect(response.json()).toMatchObject({
            code: 'database_unavailable',
            retryable: true,
          });
          expect(response.body).not.toContain('Query read timeout');
        }
        expect(db.pool.totalCount).toBe(0);
        expect((await app.inject('/health')).statusCode).toBe(200);
        expect(proxy.observations).toMatchObject({
          faults: 1,
          rollbackAfterFault: 0,
          connections: 2,
          unexpectedErrors: 0,
        });
      } finally {
        try {
          await proxy.close();
          await pending;
        } finally {
          try {
            await app.close();
          } finally {
            await db.close();
          }
        }
      }
    }, 30_000);

    it('discards an uncertain COMMIT without rollback or replay and preserves encrypted frozen edits', async () => {
      const log = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const errors = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const proxy = await databaseResponseLossProxy(scoped.href);
      const db = new Database(proxy.url);
      const app = await createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
      });
      const root = await mkdtemp(join(tmpdir(), 'notes-read-timeout-'));
      const key = randomBytes(32);
      let store: LocalStore | undefined;
      let engine: SyncEngine | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const subject = randomUUID();
        const actor = await database().provision(
          'urn:windows-ai-notes:development',
          subject,
        );
        const base = await app.listen({ host: '127.0.0.1', port: 0 });
        const file = join(root, 'notes.sqlite');
        store = new LocalStore(file, key);
        const client = new ApiClient(
          base,
          async () => ({ 'x-dev-subject': subject }),
          { allowLoopback: true },
        );
        engine = new SyncEngine(
          store,
          client,
          actor.user_id,
          actor.workspace_id,
        );
        const fields = (text: string) => ({
          title: privateMarker,
          content: richTextFromPlainText(text),
          tags: [],
        });
        const draft = store.create('offline', fields('Original frozen input.'));
        store.bindOffline(engine.profile);
        proxy.arm('COMMIT');
        const synchronized = engine.synchronize().then(
          () => null,
          (error: unknown) => error,
        );
        pending = synchronized;
        await vi.waitFor(
          async () =>
            expect(
              (await database().document(actor.user_id, draft.id)).notes,
            ).toBe('Original frozen input.'),
          { timeout: 5000, interval: 10 },
        );
        expect(proxy.observations.droppedBytes).toBeGreaterThan(0);
        const frozen = store.nextMutation(engine.profile, actor.workspace_id);
        expect(frozen?.document_id).toBe(draft.id);
        store.save(
          engine.profile,
          draft.id,
          draft.local_revision,
          fields('Newer typing during the uncertain COMMIT.'),
        );
        const result = await withinReadDeadline(synchronized);
        expect(result.completed).toBe(true);
        if (!result.completed)
          throw new Error('Uncertain COMMIT exceeded the client read bound.');
        expect(result.value).toMatchObject({
          code: 'database_unavailable',
          retryable: true,
        });
        expect(proxy.observations.rollbackAfterFault).toBe(0);
        expect(store.nextMutation(engine.profile, actor.workspace_id)).toEqual(
          frozen,
        );
        expect(
          JSON.stringify([...log.mock.calls, ...errors.mock.calls]),
        ).not.toContain(privateMarker);
        engine.stop();
        store.close();
        store = new LocalStore(file, key);
        engine = new SyncEngine(
          store,
          client,
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
        ).toBe('Newer typing during the uncertain COMMIT.');
        expect(
          await database().document(actor.user_id, draft.id),
        ).toMatchObject({
          notes: 'Newer typing during the uncertain COMMIT.',
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
        expect(proxy.observations).toMatchObject({
          faults: 1,
          rollbackAfterFault: 0,
          unexpectedErrors: 0,
        });
      } finally {
        engine?.stop();
        store?.close();
        key.fill(0);
        try {
          await proxy.close();
          await pending;
        } finally {
          try {
            await app.close();
          } finally {
            try {
              await db.close();
            } finally {
              await rm(root, { recursive: true, force: true });
            }
          }
        }
      }
    }, 30_000);

    it.skipIf(process.platform !== 'linux')(
      'naturally closes the real API after SIGTERM during a stalled readiness query',
      async () => {
        const proxy = await databaseResponseLossProxy(scoped.href);
        const child = launchService(
          proxy.url,
          await unusedServicePort(),
          'api',
          { durationMs: 45_000 },
        );
        let pending: Promise<unknown> | undefined;
        try {
          await child.observed('api_ready');
          const live = await fetch(`${child.base}/health/live`, {
            signal: AbortSignal.timeout(5000),
          });
          expect(live.headers.get('connection')).toBe('keep-alive');
          await live.arrayBuffer();
          proxy.arm('SELECT 1');
          const response = fetch(`${child.base}/health`, {
            signal: AbortSignal.timeout(25_000),
          }).then(
            (value) => value,
            (error: unknown) => error,
          );
          pending = response;
          await vi.waitFor(
            () => expect(proxy.observations.droppedBytes).toBeGreaterThan(0),
            { timeout: 5000, interval: 10 },
          );
          expect(child.child.kill('SIGTERM')).toBe(true);
          await child.observed('api_stopping');
          const closed = await withinReadDeadline(child.closed);
          expect(closed.completed, child.stdout + child.stderr).toBe(true);
          if (!closed.completed)
            throw new Error('API shutdown exceeded the database read bound.');
          expect(closed.value).toEqual({
            code: 0,
            signal: null,
            error: undefined,
          });
          const result = await response;
          expect(result).toBeInstanceOf(Response);
          if (!(result instanceof Response)) throw result;
          expect(result.status).toBe(503);
          expect(result.headers.get('connection')).toBe('close');
          expect(await result.json()).toMatchObject({
            code: 'database_unavailable',
            retryable: true,
          });
          expect(child.stderr).toBe('');
          expect(proxy.observations).toMatchObject({
            faults: 1,
            rollbackAfterFault: 0,
            unexpectedErrors: 0,
          });
        } finally {
          try {
            if (!child.result) child.child.kill('SIGKILL');
            await child.closed;
            await pending;
          } finally {
            await proxy.close();
          }
        }
      },
      35_000,
    );
  },
);
