import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  aiLimitsSchema,
  resourceId,
  ServiceError,
} from '@windows-ai-notes/contracts/server';
import { Database, requireDatabaseUrl } from './index.js';
import { audioRetentionPolicySchema } from '@windows-ai-notes/contracts/uploads';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      issuer: { type: 'string' },
      subject: { type: 'string' },
      'workspace-id': { type: 'string' },
      'workspace-name': { type: 'string', default: 'My workspace' },
      dev: { type: 'boolean', default: false },
      'user-id': { type: 'string' },
      'audio-ms': { type: 'string' },
      'input-tokens': { type: 'string' },
      'output-tokens': { type: 'string' },
      'retention-days': { type: 'string' },
      'processing-days': { type: 'string' },
    },
  });
  const database = new Database(requireDatabaseUrl());
  try {
    if (positionals.length !== 1)
      throw new Error(
        'Choose migrate, provision, usage-limits or audio-retention.',
      );
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
    } else if (positionals[0] === 'usage-limits') {
      const user = resourceId.parse(values['user-id']);
      const fields = ['audio-ms', 'input-tokens', 'output-tokens'] as const;
      if (fields.some((field) => !/^[0-9]{1,13}$/.test(values[field] ?? '')))
        throw new ServiceError(
          'invalid_limits',
          'Supply --user-id, --audio-ms, --input-tokens and --output-tokens as decimal monthly allowances; zero disables a unit.',
          400,
        );
      const limits = aiLimitsSchema.parse({
        audio_ms: Number(values['audio-ms']),
        input_tokens: Number(values['input-tokens']),
        output_tokens: Number(values['output-tokens']),
      });
      console.log(JSON.stringify(await database.usage.setLimits(user, limits)));
    } else if (positionals[0] === 'audio-retention') {
      const workspace = resourceId.parse(values['workspace-id']);
      const fields = ['retention-days', 'processing-days'] as const;
      if (fields.some((field) => !/^[0-9]{1,2}$/.test(values[field] ?? '')))
        throw new ServiceError(
          'invalid_retention',
          'Supply --workspace-id, --retention-days (0-7) and --processing-days (1-30).',
          400,
        );
      const policy = audioRetentionPolicySchema.parse({
        retention_days: Number(values['retention-days']),
        processing_days: Number(values['processing-days']),
      });
      console.log(
        JSON.stringify(
          await database.recordings.setRetentionPolicy(workspace, policy),
        ),
      );
    } else
      throw new Error(
        'Choose migrate, provision, usage-limits or audio-retention.',
      );
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
