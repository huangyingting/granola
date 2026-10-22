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

async function main() {
  const providers = createAzureProviders(loadAzureConfig());
  const db = new Database(requireDatabaseUrl());
  const config = loadStorageConfig();
  const storage = config ? new RecordingBlobs(config) : null;
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  let nextCleanup = 0;
  const closeTelemetry = registerProviderTelemetry();
  try {
    await db.assertReady();
    await storage?.assertReady();
    console.log(
      JSON.stringify({ code: 'worker_ready', provider: providers.provider }),
    );
    while (!shutdown.signal.aborted) {
      try {
        if (Date.now() >= nextCleanup) {
          await db.cleanup();
          nextCleanup = Date.now() + 60_000;
        }
        if (!(await runOnce(db, providers, shutdown.signal, storage)))
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
    closeTelemetry();
    storage?.close();
    await db.close();
  }
}
withAuditContext({ source: 'worker' }, main).catch(() => {
  console.error(
    'worker_start_failed: check Azure/storage configuration and database migrations. Secrets were not logged.',
  );
  process.exitCode = 1;
});
