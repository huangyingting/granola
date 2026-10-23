import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import { ApiClient } from './http.js';
import { SyncEngine } from './sync.js';
import { acceptanceDatabaseUrl, responseLossProxy } from './load.fixture.js';
import { launchService, unusedServicePort } from './service-process.fixture.js';

const enabled = process.env.SERVER_DATABASE_CRASH_ACCEPTANCE === '1';
const docker = async (...args: string[]) =>
  (
    await promisify(execFile)('docker', args, {
      timeout: 20_000,
      maxBuffer: 131_072,
    })
  ).stdout.trim();
async function assertEmptyDatabase(database: Database): Promise<void> {
  expect(
    (
      await database.pool.query(
        `SELECT
         (SELECT count(*)::integer FROM pg_namespace
           WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_') schemas,
         (SELECT count(*)::integer FROM pg_depend d JOIN pg_namespace n ON n.oid=d.refobjid
           WHERE d.refclassid='pg_namespace'::regclass AND n.nspname='public') public_objects`,
      )
    ).rows,
  ).toEqual([{ schemas: 0, public_objects: 0 }]);
}
const inspect = async (id: string) =>
  z
    .object({
      id: z.literal(id),
      image: z.literal('postgres:16-alpine'),
      auto_remove: z.literal(false),
      mounts: z.array(
        z.object({
          Type: z.string(),
          Name: z.string().optional(),
          Destination: z.string(),
        }),
      ),
      ports: z
        .record(
          z.string(),
          z
            .array(
              z.object({
                HostIp: z.string(),
                HostPort: z.string(),
              }),
            )
            .nullable(),
        )
        .nullable(),
      state: z.object({
        Running: z.boolean(),
        ExitCode: z.number(),
        OOMKilled: z.literal(false),
      }),
    })
    .parse(
      JSON.parse(
        await docker(
          'inspect',
          '--format',
          '{"id":{{json .Id}},"image":{{json .Config.Image}},"auto_remove":{{json .HostConfig.AutoRemove}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"state":{{json .State}}}',
          id,
        ),
      ),
    );

