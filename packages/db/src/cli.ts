import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  aiLimitsSchema,
  resourceId,
  ServiceError,
} from '@windows-ai-notes/contracts/server';
import { Database, requireDatabaseUrl, withAuditContext } from './index.js';
import { audioRetentionPolicySchema } from '@windows-ai-notes/contracts/uploads';
import { auditQuerySchema } from '@windows-ai-notes/contracts/audit';
import {
  DeletionArchive,
  loadDeletionArchiveConfig,
} from '@windows-ai-notes/storage/deletion';

async function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
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
      before: { type: 'string' },
      limit: { type: 'string' },
      'restored-backup': { type: 'boolean' },
      'proof-sha256': { type: 'string' },
    },
  });
  const archiveConfig = loadDeletionArchiveConfig(process.env, false);
  const archive = archiveConfig ? new DeletionArchive(archiveConfig) : null;
  const database = new Database(requireDatabaseUrl(), archive ?? undefined);
  try {
    if (positionals.length !== 1)
      throw new Error(
        'Choose migrate, provision, usage-limits, audio-retention, operations, task-outcomes, audit, deletion-init, deletion-recover or deletion-usage-reviewed.',
      );
    if (positionals[0] === 'migrate') {
      await database.migrate();
      console.log('Database migrations applied.');
    } else if (positionals[0] === 'deletion-init') {
      if (tokens.some((token) => token.kind === 'option'))
        throw new Error('Deletion initialization does not accept options.');
      await database.assertSchemaReady();
      console.log(
        JSON.stringify(
          await database.deletions.initialize(AbortSignal.timeout(300_000)),
        ),
      );
    } else if (positionals[0] === 'deletion-recover') {
      if (
        !values['restored-backup'] ||
        tokens.some(
          (token) =>
            token.kind === 'option' && token.name !== 'restored-backup',
        )
      )
        throw new Error(
          'Explicit restore recovery requires --restored-backup, stopped writers and subsequent provider-usage reconciliation.',
        );
      await database.assertSchemaReady();
      await database.deletions.recover(AbortSignal.timeout(300_000), true);
      console.log('Verified deletion recovery completed.');
    } else if (positionals[0] === 'deletion-usage-reviewed') {
      if (
        !values['proof-sha256'] ||
        tokens.some(
          (token) => token.kind === 'option' && token.name !== 'proof-sha256',
        )
      )
        throw new Error(
          'Usage review requires only --proof-sha256 from completed authoritative provider-usage reconciliation.',
        );
      await database.assertSchemaReady();
      await database.deletions.reviewUsage(
        values['proof-sha256'],
        AbortSignal.timeout(300_000),
      );
      console.log(
        'Usage reconciliation attested and independent recovery reverified.',
      );
    } else if (positionals[0] === 'operations') {
      if (tokens.some((token) => token.kind === 'option'))
        throw new ServiceError(
          'invalid_operations',
          'Operations is deployment-wide and does not accept filters or other options.',
          400,
        );
      console.log(JSON.stringify(await database.operations()));
    } else if (positionals[0] === 'task-outcomes') {
      if (tokens.some((token) => token.kind === 'option'))
        throw new ServiceError(
          'invalid_task_outcomes',
          'Task outcomes are deployment-wide and do not accept filters or other options.',
          400,
        );
      console.log(JSON.stringify(await database.taskOutcomes()));
    } else if (positionals[0] === 'audit') {
      if (
        tokens.some(
          (token) =>
            token.kind === 'option' &&
            !['before', 'limit'].includes(token.name),
        )
      )
        throw new ServiceError(
          'invalid_audit',
          'Audit inspection accepts only --before and --limit (1-100).',
          400,
        );
      const query = auditQuerySchema.parse({
        before: values.before,
        limit: values.limit,
      });
      console.log(JSON.stringify(await database.audit.page(query)));
    } else if (positionals[0] === 'provision') {
      await database.assertReady();
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
      await database.assertReady();
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
      await database.assertReady();
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
        'Choose migrate, provision, usage-limits, audio-retention, operations, task-outcomes, audit, deletion-init, deletion-recover or deletion-usage-reviewed.',
      );
  } finally {
    try {
      await database.close();
    } finally {
      archive?.close();
    }
  }
}
withAuditContext({ source: 'deployment' }, main).catch((error: unknown) => {
  console.error(
    error instanceof ServiceError
      ? `${error.code}: ${error.message}`
      : 'Database command failed. Check configuration, migrations, and command arguments; connection details were not logged.',
  );
  process.exitCode = 1;
});
