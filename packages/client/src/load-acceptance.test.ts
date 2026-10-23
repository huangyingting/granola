import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer } from '@windows-ai-notes/api/server';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import { ApiClient, ClientError } from './http.js';
import { SyncEngine } from './sync.js';
import {
  acceptanceDatabaseUrl,
  concurrentBurst,
  latencySummary,
  loadAcceptanceReportSchema,
  measured,
  responseLossProxy,
} from './load.fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl || process.env.SERVER_LOAD_ACCEPTANCE !== '1')(
  'controlled concurrent HTTP/PostgreSQL/encrypted SQLite acceptance',
  () => {
    it('preserves acknowledged work across real response loss, restarts, conflicts, overload and offline deletion', async () => {
      const source = acceptanceDatabaseUrl(databaseUrl!);
      const schema = `notes_load_${randomUUID().replaceAll('-', '')}`;
      const admin = new Database(source.href);
      const scoped = new URL(source);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      const root = await mkdtemp(join(tmpdir(), 'notes-controlled-load-'));
      const privateMarker = 'synthetic-controlled-load-content';
      const fields = (text: string) => ({
        title: privateMarker,
        content: richTextFromPlainText(`${privateMarker}: ${text}`),
        tags: ['Synthetic'],
      });
      type Actor = Awaited<ReturnType<Database['provision']>> & {
        subject: string;
      };
      type Device = {
        actor: Actor;
        key: Buffer;
        file: string;
        store: LocalStore;
        api: ApiClient;
        engine: SyncEngine;
        ids: string[];
      };
      const actors: Actor[] = [];
      const devices: Device[] = [];
      const stores = new Set<LocalStore>();
      let db: Database | undefined;
      let app: Awaited<ReturnType<typeof createServer>> | undefined;
      let proxy: Awaited<ReturnType<typeof responseLossProxy>> | undefined;
      let port = 0;
      let serverRestarts = 0;
      let createdSchema = false;
      const timing: Record<
        'initial' | 'recovered' | 'conflicts' | 'deletion',
        number[]
      > = {
        initial: [],
        recovered: [],
        conflicts: [],
        deletion: [],
      };
      const accepted: number[] = [],
        limited: number[] = [];
      let report: z.infer<typeof loadAcceptanceReportSchema> | undefined;

      function database() {
        if (!db) throw new Error('The isolated API database is not open.');
        return db;
      }
      async function startApi() {
        db = new Database(scoped.href);
        app = await createServer(db, {
          mode: 'development',
          host: '127.0.0.1',
        });
        await app.listen({ host: '127.0.0.1', port });
        const address = app.server.address();
        if (!address || typeof address === 'string')
          throw new Error('The API did not acquire its literal-loopback port.');
        port = address.port;
      }
      async function stopApi() {
        const closing = app,
          closingDb = db;
        app = undefined;
        db = undefined;
        try {
          await closing?.close();
        } finally {
          await closingDb?.close();
        }
      }
      async function restartApi() {
        await stopApi();
        await startApi();
        serverRestarts++;
      }
      function client(actor: Actor) {
        if (!proxy)
          throw new Error('The controlled response-loss proxy is not open.');
        return new ApiClient(
          proxy.base,
          async () => ({ 'x-dev-subject': actor.subject }),
          { allowLoopback: true },
        );
      }
      function reopenDevices() {
        for (const device of devices) {
          device.engine.stop();
          device.store.close();
          stores.delete(device.store);
          device.store = new LocalStore(device.file, device.key);
          stores.add(device.store);
          device.api = client(device.actor);
          device.engine = new SyncEngine(
            device.store,
            device.api,
            device.actor.user_id,
            device.actor.workspace_id,
          );
        }
      }
      async function synchronize(samples: number[]) {
        const settled = await Promise.allSettled(
          devices.map((device) =>
            measured(samples, () => device.engine.synchronize()),
          ),
        );
        const failed = settled.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
        expect(
          settled.every(
            (result) => result.status === 'fulfilled' && !result.value.more,
          ),
        ).toBe(true);
      }
      async function documentCount(total: number, deleted = 0) {
        const row = z
          .object({ total: z.string(), deleted: z.string() })
          .parse(
            (
              await database().pool.query(
                'SELECT count(*)::text total,count(*) FILTER (WHERE deleted_at IS NOT NULL)::text deleted FROM documents',
              )
            ).rows[0],
          );
        expect(row).toEqual({ total: String(total), deleted: String(deleted) });
      }

      try {
        await admin.pool.query(`CREATE SCHEMA "${schema}"`);
        createdSchema = true;
        db = new Database(scoped.href);
        await db.migrate();
        await db.close();
        db = undefined;
        await startApi();
        proxy = await responseLossProxy(`http://127.0.0.1:${port}`);
        for (let account = 0; account < 2; account++) {
          const subject = randomUUID();
          const actor = {
            ...(await database().provision(
              'urn:windows-ai-notes:development',
              subject,
            )),
            subject,
          };
          actors.push(actor);
          for (let index = 0; index < 2; index++) {
            const key = randomBytes(32),
              file = join(root, `device-${account}-${index}.sqlite`);
            const store = new LocalStore(file, key);
            stores.add(store);
            const api = client(actor);
            const engine = new SyncEngine(
              store,
              api,
              actor.user_id,
              actor.workspace_id,
            );
            const ids = Array.from(
              { length: 2 },
              (_, document) =>
                store.create(
                  'offline',
                  fields(`${account}/${index}/${document}`),
                ).id,
            );
            store.bindOffline(engine.profile);
            devices.push({ actor, key, file, store, api, engine, ids });
          }
        }
        proxy.arm();
        const initial = await Promise.allSettled(
          devices.map((device) =>
            measured(timing.initial, () => device.engine.synchronize()),
          ),
        );
        const failures = initial.flatMap((result, index) =>
          result.status === 'rejected' ? [index] : [],
        );
        expect(failures).toHaveLength(1);
        const failedIndex = failures[0];
        if (failedIndex === undefined)
          throw new Error('No committed response was lost.');
        const lost = devices[failedIndex];
        const result = initial[failedIndex];
        if (!lost || result?.status !== 'rejected')
          throw new Error('The failed client is unavailable.');
        expect(result.reason).toBeInstanceOf(ClientError);
        expect(result.reason).toMatchObject({ code: 'service_unavailable' });
        expect(proxy.dropped).toBe(1);
        const frozen = lost.store.nextMutation(
          lost.engine.profile,
          lost.actor.workspace_id,
        );
        if (!frozen)
          throw new Error(
            'The committed lost request was not retained durably.',
          );
        expect(
          (await database().document(lost.actor.user_id, frozen.document_id))
            .id,
        ).toBe(frozen.document_id);

        for (const device of devices) device.engine.stop();
        await restartApi();
        reopenDevices();
        expect(
          lost.store.nextMutation(lost.engine.profile, lost.actor.workspace_id),
        ).toEqual(frozen);
        await synchronize(timing.recovered);
        await synchronize(timing.recovered);
        await documentCount(8);
        for (const device of devices) {
          expect(device.store.list(device.engine.profile)).toHaveLength(4);
          expect(
            device.store.nextMutation(
              device.engine.profile,
              device.actor.workspace_id,
            ),
          ).toBeNull();
          expect(
            new Set(
              device.store.list(device.engine.profile).map((draft) => draft.id),
            ),
          ).toEqual(
            new Set(
              devices
                .filter((other) => other.actor.user_id === device.actor.user_id)
                .flatMap((other) => other.ids),
            ),
          );
        }

        await restartApi();
        for (const actor of actors) {
          const pair = devices.filter(
            (device) => device.actor.user_id === actor.user_id,
          );
          const id = pair[0]?.ids[0];
          if (!id)
            throw new Error('The shared conflict document is unavailable.');
          for (const [index, device] of pair.entries()) {
            const draft = device.store.get(device.engine.profile, id);
            device.store.save(
              device.engine.profile,
              id,
              draft.local_revision,
              fields(`concurrent ${index}`),
            );
          }
        }
        await synchronize(timing.conflicts);
        const conflicts: {
          device: Device;
          id: string;
          body: string;
          copy: string;
        }[] = [];
        for (const actor of actors) {
          const pair = devices.filter(
            (device) => device.actor.user_id === actor.user_id,
          );
          const id = pair[0]?.ids[0];
          if (!id) throw new Error('The conflicted document is unavailable.');
          const losers = pair.filter(
            (device) =>
              device.store.get(device.engine.profile, id).status === 'conflict',
          );
          expect(losers).toHaveLength(1);
          const device = losers[0];
          if (!device) throw new Error('The losing edit was not preserved.');
          const body = richTextToPlainText(
            device.store.get(device.engine.profile, id).content,
          );
          const remote = await database().document(actor.user_id, id);
          expect(remote.revision).toBe(2);
          expect(remote.notes).not.toBe(body);
          const copy = device.store.resolve(device.engine.profile, id, 'copy');
          if (!copy)
            throw new Error(
              'Explicit conflict-copy resolution did not create a draft.',
            );
          conflicts.push({ device, id, body, copy: copy.id });
        }
        await restartApi();
        await synchronize(timing.conflicts);
        await synchronize(timing.conflicts);
        await documentCount(10);
        for (const conflict of conflicts) {
          expect(
            (
              await database().document(
                conflict.device.actor.user_id,
                conflict.copy,
              )
            ).notes,
          ).toBe(conflict.body);
          expect(
            (
              await database().document(
                conflict.device.actor.user_id,
                conflict.id,
              )
            ).revision,
          ).toBe(2);
          const stranger = devices.find(
            (device) => device.actor.user_id !== conflict.device.actor.user_id,
          );
          if (!stranger)
            throw new Error('The independent account is unavailable.');
          await expect(
            stranger.api.document(conflict.id),
          ).rejects.toMatchObject({ code: 'document_not_found', status: 404 });
        }

        await restartApi();
        const reader = devices[0],
          readable = reader?.ids[1];
        if (!reader || !readable)
          throw new Error('The synthetic burst document is unavailable.');
        await concurrentBurst(128, 8, async () => {
          const started = performance.now();
          try {
            expect((await reader.api.document(readable)).id).toBe(readable);
            accepted.push(performance.now() - started);
          } catch (error) {
            if (
              !(error instanceof ClientError) ||
              error.code !== 'rate_limited'
            )
              throw error;
            expect(error.status).toBe(429);
            expect(error.retryable).toBe(true);
            expect(error.retryAfterSeconds).toBeGreaterThan(0);
            expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);
            limited.push(performance.now() - started);
          }
        });
        expect(accepted.length).toBeGreaterThan(0);
        expect(limited.length).toBeGreaterThan(0);
        expect(accepted.length + limited.length).toBe(128);

        await restartApi();
        for (const actor of actors) {
          const pair = devices.filter(
            (device) => device.actor.user_id === actor.user_id,
          );
          const deleting = pair[0],
            editing = pair[1],
            id = deleting?.ids[1];
          if (!deleting || !editing || !id)
            throw new Error('The offline-deletion pair is unavailable.');
          const draft = editing.store.get(editing.engine.profile, id);
          editing.store.save(
            editing.engine.profile,
            id,
            draft.local_revision,
            fields('retained offline after deletion'),
          );
          deleting.store.remove(deleting.engine.profile, id);
          await measured(timing.deletion, () => deleting.engine.synchronize());
          await measured(timing.deletion, () => editing.engine.synchronize());
          expect(editing.store.get(editing.engine.profile, id).status).toBe(
            'deleted_remote',
          );
          expect(
            richTextToPlainText(
              editing.store.get(editing.engine.profile, id).content,
            ),
          ).toContain('retained offline after deletion');
        }
        await restartApi();
        reopenDevices();
        await synchronize(timing.deletion);
        await documentCount(10, 2);
        for (const actor of actors) {
          const pair = devices.filter(
            (device) => device.actor.user_id === actor.user_id,
          );
          const deleting = pair[0],
            editing = pair[1],
            id = deleting?.ids[1];
          if (!deleting || !editing || !id)
            throw new Error('The deleted document identity is unavailable.');
          const retained = editing.store.get(editing.engine.profile, id);
          expect(retained.status).toBe('deleted_remote');
          expect(richTextToPlainText(retained.content)).toContain(
            'retained offline after deletion',
          );
          await expect(deleting.api.document(id)).rejects.toMatchObject({
            code: 'document_not_found',
            status: 404,
          });
        }
        for (const conflict of conflicts)
          expect(
            (
              await database().document(
                conflict.device.actor.user_id,
                conflict.copy,
              )
            ).notes,
          ).toBe(conflict.body);
        expect(proxy.unexpectedErrors).toBe(0);
        report = loadAcceptanceReportSchema.parse({
          version: 1,
          kind: 'controlled_sync_resilience',
          scope: 'synthetic_loopback_development_auth',
          execution:
            process.env.GITHUB_ACTIONS === 'true' ? 'github_actions' : 'local',
          source_commit:
            process.env.GITHUB_ACTIONS === 'true'
              ? process.env.GITHUB_SHA
              : null,
          observed_at: new Date().toISOString(),
          production_accepted: false,
          latency_scope: 'same_process_client_proxy_api_round_trip',
          cohort: {
            accounts: 2,
            devices: 4,
            initial_documents: 8,
            conflict_copies: 2,
            deleted_documents: 2,
          },
          committed_responses_lost: proxy.dropped,
          restart_scope: 'api_instances_database_pools_and_client_stores',
          server_restarts: serverRestarts,
          sync_attempt_latency: Object.fromEntries(
            Object.entries(timing).map(([phase, values]) => [
              phase,
              latencySummary(values),
            ]),
          ),
          burst: {
            requests: 128,
            concurrency: 8,
            accepted: latencySummary(accepted),
            rate_limited: latencySummary(limited),
          },
        });
      } finally {
        const cleanup = await Promise.allSettled(
          devices.map(async (device) => device.engine.stop()),
        );
        cleanup.push(
          ...(await Promise.allSettled(
            [...stores].map(async (store) => store.close()),
          )),
        );
        stores.clear();
        for (const device of devices) device.key.fill(0);
        cleanup.push(
          ...(await Promise.allSettled([proxy?.close(), stopApi()])),
          ...(await Promise.allSettled([
            (async () => {
              for (const name of await readdir(root)) {
                const bytes = await readFile(join(root, name));
                expect(bytes.includes(Buffer.from(privateMarker))).toBe(false);
              }
            })(),
            (async () => {
              if (createdSchema)
                await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
            })(),
          ])),
          ...(await Promise.allSettled([
            admin.close(),
            rm(root, { recursive: true, force: true }),
          ])),
        );
        const failures = cleanup.filter(
          (result) => result.status === 'rejected',
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'Controlled acceptance resource cleanup failed.',
          );
      }
      if (!report)
        throw new Error('No controlled acceptance result was produced.');
      const artifacts = fileURLToPath(
        new URL('../../../artifacts/', import.meta.url),
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, 'server-acceptance.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: 'wx' },
      );
    }, 120_000);
  },
);