describe.skipIf(!enabled)(
  'opt-in physical PostgreSQL crash and WAL recovery',
  () => {
    it('retains committed encrypted-client work, rolls back unfinished work and recovers the original services', async () => {
      if (process.platform !== 'linux')
        throw new Error(
          'Physical database acceptance requires Linux and an owned disposable Docker PostgreSQL.',
        );
      const id = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(process.env.TEST_POSTGRES_CONTAINER);
      const url = acceptanceDatabaseUrl(
        z.string().parse(process.env.TEST_DATABASE_URL),
      );
      const initial = await inspect(id);
      expect(initial.state.Running).toBe(true);
      expect(initial.ports?.['5432/tcp']).toEqual([
        {
          HostIp: '127.0.0.1',
          HostPort: url.port || '5432',
        },
      ]);
      const mount = initial.mounts.find(
        (value) => value.Destination === '/var/lib/postgresql/data',
      );
      if (mount?.Type !== 'volume' || !mount.Name)
        throw new Error(
          'Crash acceptance requires persistent Docker-volume PostgreSQL data, never tmpfs or an external bind mount.',
        );
      const volume = mount.Name;
      const admin = new Database(url.href);
      let db: Database | undefined,
        child: ReturnType<typeof launchService> | undefined,
        worker: ReturnType<typeof launchService> | undefined,
        store: LocalStore | undefined,
        engine: SyncEngine | undefined,
        proxy: Awaited<ReturnType<typeof responseLossProxy>> | undefined,
        directory: string | undefined;
      const key = randomBytes(32);
      const schema = `notes_pg_crash_${randomUUID().replaceAll('-', '')}`;
      let created = false,
        restartRequired = false;
      try {
        await assertEmptyDatabase(admin);
        const maintenanceUrl = new URL(url);
        maintenanceUrl.pathname = '/postgres';
        const maintenance = new Database(maintenanceUrl.href);
        try {
          await assertEmptyDatabase(maintenance);
        } finally {
          await maintenance.close();
        }
        const empty = await admin.pool.query(
          `SELECT
         (SELECT count(*)::integer FROM pg_database
           WHERE NOT datistemplate AND datname NOT IN (current_database(),'postgres')) databases,
         (SELECT count(*)::integer FROM pg_stat_activity
           WHERE backend_type='client backend' AND pid<>pg_backend_pid()
           AND application_name<>'pg_isready') connections`,
        );
        expect(empty.rows).toEqual([{ databases: 0, connections: 0 }]);
        const guardSchema = `pgx_crash_guard_${randomUUID().replaceAll('-', '')}`;
        await admin.pool.query(`CREATE SCHEMA "${guardSchema}"`);
        try {
          await expect(assertEmptyDatabase(admin)).rejects.toThrow();
        } finally {
          await admin.pool.query(`DROP SCHEMA "${guardSchema}"`);
        }
        const guardView = `notes_crash_guard_${randomUUID().replaceAll('-', '')}`;
        await admin.pool.query(`CREATE VIEW public."${guardView}" AS SELECT 1`);
        try {
          await expect(assertEmptyDatabase(admin)).rejects.toThrow();
        } finally {
          await admin.pool.query(`DROP VIEW public."${guardView}"`);
        }
        const durability = z
          .object({
            fsync: z.literal('on'),
            full_page_writes: z.literal('on'),
            synchronous_commit: z.literal('on'),
            system_id: z.string(),
            started: z.date(),
          })
          .parse(
            (
              await admin.pool.query(
                `SELECT current_setting('fsync') fsync,
         current_setting('full_page_writes') full_page_writes,
         current_setting('synchronous_commit') synchronous_commit,
         system_identifier::text system_id,pg_postmaster_start_time() started
         FROM pg_control_system()`,
              )
            ).rows[0],
          );
        await admin.pool.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        url.searchParams.set('options', `-c search_path=${schema}`);
        db = new Database(url.href);
        await db.migrate();
        await db.pool.query('CREATE TABLE crash_probe(id uuid PRIMARY KEY)');
        const subject = randomUUID();
        const actor = await db.provision(
          'urn:windows-ai-notes:development',
          subject,
        );
        child = launchService(url.href, await unusedServicePort(), 'api', {
          durationMs: 90_000,
        });
        await child.observed('api_ready');
        const base = child.base;
        const probe = async (path: '/health' | '/health/live') => {
          const response = await fetch(new URL(path, base), {
            signal: AbortSignal.timeout(10_000),
          });
          const body: unknown = await response.json();
          return { status: response.status, body };
        };
        expect(await probe('/health')).toEqual({
          status: 200,
          body: { status: 'ok' },
        });
        expect(await probe('/health/live')).toEqual({
          status: 200,
          body: { status: 'ok' },
        });
        proxy = await responseLossProxy(child.base);
        directory = await mkdtemp(join(tmpdir(), 'notes-pg-crash-'));
        store = new LocalStore(join(directory, 'notes.sqlite'), key);
        const api = new ApiClient(
          proxy.base,
          async () => ({ 'x-dev-subject': subject }),
          { allowLoopback: true },
        );
        engine = new SyncEngine(store, api, actor.user_id, actor.workspace_id);
        const fields = (text: string) => ({
          title: 'Synthetic PostgreSQL crash',
          content: richTextFromPlainText(text),
          tags: [],
        });
        const draft = store.create(
          'offline',
          fields('Durably committed before the database crash.'),
        );
        store.bindOffline(engine.profile);
        proxy.arm();
        await expect(engine.synchronize()).rejects.toMatchObject({
          code: 'service_unavailable',
        });
        expect(proxy.dropped).toBe(1);
        const frozen = store.nextMutation(engine.profile, actor.workspace_id);
        expect(frozen?.document_id).toBe(draft.id);
        expect((await db.document(actor.user_id, draft.id)).notes).toBe(
          'Durably committed before the database crash.',
        );
        store.save(
          engine.profile,
          draft.id,
          draft.local_revision,
          fields('New local typing while the committed response was lost.'),
        );
        const workerUrl = new URL(url);
        workerUrl.searchParams.set('application_name', `${schema}_worker`);
        worker = launchService(
          workerUrl.href,
          await unusedServicePort(),
          'worker',
          { durationMs: 90_000 },
        );
        await worker.observed('worker_ready');
        let original: unknown, pid: number | undefined;
        const unfinished = db
          .transaction(async (tx) => {
            await tx.query('INSERT INTO crash_probe VALUES ($1)', [
              randomUUID(),
            ]);
            await tx.query('LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE');
            pid = z
              .number()
              .int()
              .positive()
              .parse(
                (await tx.query('SELECT pg_backend_pid() pid')).rows[0].pid,
              );
            try {
              await tx.query('SELECT pg_sleep(60)');
            } catch (error) {
              original = error;
              throw error;
            }
          })
          .then(
            () => {
              throw new Error(
                'The deliberately unfinished transaction unexpectedly committed.',
              );
            },
            (error: unknown) => error,
          );
        await vi.waitFor(async () =>
          expect(
            (
              await admin.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND wait_event='PgSleep'",
                [pid ?? 0],
              )
            ).rowCount,
          ).toBe(1),
        );
        await vi.waitFor(
          async () =>
            expect(
              (
                await admin.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'",
                  [`${schema}_worker`],
                )
              ).rowCount,
            ).toBe(1),
          { timeout: 5000, interval: 20 },
        );
        restartRequired = true;
        await docker('kill', '--signal', 'KILL', id);
        const stopped = await inspect(id);
        expect(stopped.state).toMatchObject({ Running: false, ExitCode: 137 });
        const failed = await unfinished;
        expect(original).toBeInstanceOf(Error);
        expect.soft(failed).toBe(original);
        expect(await probe('/health/live')).toEqual({
          status: 200,
          body: { status: 'ok' },
        });
        expect(await probe('/health')).toMatchObject({
          status: 503,
          body: { code: 'database_unavailable', retryable: true },
        });
        await expect.soft(engine.synchronize()).rejects.toMatchObject({
          code: 'database_unavailable',
          status: 503,
          retryable: true,
        });
        expect(store.nextMutation(engine.profile, actor.workspace_id)).toEqual(
          frozen,
        );
        const control = await docker(
          'run',
          '--rm',
          '--pull',
          'never',
          '--network',
          'none',
          '--read-only',
          '--user',
          'postgres',
          '--memory',
          '64m',
          '--cpus',
          '0.5',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--mount',
          `type=volume,source=${volume},destination=/probe,readonly`,
          '--entrypoint',
          'pg_controldata',
          'postgres:16-alpine',
          '/probe',
        );
        expect(/^Database cluster state:\s+in production$/m.test(control)).toBe(
          true,
        );
        await docker('start', id);
        restartRequired = false;
        await vi.waitFor(
          async () =>
            expect((await admin.pool.query('SELECT 1 ready')).rows).toEqual([
              { ready: 1 },
            ]),
          { timeout: 20_000, interval: 100 },
        );
        const recovered = await inspect(id);
        expect(recovered.mounts).toEqual(initial.mounts);
        const cluster = (
          await admin.pool.query(
            'SELECT system_identifier::text system_id,pg_postmaster_start_time() started FROM pg_control_system()',
          )
        ).rows[0];
        expect(cluster.system_id).toBe(durability.system_id);
        expect(cluster.started.getTime()).toBeGreaterThan(
          durability.started.getTime(),
        );
        expect(child.result).toBeUndefined();
        expect(worker.result).toBeUndefined();
        expect(await probe('/health')).toEqual({
          status: 200,
          body: { status: 'ok' },
        });
        await vi.waitFor(
          async () =>
            expect(
              (
                await admin.pool.query(
                  `SELECT 1 FROM pg_stat_activity WHERE application_name=$1
                   AND backend_start>=$2 AND state='idle' AND query='COMMIT'`,
                  [`${schema}_worker`, cluster.started],
                )
              ).rowCount,
            ).toBeGreaterThan(0),
          { timeout: 5000, interval: 20 },
        );
        expect(
          (await db.pool.query('SELECT count(*)::text count FROM crash_probe'))
            .rows,
        ).toEqual([{ count: '0' }]);
        engine.stop();
        store.close();
        store = new LocalStore(join(directory, 'notes.sqlite'), key);
        engine = new SyncEngine(store, api, actor.user_id, actor.workspace_id);
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
        ).toBe('New local typing while the committed response was lost.');
        expect(await db.document(actor.user_id, draft.id)).toMatchObject({
          notes: 'New local typing while the committed response was lost.',
          revision: 2,
        });
        expect(
          (
            await db.pool.query('SELECT id FROM documents WHERE owner_id=$1', [
              actor.user_id,
            ])
          ).rows,
        ).toEqual([{ id: draft.id }]);
        expect(proxy.unexpectedErrors).toBe(0);
        expect(child.child.kill('SIGTERM')).toBe(true);
        expect(await child.exit()).toEqual({
          code: 0,
          signal: null,
          error: undefined,
        });
        expect(worker.child.kill('SIGTERM')).toBe(true);
        expect(await worker.exit()).toEqual({
          code: 0,
          signal: null,
          error: undefined,
        });
      } finally {
        const failures: unknown[] = [];
        const cleanup = async (action: () => unknown | Promise<unknown>) => {
          try {
            await action();
          } catch (error) {
            failures.push(error);
          }
        };
        engine?.stop();
        await cleanup(async () => {
          if (child && !child.result) child.child.kill('SIGKILL');
          await child?.closed;
        });
        await cleanup(async () => {
          if (worker && !worker.result) worker.child.kill('SIGKILL');
          await worker?.closed;
        });
        await cleanup(() => proxy?.close());
        await cleanup(() => store?.close());
        key.fill(0);
        if (restartRequired)
          await cleanup(async () => {
            await docker('start', id);
            await vi.waitFor(() => admin.pool.query('SELECT 1'), {
              timeout: 20_000,
              interval: 100,
            });
          });
        await cleanup(() => db?.close());
        await cleanup(async () => {
          if (created)
            await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        });
        await cleanup(() => admin.close());
        const ownedDirectory = directory;
        if (ownedDirectory)
          await cleanup(() =>
            rm(ownedDirectory, { recursive: true, force: true }),
          );
        if (failures.length)
          throw new AggregateError(
            failures,
            'Owned database crash acceptance cleanup failed.',
          );
      }
    }, 90_000);
  },
);
