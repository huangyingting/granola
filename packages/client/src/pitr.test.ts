import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Database, digest } from '@windows-ai-notes/db';
import { createServer } from '@windows-ai-notes/api/server';
import {
  physicalPitrCluster,
  privatePitrArchive,
  pitrAcceptanceReportSchema,
} from './pitr.fixture.js';

const clusterIdentity = z.strictObject({
  cluster: z.string().regex(/^\d{1,20}$/),
  timeline: z.number().int().positive(),
});
const lsn = z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/);

it.each([
  'https://archive.example.test',
  'http://localhost:9000',
  'http://127.0.0.1',
  'http://127.0.0.1:0',
  'http://127.0.0.1:9000/other',
  'http://user@127.0.0.1:9000',
  'http://127.0.0.1:9000/?token=private',
  'http://127.0.0.1:9000/#fragment',
])(
  'refuses non-private or ambiguous PITR archive target %s before creating resources',
  async (endpoint) => {
    await expect(privatePitrArchive(endpoint)).rejects.toThrow(
      'private literal-loopback',
    );
  },
);

it('keeps synthetic PITR reports strict, source-bound and explicitly non-production', () => {
  const report = {
    version: 1,
    kind: 'controlled_postgresql_pitr',
    scope: 'synthetic_loopback_development_auth',
    execution: 'local',
    source_commit: null,
    production_accepted: false,
    backup_verified: true,
    post_backup_wal_replayed: true,
    later_primary_change_excluded: true,
    independent_deletion_replayed: true,
    new_usage_reservation_quarantined: true,
    usage_review: 'synthetic_no_provider_requests',
    provider_requests: 0,
    api_exposure: 'only_after_verified_replay_and_synthetic_review',
    media_restore: 'not_exercised',
    resources_cleaned: true,
  };
  expect(pitrAcceptanceReportSchema.safeParse(report).success).toBe(true);
  expect(
    pitrAcceptanceReportSchema.safeParse({
      ...report,
      execution: 'github_actions',
      source_commit: 'a'.repeat(40),
    }).success,
  ).toBe(true);
  for (const change of [
    { execution: 'github_actions' },
    { source_commit: 'a'.repeat(40) },
    { execution: 'github_actions', source_commit: 'invalid' },
    { production_accepted: true },
    { provider_requests: 1 },
    { backup_verified: false },
    { resources_cleaned: false },
    { media_restore: 'accepted' },
    { document_body: 'Must not enter an acceptance report.' },
  ]) {
    expect(
      pitrAcceptanceReportSchema.safeParse({ ...report, ...change }).success,
    ).toBe(false);
  }
});

