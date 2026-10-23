import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { DeletionArchive } from '@windows-ai-notes/storage/deletion';

const identifier = z.string().regex(/^[a-f0-9]{64}$/);
const imageIdentifier = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const credentials = {
  accessKeyId: 'storage-test-only',
  secretAccessKey: 'storage-test-only-secret',
};
const password = 'pitr-synthetic-test-only';
async function docker(...args: string[]) {
  return (
    await promisify(execFile)('docker', args, {
      timeout: 60_000,
      maxBuffer: 1_048_576,
    })
  ).stdout.trim();
}

export const pitrAcceptanceReportSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('controlled_postgresql_pitr'),
    scope: z.literal('synthetic_loopback_development_auth'),
    execution: z.enum(['local', 'github_actions']),
    source_commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    production_accepted: z.literal(false),
    backup_verified: z.literal(true),
    post_backup_wal_replayed: z.literal(true),
    later_primary_change_excluded: z.literal(true),
    independent_deletion_replayed: z.literal(true),
    new_usage_reservation_quarantined: z.literal(true),
    usage_review: z.literal('synthetic_no_provider_requests'),
    provider_requests: z.literal(0),
    api_exposure: z.literal('only_after_verified_replay_and_synthetic_review'),
    media_restore: z.literal('not_exercised'),
    resources_cleaned: z.literal(true),
  })
  .refine((value) =>
    value.execution === 'github_actions'
      ? value.source_commit !== null
      : value.source_commit === null,
  );

export async function privatePitrArchive(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) < 1 ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'PITR requires a private literal-loopback synthetic S3 store.',
    );
  const bucket = `notes-pitr-${randomUUID()}`;
  const config = {
    endpoint: url.href,
    region: 'us-east-1',
    bucket,
    encryption: 'none' as const,
    credentials,
    mode: 'development' as const,
    retentionDays: 37,
  };
  const s3 = new S3Client({
    ...config,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  let created = false;
  const options = () => ({ abortSignal: AbortSignal.timeout(10_000) });
  async function close() {
    try {
      if (!created) return;
      for (let page = 0; page < 32; page++) {
        const result = await s3.send(
          new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
          options(),
        );
        const versions = [
          ...(result.Versions ?? []),
          ...(result.DeleteMarkers ?? []),
        ];
        if (!versions.length) {
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }), options());
          return;
        }
        for (const version of versions) {
          if (!version.Key || !version.VersionId)
            throw new Error(
              'A synthetic archive version has no exact identity.',
            );
          await s3.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: version.Key,
              VersionId: version.VersionId,
              BypassGovernanceRetention: true,
            }),
            options(),
          );
        }
      }
      throw new Error('Owned synthetic archive cleanup exceeded its bound.');
    } finally {
      s3.destroy();
    }
  }
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ObjectLockEnabledForBucket: true,
      }),
      options(),
    );
    created = true;
    await s3.send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucket,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 37 } },
        },
      }),
      options(),
    );
    return { open: () => new DeletionArchive(config), close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Synthetic archive setup and cleanup failed.',
      );
    }
    throw error;
  }
}

