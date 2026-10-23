import { Database, requireDatabaseUrl } from '@windows-ai-notes/db';
import { loadAuthConfig } from './auth.js';
import { createServer } from './server.js';
import { loadStorageConfig, RecordingBlobs } from '@windows-ai-notes/storage';
import { loadLiveProvider } from './live-config.js';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import {
  DeletionArchive,
  loadDeletionArchiveConfig,
} from '@windows-ai-notes/storage/deletion';

async function main() {
  const config = loadAuthConfig();
  const port = Number(process.env.PORT ?? '4411');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535.');
  const storage = loadStorageConfig();
  const archiveConfig = loadDeletionArchiveConfig();
  const archive = archiveConfig ? new DeletionArchive(archiveConfig) : null;
  const db = new Database(requireDatabaseUrl(), archive ?? undefined);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer(
      db,
      config,
      storage ? new RecordingBlobs(storage) : null,
      loadLiveProvider(),
    );
    server.addHook('onClose', async () => {
      try {
        await db.close();
      } finally {
        archive?.close();
      }
    });
    const owned = server;
    const stop = () => {
      console.log(JSON.stringify({ code: 'api_stopping' }));
      db.deletions.close();
      void owned.close().catch(() => {
        console.error('api_shutdown_failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await server.listen({ host: config.host, port });
    console.log(
      JSON.stringify({ code: 'api_ready', port, auth_mode: config.mode }),
    );
  } catch (error) {
    if (server) await server.close();
    else {
      try {
        await db.close();
      } finally {
        archive?.close();
      }
    }
    throw error;
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof ServiceError && error.code.startsWith('deletion_')
      ? `${error.code}: ${error.message}`
      : 'api_start_failed: check migrations, authentication, independent deletion archive and private storage/live Speech configuration. Secrets were not logged.',
  );
  process.exitCode = 1;
});