describe.skipIf(process.env.SERVER_DATABASE_PITR_ACCEPTANCE !== '1')(
  'opt-in physical PostgreSQL backup and named-target WAL recovery',
  () => {
    it('rejects the temporary bootstrap server before admitting the initialized TCP database', async () => {
      const lab = await physicalPitrCluster({ checkInitialization: true });
      let db: Database | undefined;
      try {
        expect(lab.bootstrapVerified).toBe(true);
        db = new Database(lab.primary.url);
        expect(
          (
            await db.pool.query(
              'SELECT current_database() database, NOT pg_is_in_recovery() recovered',
            )
          ).rows[0],
        ).toEqual({ database: 'notes', recovered: true });
      } finally {
        try {
          await db?.close();
        } finally {
          await lab.close();
        }
      }
    }, 60_000);
    it('replays only the selected WAL history and independently restores deletion and usage gates before exposure', async () => {
      const endpoint = process.env.TEST_S3_ENDPOINT;
      if (!endpoint)
        throw new Error(
          'Physical PITR requires the private synthetic S3 fixture.',
        );
      const storage = await privatePitrArchive(endpoint);
      const archive = storage.open();
      let lab: Awaited<ReturnType<typeof physicalPitrCluster>> | undefined;
      let primary: Database | undefined, restored: Database | undefined;
      let app: Awaited<ReturnType<typeof createServer>> | undefined;
      let report:
        ReturnType<typeof pitrAcceptanceReportSchema.parse> | undefined;
      const failures: unknown[] = [];
      const signal = () => AbortSignal.timeout(60_000);
      try {
        lab = await physicalPitrCluster();
        primary = new Database(lab.primary.url, archive);
        await primary.migrate();
        const subject = randomUUID();
        const actor = await primary.provision(
          'urn:windows-ai-notes:development',
          subject,
        );
        const kept = await primary.createDocument(
          actor.user_id,
          {
            workspace_id: actor.workspace_id,
            title: 'Synthetic retained PITR document',
            notes: 'Present in the physical base backup.',
          },
          randomUUID(),
        );
        const erasedId = randomUUID();
        const erasedInput = {
          id: erasedId,
          workspace_id: actor.workspace_id,
          title: 'Synthetic deletion recovery canary',
          notes: 'Must never be exposed after recovery.',
        };
        const erasedKey = randomUUID();
        await primary.createDocument(actor.user_id, erasedInput, erasedKey);
        await primary.enqueueSummary(
          actor.user_id,
          kept.id,
          {
            note_revision: 1,
            transcript_revision: 0,
            language: 'en',
          },
          randomUUID(),
        );
        await primary.deletions.initialize(signal());
        const before = clusterIdentity.parse(
          (
            await primary.pool.query(
              'SELECT (pg_control_system()).system_identifier::text cluster, (pg_control_checkpoint()).timeline_id timeline',
            )
          ).rows[0],
        );
        await lab.backup();
        const backupEnd = lsn.parse(
          (await primary.pool.query('SELECT pg_current_wal_lsn() lsn')).rows[0]
            ?.lsn,
        );
        await primary.edit(
          actor.user_id,
          kept.id,
          1,
          {
            notes:
              'Committed after base backup and before the WAL recovery target.',
          },
          randomUUID(),
        );
        const target = `notes_pitr_${randomUUID().replaceAll('-', '')}`;
        const checkpoint = lsn.parse(
          (
            await primary.pool.query('SELECT pg_create_restore_point($1) lsn', [
              target,
            ])
          ).rows[0]?.lsn,
        );
        expect(
          (
            await primary.pool.query(
              'SELECT $1::pg_lsn > $2::pg_lsn replay_required',
              [checkpoint, backupEnd],
            )
          ).rows[0].replay_required,
        ).toBe(true);
        await primary.edit(
          actor.user_id,
          kept.id,
          2,
          {
            notes:
              'Committed after the target and intentionally excluded by PITR.',
          },
          randomUUID(),
        );
        await primary.deleteDocument(actor.user_id, erasedId);
        expect(
          (
            await primary.pool.query(
              'SELECT count(*)::int count FROM ai_usage_calls',
            )
          ).rows[0].count,
        ).toBe(0);
        const segment = (
          await primary.pool.query(
            'SELECT pg_walfile_name(pg_current_wal_lsn()) segment',
          )
        ).rows[0].segment;
        await primary.pool.query('SELECT pg_switch_wal()');
        await lab.assertArchived(segment);
        await primary.close();
        primary = undefined;
        const recovered = await lab.restore(target);
        restored = new Database(recovered.url, archive);
        const after = clusterIdentity.parse(
          (
            await restored.pool.query(
              'SELECT (pg_control_system()).system_identifier::text cluster, (pg_control_checkpoint()).timeline_id timeline',
            )
          ).rows[0],
        );
        expect(after.cluster).toBe(before.cluster);
        expect(after.timeline).toBeGreaterThan(before.timeline);
        expect(await restored.document(actor.user_id, kept.id)).toMatchObject({
          revision: 2,
          notes:
            'Committed after base backup and before the WAL recovery target.',
        });
        expect(
          (
            await restored.pool.query(
              'SELECT deleted_at FROM documents WHERE id=$1',
              [erasedId],
            )
          ).rows[0],
        ).toEqual({ deleted_at: null });
        await expect(
          restored.deletions.recover(signal(), true),
        ).rejects.toMatchObject({
          code: 'deletion_usage_review_required',
        });
        await expect(
          restored.document(actor.user_id, erasedId),
        ).rejects.toMatchObject({
          code: 'document_not_found',
        });
        const claimed = await restored.claim();
        expect(claimed?.documentId).toBe(kept.id);
        if (!claimed) throw new Error('The restored synthetic job is missing.');
        await expect(
          restored.usage.start(claimed, {
            operation: 'summary',
            provider: 'fixture',
            configurationVersion: 'synthetic-pitr-no-provider',
            budget: { input_tokens: 1, output_tokens: 1, audio_ms: 0 },
          }),
        ).rejects.toMatchObject({ code: 'deletion_usage_review_required' });
        expect(
          (
            await restored.pool.query(
              'SELECT count(*)::int count FROM ai_usage_calls',
            )
          ).rows[0].count,
        ).toBe(0);
        app = await createServer(restored, {
          mode: 'development',
          host: '127.0.0.1',
        });
        await expect(
          app.listen({ host: '127.0.0.1', port: 0 }),
        ).rejects.toMatchObject({
          code: 'deletion_usage_review_required',
        });
        expect(app.server.listening).toBe(false);
        await app.close();
        app = undefined;
        await restored.deletions.reviewUsage(
          digest(
            {
              scope: 'synthetic-no-provider-dispatch',
              source_usage_calls: 0,
              restored_usage_calls: 0,
              provider_requests: 0,
            },
            true,
          ),
          signal(),
        );
        await restored.assertReady();
        await expect(
          restored.createDocument(actor.user_id, erasedInput, erasedKey),
        ).rejects.toMatchObject({
          code: 'document_not_found',
        });
        await expect(
          restored.createDocument(actor.user_id, erasedInput, randomUUID()),
        ).rejects.toMatchObject({
          code: 'resource_gone',
        });
        app = await createServer(restored, {
          mode: 'development',
          host: '127.0.0.1',
        });
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const response = await fetch(`${origin}/v1/documents/${erasedId}`, {
          headers: { 'x-dev-subject': subject },
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(erasedInput.notes);
        report = pitrAcceptanceReportSchema.parse({
          version: 1,
          kind: 'controlled_postgresql_pitr',
          scope: 'synthetic_loopback_development_auth',
          execution:
            process.env.GITHUB_ACTIONS === 'true' ? 'github_actions' : 'local',
          source_commit:
            process.env.GITHUB_ACTIONS === 'true'
              ? process.env.GITHUB_SHA
              : null,
          production_accepted: false,
          backup_verified: true,
          post_backup_wal_replayed: true,
          later_primary_change_excluded: true,
          independent_deletion_replayed: true,
          new_usage_reservation_quarantined: true,
          usage_review: 'synthetic_no_provider_requests',
          provider_requests: 0,
          api_exposure: 'only_after_verified_replay_and_synthetic_review',
          media_restore: 'not_exercised',
          resources_cleaned: true,
        });
      } catch (error) {
        failures.push(error);
      } finally {
        const cleanup: PromiseSettledResult<unknown>[] =
          await Promise.allSettled([app?.close()]);
        cleanup.push(
          ...(await Promise.allSettled([primary?.close(), restored?.close()])),
        );
        cleanup.push(
          ...(await Promise.allSettled([
            Promise.resolve().then(() => archive.close()),
            lab?.close(),
            storage.close(),
          ])),
        );
        failures.push(
          ...cleanup
            .filter((value) => value.status === 'rejected')
            .map((value) => value.reason),
        );
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, 'Physical PITR and cleanup failed.');
      if (!report)
        throw new Error('Physical PITR produced no accepted result.');
      const file = fileURLToPath(
        new URL(
          '../../../artifacts/database-pitr-acceptance.json',
          import.meta.url,
        ),
      );
      await mkdir(
        fileURLToPath(new URL('../../../artifacts/', import.meta.url)),
        { recursive: true },
      );
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
      });
    }, 180_000);
  },
);
