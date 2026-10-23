import { setTimeout as delay } from 'node:timers/promises';
import { createAzureProviders } from '@windows-ai-notes/ai';
import { loadAzureConfig } from '@windows-ai-notes/ai/config';
import { registerProviderTelemetry } from '@windows-ai-notes/ai/observability';
import {
  Database,
  requireDatabaseUrl,
  withAuditContext,
} from '@windows-ai-notes/db';
import { runOnce } from './worker.js';
import { loadStorageConfig, RecordingBlobs } from '@windows-ai-notes/storage';
import { workerObservability } from './observability.js';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import {
  DeletionArchive,
  loadDeletionArchiveConfig,
} from '@windows-ai-notes/storage/deletion';

async function main() {
  const providers = createAzureProviders(loadAzureConfig());
  const config = loadStorageConfig();
  const archiveConfig = loadDeletionArchiveConfig();
  const archive = archiveConfig ? new DeletionArchive(archiveConfig) : null;
  const db = new Database(requireDatabaseUrl(), archive ?? undefined);
  const storage = config ? new RecordingBlobs(config) : null;
  const shutdown = new AbortController();
  const stop = () => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    console.log(JSON.stringify({ code: 'worker_stopping' }));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let nextCleanup = 0;
  const closeTelemetry = registerProviderTelemetry();
  const observations = workerObservability();
  try {
    await db.assertReady(shutdown.signal);
    if (shutdown.signal.aborted) return;
    await storage?.assertReady();
    if (shutdown.signal.aborted) return;
    console.log(
      JSON.stringify({ code: 'worker_ready', provider: providers.provider }),
    );
    while (!shutdown.signal.aborted) {
      try {
        if (Date.now() >= nextCleanup) {
          await db.cleanup();
          nextCleanup = Date.now() + 60_000;
        }
        if (
          !(await runOnce(
            db,
            providers,
            shutdown.signal,
            storage,
            observations,
          ))
        )
          await delay(500, undefined, { signal: shutdown.signal });
      } catch (error) {
        if (shutdown.signal.aborted) break;
        console.error(
          JSON.stringify({
            code: 'worker_iteration_failed',
            kind: error instanceof Error ? 'error' : 'unknown',
          }),
        );
        await delay(1000);
      }
    }
  } finally {
    observations.close();
    closeTelemetry();
    storage?.close();
    try {
      await db.close();
    } finally {
      archive?.close();
    }
  }
}
withAuditContext({ source: 'worker' }, main).catch((error: unknown) => {
  console.error(
    error instanceof ServiceError && error.code.startsWith('deletion_')
      ? `${error.code}: ${error.message}`
      : 'worker_start_failed: check Azure/storage, independent deletion archive and database migrations. Secrets were not logged.',
  );
  process.exitCode = 1;
});
