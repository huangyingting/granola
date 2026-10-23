import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { DeletionArchive } from '@windows-ai-notes/storage/deletion';
import { RecordingBlobs } from '@windows-ai-notes/storage';
import { resourceId, ServiceError } from '@windows-ai-notes/contracts/server';
import type { Database } from '@windows-ai-notes/db';

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

const legacyPitrReportSchema = z.strictObject({
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
});
export const pitrAcceptanceReportSchema = z
  .discriminatedUnion('version', [
    legacyPitrReportSchema,
    legacyPitrReportSchema.extend({
      version: z.literal(2),
      media_restore: z.literal('verified_synthetic_private_s3_round_trip'),
      source_media_removed: z.literal(true),
      media_backup_objects: z.literal(2),
      media_restored_objects: z.literal(2),
      retained_media_verified_chunks: z.literal(1),
      erased_media_purged_objects: z.literal(1),
      media_verified_before_exposure: z.literal(true),
    }),
  ])
  .refine((value) =>
    value.execution === 'github_actions'
      ? value.source_commit !== null
      : value.source_commit === null,
  );

function privatePitrEndpoint(endpoint: string) {
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
  return url.href;
}

export async function privatePitrArchive(endpoint: string) {
  const bucket = `notes-pitr-${randomUUID()}`;
  const config = {
    endpoint: privatePitrEndpoint(endpoint),
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

const mediaObjectSchema = z.strictObject({
  id: resourceId,
  kind: z.literal('verified'),
  size_bytes: z.number().int().min(46).max(960_044),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const mediaSnapshotSchema = z
  .array(mediaObjectSchema)
  .length(2)
  .refine(
    (objects) =>
      new Set(objects.map((object) => object.id)).size === objects.length,
  );

export async function privatePitrMedia(endpoint: string) {
  const config = {
    endpoint: privatePitrEndpoint(endpoint),
    region: 'us-east-1',
    encryption: 'none' as const,
    credentials,
  };
  const s3 = new S3Client({
    ...config,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const buckets: string[] = [],
    stores: RecordingBlobs[] = [];
  const signal = () => AbortSignal.timeout(10_000);
  let snapshot: z.infer<typeof mediaSnapshotSchema> | undefined;
  let sourceRemoved = false;
  async function create(role: string) {
    const bucket = `notes-pitr-${role}-${randomUUID()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }), {
      abortSignal: signal(),
    });
    buckets.push(bucket);
    const storage = new RecordingBlobs({ ...config, bucket });
    stores.push(storage);
    await storage.assertReady();
    return storage;
  }
  async function close() {
    const failures: unknown[] = [];
    for (const store of stores) {
      try {
        store.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      for (const bucket of [...buckets].reverse()) {
        try {
          for (let page = 0; page < 32; page++) {
            const result = await s3.send(
              new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }),
              { abortSignal: signal() },
            );
            if (!result.Contents?.length) break;
            for (const object of result.Contents) {
              if (!object.Key)
                throw new Error(
                  'An owned PITR media object has no exact identity.',
                );
              await s3.send(
                new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
                { abortSignal: signal() },
              );
            }
          }
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }), {
            abortSignal: signal(),
          });
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      s3.destroy();
    }
    if (failures.length)
      throw new AggregateError(failures, 'Owned PITR media cleanup failed.');
  }
  async function missing(
    storage: RecordingBlobs,
    object: z.infer<typeof mediaObjectSchema>,
  ) {
    await assert.rejects(
      async () => {
        const body = await storage.read(object, object.size_bytes, signal());
        body.fill(0);
      },
      (error: unknown) =>
        error instanceof ServiceError && error.code === 'upload_missing',
    );
  }
  async function transfer(
    from: RecordingBlobs,
    to: RecordingBlobs,
    objects: z.infer<typeof mediaSnapshotSchema>,
  ) {
    for (const object of objects) {
      const body = await from.read(object, object.size_bytes, signal());
      try {
        if (
          body.length !== object.size_bytes ||
          createHash('sha256').update(body).digest('hex') !== object.sha256
        )
          throw new Error(
            'Synthetic PITR source media failed its immutable checksum.',
          );
        await to.promote(object, body, signal());
        const copied = await to.read(object, object.size_bytes, signal());
        try {
          if (!copied.equals(body))
            throw new Error(
              'Synthetic PITR copied media differs from its source.',
            );
        } finally {
          copied.fill(0);
        }
      } finally {
        body.fill(0);
      }
    }
  }
  try {
    const source = await create('source'),
      backup = await create('backup'),
      restored = await create('restored');
    return {
      source,
      restored,
      close,
      async backup(objects: unknown) {
        if (snapshot)
          throw new Error(
            'The synthetic PITR media snapshot is already fixed.',
          );
        const parsed = mediaSnapshotSchema.parse(objects);
        await transfer(source, backup, parsed);
        snapshot = parsed;
      },
      async discardSource() {
        if (!snapshot)
          throw new Error(
            'A verified media snapshot is required before source removal.',
          );
        for (const object of snapshot) {
          await source.remove(object, signal());
          await missing(source, object);
        }
        sourceRemoved = true;
      },
      async restore() {
        if (!snapshot || !sourceRemoved)
          throw new Error(
            'PITR media restore requires a verified snapshot and removed source.',
          );
        await transfer(backup, restored, snapshot);
      },
      async assertErased(object: z.infer<typeof mediaObjectSchema>) {
        await missing(restored, object);
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'PITR media setup and cleanup failed.',
      );
    }
    throw error;
  }
}

export async function seedPitrRecording(
  db: Database,
  storage: RecordingBlobs,
  user: string,
  document: string,
) {
  const wav = Buffer.from(
    '524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000',
    'hex',
  );
  const recording = randomUUID(),
    track = randomUUID(),
    chunk = randomUUID();
  const object = mediaObjectSchema.parse({
    id: randomUUID(),
    kind: 'verified',
    size_bytes: wav.length,
    sha256: createHash('sha256').update(wav).digest('hex'),
  });
  try {
    await db.recordings.create(
      user,
      document,
      {
        id: recording,
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
        tracks: [
          {
            spec: {
              track_id: track,
              kind: 'microphone',
              capture_scope: 'endpoint',
              device_selection_policy: 'explicit',
              device_id: 'synthetic-pitr-device',
            },
            actual_device_id: 'synthetic-pitr-device',
          },
        ],
      },
      randomUUID(),
    );
    await db.recordings.register(
      user,
      recording,
      {
        chunk: {
          format_version: 1,
          recording_id: recording,
          track_id: track,
          chunk_id: chunk,
          capture_epoch: randomUUID(),
          sequence: 0,
          sample_start: 0,
          sample_count: 1,
          sample_rate: 16000,
          channels: 1,
          bits_per_sample: 16,
          clock_start_ms: 0,
          clock_end_ms: 1 / 16,
          pcm_sha256: createHash('sha256')
            .update(wav.subarray(44))
            .digest('hex'),
        },
        size_bytes: object.size_bytes,
        sha256: object.sha256,
      },
      randomUUID(),
    );
    await storage.promote(object, wav, AbortSignal.timeout(10_000));
    // Model established media; no live upload grant is issued or shortened.
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO recording_objects(id,recording_id,chunk_id,kind,created_at,protected_until,cleanup_after)
         VALUES($1,$2,$3,'verified',now()-interval '1 hour',now()-interval '30 minutes',now()-interval '30 minutes')`,
        [object.id, recording, chunk],
      );
      const changed = await tx.query(
        "UPDATE recording_chunks SET state='verified',verified_object=$2 WHERE id=$1 AND recording_id=$3",
        [chunk, object.id, recording],
      );
      if (changed.rowCount !== 1)
        throw new Error('The synthetic verified media row is missing.');
    });
    await db.recordings.seal(
      user,
      recording,
      {
        native_state: 'sealed',
        accept_incomplete: false,
        tracks: [{ track_id: track, end_sample: 1, chunk_ids: [chunk] }],
        events: [],
        gaps: [],
      },
      randomUUID(),
    );
    return { recording, object };
  } finally {
    wav.fill(0);
  }
}

export async function physicalPitrCluster({
  checkInitialization = false,
}: { checkInitialization?: boolean } = {}) {
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
  let bootstrapVerified = false;
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
            .object({
              Status: z.enum(['starting', 'healthy', 'unhealthy']),
              Log: z
                .array(
                  z.object({
                    Start: z.iso.datetime({ offset: true }),
                    ExitCode: z.number().int(),
                  }),
                )
                .nullable()
                .optional(),
            })
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
        'pg_isready -h 127.0.0.1 -U notes -d notes',
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
    if (role === 'primary' && checkInitialization) {
      const deadline = Date.now() + 30_000;
      let bootstrapProbe: string | null | undefined;
      while (Date.now() < deadline) {
        const value = await inspection(id);
        if (!value.State.Running)
          throw new Error(
            'The owned PostgreSQL stopped during bootstrap verification.',
          );
        const held = await docker(
          'exec',
          id,
          '/bin/sh',
          '-ec',
          'if test -f /archive/bootstrap-held; then printf held; fi',
        );
        const last = value.State.Health?.Log?.at(-1);
        if (held === 'held' && bootstrapProbe === undefined)
          bootstrapProbe = last?.Start ?? null;
        if (held === 'held' && last && last.Start !== bootstrapProbe) {
          await docker('exec', id, 'pg_isready', '-U', 'notes', '-d', 'notes');
          if (value.State.Health?.Status === 'healthy' || last.ExitCode !== 2)
            throw new Error(
              'PITR readiness accepted the temporary bootstrap server.',
            );
          bootstrapVerified = true;
          break;
        }
        await delay(100);
      }
      if (!bootstrapVerified)
        throw new Error(
          'The owned PostgreSQL bootstrap verification exceeded its bound.',
        );
      await docker('exec', id, 'touch', '/archive/bootstrap-release');
    }
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
          '--env',
          `PGPASSWORD=${password}`,
          id,
          'psql',
          '-X',
          '-h',
          '127.0.0.1',
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
${
  checkInitialization
    ? `mkdir -p /docker-entrypoint-initdb.d
printf '%s\\n' 'touch /archive/bootstrap-held' 'while test ! -f /archive/bootstrap-release; do sleep 0.1; done' > /docker-entrypoint-initdb.d/00-pitr-bootstrap.sh
`
    : ''
}
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
      bootstrapVerified,
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
