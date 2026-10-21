import { Database, requireDatabaseUrl } from '@windows-ai-notes/db';
import { loadAuthConfig } from './auth.js';
import { createServer } from './server.js';

async function main() {
  const config = loadAuthConfig();
  const port = Number(process.env.PORT ?? '4411');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535.');
  const db = new Database(requireDatabaseUrl());
  const server = await createServer(db, config);
  server.addHook('onClose', async () => db.close());
  const stop = () => {
    void server.close().catch(() => {
      console.error('api_shutdown_failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await db.assertReady();
    await server.listen({ host: config.host, port });
    console.log(
      JSON.stringify({ code: 'api_ready', port, auth_mode: config.mode }),
    );
  } catch (error) {
    await server.close();
    throw error;
  }
}
main().catch(() => {
  console.error(
    'api_start_failed: check database migration, bind address and authentication configuration. Secrets were not logged.',
  );
  process.exitCode = 1;
});
