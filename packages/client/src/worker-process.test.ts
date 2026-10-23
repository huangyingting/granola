import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Database } from '@windows-ai-notes/db';
import { jobSchema } from '@windows-ai-notes/contracts/server';
import { summaryProgressSchema } from '@windows-ai-notes/contracts/evidence';
import { ApiClient } from './http.js';
import { acceptanceDatabaseUrl } from './load.fixture.js';
import { launchService, unusedServicePort } from './service-process.fixture.js';
import { workerProvider } from './worker-provider.fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl || process.platform !== 'linux')(
  'physical Worker loss with the real lease clock and local TLS provider wire',
  () => {
    let schema: string, directory: string, scoped: URL;
    let admin: Database | undefined,
      db: Database | undefined,
      provider: Awaited<ReturnType<typeof workerProvider>> | undefined;
    let created = false;
    const children: ReturnType<typeof launchService>[] = [];
    function database() {
      if (!db) throw new Error('The isolated Worker database is not open.');
      return db;
    }
    function wire() {
      if (!provider) throw new Error('The private TLS provider is not open.');
      return provider;
    }
    async function start(entry: 'api' | 'worker') {
      const url = new URL(scoped);
      url.searchParams.set('application_name', `${schema}_${entry}`);
      const child = launchService(url.href, await unusedServicePort(), entry, {
        durationMs: 240_000,
        ...(entry === 'worker' ? { proxy: wire().proxy } : {}),
      });
      children.push(child);
      await child.observed(`${entry}_ready`);
      return child;
    }
    async function dispatched() {
      const subject = randomUUID();
      const actor = await database().provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const document = await database().createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic physical Worker recovery',
          notes: 'Only this frozen synthetic evidence may be summarized.',
        },
        randomUUID(),
      );
      const apiProcess = await start('api');
      const api = new ApiClient(
        apiProcess.base,
        async () => ({ 'x-dev-subject': subject }),
        { allowLoopback: true },
      );
      const job = await api.request(
        `/v1/documents/${document.id}/summary-runs`,
        jobSchema,
        {
          method: 'POST',
          key: randomUUID(),
          body: { note_revision: 1, transcript_revision: 0, language: 'en' },
        },
      );
      const worker = await start('worker');
      await vi.waitFor(
        () => {
          expect(wire().unexpected).toBe(0);
          expect(wire().requests).toHaveLength(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      const request = wire().requests[0];
      if (!request)
        throw new Error('The accepted synthetic dispatch is missing.');
      expect(request.snapshot).toMatchObject({
        document_id: document.id,
        note_revision: 1,
        notes: document.notes,
      });
      return { actor, document, api, job, worker, request };
    }
    async function stopChildren() {
      for (const child of children) {
        if (child.result) continue;
        expect(child.child.kill('SIGTERM')).toBe(true);
        expect(await child.exit()).toEqual({
          code: 0,
          signal: null,
          error: undefined,
        });
      }
      expect(wire().unexpected).toBe(0);
    }
    beforeEach(async () => {
      if (!databaseUrl)
        throw new Error('An isolated literal-loopback PostgreSQL is required.');
      schema = `notes_worker_process_${randomUUID().replaceAll('-', '')}`;
      directory = await mkdtemp(join(tmpdir(), 'notes-worker-process-'));
      scoped = acceptanceDatabaseUrl(databaseUrl);
      admin = new Database(scoped.href);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(scoped.href);
      await db.migrate();
      provider = await workerProvider(directory);
    });
    afterEach(async () => {
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(
        children.splice(0).map(async (child) => {
          if (!child.result) child.child.kill('SIGKILL');
          await child.closed;
        }),
      );
      results.push(
        ...(await Promise.allSettled([provider?.close(), db?.close()])),
        ...(await Promise.allSettled([
          (async () => {
            if (created && admin)
              await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
          })(),
          rm(directory, { recursive: true, force: true }),
        ])),
        ...(await Promise.allSettled([admin?.close()])),
      );
      provider = undefined;
      db = undefined;
      admin = undefined;
      created = false;
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Owned Worker recovery fixture cleanup failed.',
        );
    });
    describe.each([false, true])(
      'in-flight interruption with a received usage receipt = %s',
      (received) => {
        it.each(['cancel', 'SIGTERM', 'SIGINT'] as const)(
          'drains %s without publishing and preserves honest accounting',
          async (interruption) => {
            const { actor, document, api, job, worker, request } =
              await dispatched();
            const control = await database().pool.connect();
            let locked = false;
            try {
              if (received) {
                await control.query('BEGIN');
                locked = true;
                expect(
                  (
                    await control.query(
                      'SELECT owner_id FROM ai_usage_periods WHERE owner_id=$1 FOR UPDATE',
                      [actor.user_id],
                    )
                  ).rowCount,
                ).toBe(1);
                const owner = z
                  .object({ pid: z.number().int().positive() })
                  .parse(
                    (await control.query('SELECT pg_backend_pid() pid'))
                      .rows[0],
                  );
                request.complete();
                await vi.waitFor(
                  async () =>
                    expect(
                      (
                        await database().pool.query(
                          `SELECT 1 FROM pg_stat_activity
                           WHERE application_name=$1 AND state='active'
                           AND wait_event_type='Lock'
                           AND $2=ANY(pg_blocking_pids(pid))
                           AND query LIKE '%FROM ai_usage_periods%FOR UPDATE%'`,
                          [`${schema}_worker`, owner.pid],
                        )
                      ).rowCount,
                    ).toBe(1),
                  { timeout: 10_000, interval: 20 },
                );
              }
              if (interruption === 'cancel') {
                expect(
                  await api.request(
                    `/v1/jobs/${job.id}/cancel`,
                    z.object({
                      already_terminal: z.literal(false),
                      job: jobSchema,
                    }),
                    { method: 'POST' },
                  ),
                ).toMatchObject({
                  job: { state: 'cancelled', result: null },
                });
              } else {
                expect(worker.child.kill(interruption)).toBe(true);
                await worker.observed('worker_stopping');
                if (received) expect(worker.result).toBeUndefined();
              }
              if (locked) {
                await control.query('ROLLBACK');
                locked = false;
              }
              if (interruption === 'cancel') {
                await worker.observed('worker_attempt_completed');
                expect(worker.stdout).toContain('"completion":"fenced"');
              } else {
                expect(await worker.exit()).toEqual({
                  code: 0,
                  signal: null,
                  error: undefined,
                });
                expect(worker.stdout).toContain('"completion":"failed"');
                await start('worker');
              }
              if (!received)
                await vi.waitFor(() => expect(request.closed).toBe(true));
              expect(
                await api.request(`/v1/jobs/${job.id}`, jobSchema),
              ).toMatchObject({
                state: interruption === 'cancel' ? 'cancelled' : 'failed',
                result: null,
                ...(interruption === 'cancel'
                  ? {}
                  : {
                      error: {
                        code: 'worker_restarting',
                        retryable: false,
                      },
                    }),
              });
              expect(
                await database().usage.snapshot(actor.user_id),
              ).toMatchObject({
                settled_requests: received ? '1' : '0',
                uncertain_requests: received ? '0' : '1',
                settled: {
                  input_tokens: received ? '5' : '0',
                  output_tokens: received ? '4' : '0',
                  audio_ms: '0',
                },
                uncertain: {
                  input_tokens: received ? '0' : '64000',
                  output_tokens: received ? '0' : '4096',
                  audio_ms: '0',
                },
              });
              expect(
                await api.request(
                  `/v1/jobs/${job.id}/summary-progress`,
                  summaryProgressSchema,
                ),
              ).toMatchObject({
                completed_stages: 0,
                provider_requests: 1,
                uncertain_requests: received ? 0 : 1,
                resume_available: interruption !== 'cancel',
              });
              expect(
                await database().document(actor.user_id, document.id),
              ).toMatchObject({
                notes: document.notes,
                revision: 1,
              });
              expect(
                (
                  await database().pool.query(
                    "SELECT count(*)::text count FROM job_events WHERE job_id=$1 AND event_type='output.completed'",
                    [job.id],
                  )
                ).rows,
              ).toEqual([{ count: '0' }]);
              await stopChildren();
              expect(wire().requests).toHaveLength(1);
            } finally {
              try {
                if (locked) await control.query('ROLLBACK');
              } finally {
                control.release();
              }
            }
          },
          30_000,
        );
      },
    );
    it.each(['SIGKILL', 'SIGSTOP'] as const)(
      'retains uncertain paid dispatch after %s and requires consent before one replacement result',
      async (signal) => {
        const {
          actor,
          document,
          api,
          job,
          worker: original,
          request: first,
        } = await dispatched();
        const lease = z
          .object({
            lease_token: z.number().int().positive(),
            live: z.literal(true),
            remaining_ms: z.number().int().min(110_000).max(120_000),
          })
          .parse(
            (
              await database().pool.query(
                `SELECT lease_token,lease_until>clock_timestamp() live,
                 floor(extract(epoch FROM lease_until-clock_timestamp())*1000)::integer remaining_ms
                 FROM jobs WHERE id=$1`,
                [job.id],
              )
            ).rows[0],
          );
        expect(
          (
            await database().pool.query(
              `SELECT s.state,s.lease_token,c.actual IS NULL uncertain
               FROM summary_steps s JOIN ai_usage_calls c ON c.id=s.call_id
               WHERE s.job_id=$1`,
              [job.id],
            )
          ).rows,
        ).toEqual([
          {
            state: 'sending',
            lease_token: String(lease.lease_token),
            uncertain: true,
          },
        ]);
        expect(original.child.kill(signal)).toBe(true);
        if (signal === 'SIGKILL') {
          expect(await original.exit()).toEqual({
            code: null,
            signal: 'SIGKILL',
            error: undefined,
          });
          await vi.waitFor(() => expect(first.closed).toBe(true));
        } else {
          const pid = original.child.pid;
          if (!pid) throw new Error('The owned Worker PID is unavailable.');
          await vi.waitFor(async () =>
            expect(await readFile(`/proc/${pid}/status`, 'utf8')).toMatch(
              /^State:\s+T/m,
            ),
          );
        }
        const replacement = await start('worker');
        await vi.waitFor(
          async () => {
            expect(replacement.result).toBeUndefined();
            expect(await database().job(actor.user_id, job.id)).toMatchObject({
              state: 'failed',
              error: { code: 'summary_dispatch_unconfirmed' },
            });
          },
          { timeout: 150_000, interval: 500 },
        );
        expect(replacement.stdout).toContain('"reclaimed_lease":true');
        expect(wire().requests).toHaveLength(1);
        expect(
          (
            await database().pool.query(
              'SELECT lease_token FROM jobs WHERE id=$1',
              [job.id],
            )
          ).rows[0].lease_token,
        ).toBeGreaterThan(lease.lease_token);
        const reserved = {
          input_tokens: '64000',
          output_tokens: '4096',
          audio_ms: '0',
        };
        expect(await database().usage.snapshot(actor.user_id)).toMatchObject({
          uncertain_requests: '1',
          settled_requests: '0',
          uncertain: reserved,
        });
        const progress = await api.request(
          `/v1/jobs/${job.id}/summary-progress`,
          summaryProgressSchema,
        );
        expect(progress).toMatchObject({
          provider_requests: 1,
          uncertain_requests: 1,
          completed_stages: 0,
          resume_available: true,
        });
        const token = progress.resume_token;
        if (!token)
          throw new Error('Explicit summary resume consent is unavailable.');
        const resume = () =>
          api.request(`/v1/jobs/${job.id}/retry`, jobSchema, {
            method: 'POST',
            body: { confirmed: true, resume_token: token },
          });
        await Promise.all([resume(), resume()]);
        await vi.waitFor(
          () => {
            expect(wire().unexpected).toBe(0);
            expect(wire().requests).toHaveLength(2);
          },
          { timeout: 10_000, interval: 25 },
        );
        const second = wire().requests[1];
        if (!second)
          throw new Error('The consented replacement dispatch is missing.');
        expect(second.snapshot).toEqual(first.snapshot);
        expect(second.requestId).not.toBe(first.requestId);
        second.complete();
        await vi.waitFor(
          async () =>
            expect(await database().job(actor.user_id, job.id)).toMatchObject({
              state: 'succeeded',
              result: {
                kind: 'summary',
                summary: { overview: { text: document.notes } },
                usage: { input_tokens: 5, output_tokens: 4, audio_ms: 0 },
              },
            }),
          { timeout: 10_000, interval: 50 },
        );
        const completed = await database().job(actor.user_id, job.id);
        if (signal === 'SIGSTOP') {
          expect(original.child.kill('SIGCONT')).toBe(true);
          await original.observed('worker_attempt_completed');
          expect(original.stdout).toContain('"completion":"fenced"');
          await vi.waitFor(() => expect(first.closed).toBe(true));
        }
        expect(await resume()).toEqual(completed);
        expect(wire().requests).toHaveLength(2);
        expect(wire().unexpected).toBe(0);
        expect(await database().usage.snapshot(actor.user_id)).toMatchObject({
          uncertain_requests: '1',
          settled_requests: '1',
          uncertain: reserved,
          settled: { input_tokens: '5', output_tokens: '4', audio_ms: '0' },
        });
        expect(
          await api.request(
            `/v1/jobs/${job.id}/summary-progress`,
            summaryProgressSchema,
          ),
        ).toMatchObject({
          provider_requests: 2,
          uncertain_requests: 1,
          completed_stages: 1,
          resume_available: false,
        });
        expect(
          await database().document(actor.user_id, document.id),
        ).toMatchObject({
          revision: 1,
          notes: document.notes,
        });
        expect(
          (
            await database().pool.query(
              "SELECT count(*)::text count FROM job_events WHERE job_id=$1 AND event_type='output.completed'",
              [job.id],
            )
          ).rows,
        ).toEqual([{ count: '1' }]);
        expect(
          (
            await database().pool.query(
              'SELECT count(*)::text count FROM summary_resumes WHERE job_id=$1',
              [job.id],
            )
          ).rows,
        ).toEqual([{ count: '1' }]);
        await stopChildren();
        expect(wire().requests).toHaveLength(2);
        expect(wire().unexpected).toBe(0);
      },
      210_000,
    );
  },
);
