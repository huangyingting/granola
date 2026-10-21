import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resourceId, ServiceError } from '@windows-ai-notes/contracts/server';
import { Database, requireDatabaseUrl } from './index.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      issuer: { type: 'string' },
      subject: { type: 'string' },
      'workspace-id': { type: 'string' },
      'workspace-name': { type: 'string', default: 'My workspace' },
      dev: { type: 'boolean', default: false },
    },
  });
  const database = new Database(requireDatabaseUrl());
  try {
    if (positionals.length !== 1)
      throw new Error('Choose migrate or provision.');
    if (positionals[0] === 'migrate') {
      await database.migrate();
      console.log('Database migrations applied.');
    } else if (positionals[0] === 'provision') {
      if (values.dev && process.env.NODE_ENV === 'production')
        throw new Error(
          'Development identity provisioning is disabled in production.',
        );
      const issuer = values.dev
        ? 'urn:windows-ai-notes:development'
        : values.issuer;
      const subject = values.dev ? randomUUID() : values.subject;
      if (!issuer || !subject)
        throw new Error(
          'Provision requires --issuer and --subject, or explicit --dev for local development.',
        );
      if (values['workspace-id']) resourceId.parse(values['workspace-id']);
      const result = await database.provision(
        issuer,
        subject,
        values['workspace-id'],
        values['workspace-name'],
      );
      console.log(
        JSON.stringify({
          ...result,
          ...(values.dev ? { development_subject: subject } : {}),
        }),
      );
    } else throw new Error('Choose migrate or provision.');
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof ServiceError
      ? `${error.code}: ${error.message}`
      : 'Database command failed. Check configuration, migrations, and command arguments; connection details were not logged.',
  );
  process.exitCode = 1;
});