export async function physicalPitrCluster() {
  if (process.platform !== 'linux')
    throw new Error('Physical PITR acceptance requires isolated Linux Docker.');
  const image = imageIdentifier.parse(
    await docker(
      'image',
      'inspect',
      'postgres:16-alpine',
      '--format',
      '{{.Id}}',
    ),
  );
  const token = randomUUID().replaceAll('-', '');
  const label = 'windows-ai-notes.pitr';
  const owned: string[] = [];
  const volumes = new Set<string>();
  const inspection = async (id: string) => {
    const value = z
      .object({
        Id: z.literal(id),
        Image: z.literal(image),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        HostConfig: z.object({ AutoRemove: z.literal(false) }),
        State: z.object({
          Running: z.boolean(),
          Health: z
            .object({ Status: z.enum(['starting', 'healthy', 'unhealthy']) })
            .optional(),
        }),
        NetworkSettings: z.object({
          Ports: z
            .record(
              z.string(),
              z
                .array(
                  z.object({
                    HostIp: z.string(),
                    HostPort: z.string(),
                  }),
                )
                .nullable(),
            )
            .nullable(),
        }),
        Mounts: z
          .array(
            z.object({
              Type: z.literal('volume'),
              Name: identifier,
              Destination: z.string(),
            }),
          )
          .max(3),
      })
      .parse(
        JSON.parse(
          await docker(
            'inspect',
            '--format',
            '{{json .}}',
            identifier.parse(id),
          ),
        ),
      );
    if (value.Config.Labels[label] !== token)
      throw new Error('The PITR container does not match its owned identity.');
    for (const mount of value.Mounts) volumes.add(mount.Name);
    return value;
  };
  async function close() {
    const failures: unknown[] = [];
    for (const id of [...owned].reverse()) {
      try {
        await inspection(id);
        await docker('rm', '--force', '--volumes', id);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const volume of volumes) {
      try {
        const remaining = await docker(
          'volume',
          'ls',
          '--quiet',
          '--filter',
          `name=^${volume}$`,
        );
        if (remaining)
          throw new Error('An owned physical PITR volume was not removed.');
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Owned PITR container cleanup failed.',
      );
  }
  async function start(
    role: 'primary' | 'restored',
    mounts: string[],
    script: string,
  ) {
    const id = identifier.parse(
      await docker(
        'create',
        '--name',
        `notes-pitr-${token}-${role}`,
        '--label',
        `${label}=${token}`,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_USER=notes',
        '--env',
        'POSTGRES_DB=notes',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--health-cmd',
        'pg_isready -U notes -d notes',
        '--health-interval',
        '1s',
        '--health-timeout',
        '3s',
        '--health-retries',
        '30',
        ...mounts,
        '--entrypoint',
        '/bin/sh',
        image,
        '-ec',
        script,
      ),
    );
    owned.push(id);
    await inspection(id);
    await docker('start', id);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await inspection(id);
      if (!value.State.Running)
        throw new Error(
          `The owned ${role} PostgreSQL stopped before readiness.`,
        );
      if (
        value.State.Health?.Status === 'healthy' &&
        (await docker(
          'exec',
          id,
          'psql',
          '-U',
          'notes',
          '-d',
          'notes',
          '-Atc',
          'SELECT NOT pg_is_in_recovery()',
        )) === 't'
      ) {
        const ports = value.NetworkSettings.Ports?.['5432/tcp'];
        const binding = ports?.[0];
        if (ports?.length !== 1 || !binding || binding.HostIp !== '127.0.0.1')
          throw new Error('PITR publication is not private literal-loopback.');
        const port = z.coerce
          .number()
          .int()
          .min(1)
          .max(65535)
          .parse(binding.HostPort);
        return {
          id,
          url: `postgres://notes:${password}@127.0.0.1:${port}/notes`,
        };
      }
      await delay(100);
    }
    throw new Error(`The owned ${role} PostgreSQL exceeded its startup bound.`);
  }
  try {
    const primary = await start(
      'primary',
      ['--volume', '/archive', '--volume', '/backup'],
      `chown postgres:postgres /archive /backup
chmod 700 /archive /backup
exec /usr/local/bin/docker-entrypoint.sh postgres -c wal_level=replica -c archive_mode=on -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f"`,
    );
    const value = await inspection(primary.id);
    const volume = (destination: string) => {
      const mount = value.Mounts.find(
        (entry) => entry.Destination === destination,
      );
      if (mount?.Type !== 'volume')
        throw new Error(
          'PITR requires fresh Docker volumes, never external bind mounts.',
        );
      return identifier.parse(mount.Name);
    };
    const backup = volume('/backup'),
      archive = volume('/archive');
    volume('/var/lib/postgresql/data');
    return {
      primary,
      close,
      async backup() {
        await docker(
          'exec',
          '--user',
          'postgres',
          '--env',
          `PGPASSWORD=${password}`,
          primary.id,
          'pg_basebackup',
          '-h',
          '127.0.0.1',
          '-U',
          'notes',
          '-D',
          '/backup/base',
          '-X',
          'stream',
          '-c',
          'fast',
          '--manifest-checksums=SHA256',
        );
        await docker(
          'exec',
          '--user',
          'postgres',
          primary.id,
          'pg_verifybackup',
          '/backup/base',
        );
      },
      async assertArchived(segment: string) {
        if (!/^[0-9A-F]{24}$/.test(segment))
          throw new Error(
            'An exact PostgreSQL WAL segment identity is required.',
          );
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const files = await docker(
            'exec',
            primary.id,
            'ls',
            '-1',
            '/var/lib/postgresql/data/pg_wal/archive_status',
          );
          if (files.split('\n').includes(`${segment}.done`)) {
            await docker(
              'exec',
              primary.id,
              'test',
              '-s',
              `/archive/${segment}`,
            );
            return;
          }
          await delay(100);
        }
        throw new Error('The post-backup WAL segment was not archived.');
      },
      async restore(target: string) {
        if (!/^notes_pitr_[a-f0-9]{32}$/.test(target))
          throw new Error('A fresh bounded recovery-target name is required.');
        await docker('stop', '--timeout', '10', primary.id);
        return start(
          'restored',
          [
            '--mount',
            `type=volume,source=${backup},target=/backup,readonly`,
            '--mount',
            `type=volume,source=${archive},target=/archive,readonly`,
          ],
          `test -z "$(ls -A /var/lib/postgresql/data)"
cp -a /backup/base/. /var/lib/postgresql/data/
printf '%s\\n' "restore_command = 'cp /archive/%f %p'" "recovery_target_name = '${target}'" "recovery_target_action = 'promote'" >> /var/lib/postgresql/data/postgresql.auto.conf
touch /var/lib/postgresql/data/recovery.signal
chown -R postgres:postgres /var/lib/postgresql/data
exec /usr/local/bin/docker-entrypoint.sh postgres`,
        );
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Owned PITR setup and cleanup failed.',
      );
    }
    throw error;
  }
}
