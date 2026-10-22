import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  deletionBatchSchema,
  type DeletionOrigin,
  type DeletionBatch,
} from '@windows-ai-notes/contracts/deletion';
import { RecordingBlobs, type StorageConfig } from './index.js';
import { DeletionArchive } from './deletion.js';

const endpoint = process.env.TEST_S3_ENDPOINT;
const DAY = 86_400_000;
const credentials = {
  accessKeyId: 'storage-test-only',
  secretAccessKey: 'storage-test-only-secret',
};
const signal = () => AbortSignal.timeout(30_000);
const origin = (): DeletionOrigin => ({
  deployment_id: randomUUID(),
  initialized_at: new Date().toISOString(),
});
const key = (value: DeletionOrigin, suffix: string) =>
  `deletion/v1/${value.deployment_id}/${suffix}`;
function batch(value: DeletionOrigin, count = 1): DeletionBatch {
  return deletionBatchSchema.parse({
    version: 1,
    id: randomUUID(),
    origin: value,
    entries: Array.from({ length: count }, () => ({
      id: randomUUID(),
      transaction_id: '9007199254740993',
      recorded_at: new Date().toISOString(),
      event: 'document_erased',
      resource_id: randomUUID(),
      workspace_id: null,
      expires_at: null,
      retention_days: null,
      processing_days: null,
      reason: null,
    })),
  });
}

it('requires explicit bounded retention and production TLS/encryption without reading unrelated configuration', () => {
  const config = {
    endpoint: 'http://127.0.0.1:59000',
    region: 'us-east-1',
    bucket: 'synthetic-archive',
    encryption: 'none' as const,
    credentials,
    mode: 'development' as const,
    retentionDays: 37,
  };
  const archive = new DeletionArchive(config);
  archive.close();
  for (const retentionDays of [0, 36, 37.5, 3651, NaN, Infinity])
    expect(() => new DeletionArchive({ ...config, retentionDays })).toThrow(
      '37-3650',
    );
  expect(
    () =>
      new DeletionArchive({
        ...config,
        mode: 'production',
        encryption: 'AES256',
      }),
  ).toThrow('HTTPS');
  expect(
    () =>
      new DeletionArchive({
        ...config,
        endpoint: 'https://archive.example.test',
        mode: 'production',
      }),
  ).toThrow('encryption');
});

describe.skipIf(!endpoint)('independent protected S3 deletion archive', () => {
  const bucket = `deletion-archive-${randomUUID()}`,
    buckets = new Set<string>();
  const config: StorageConfig = {
    endpoint: endpoint ?? 'http://127.0.0.1:59000',
    region: 'us-east-1',
    bucket,
    encryption: 'none',
    credentials,
  };
  const s3 = new S3Client({
    ...config,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  let archive: DeletionArchive, value: DeletionOrigin;
  const open = (name = bucket) =>
    new DeletionArchive({
      ...config,
      bucket: name,
      mode: 'development',
      retentionDays: 37,
    });
  async function create(name: string, days = 37, locked = true) {
    await s3.send(
      new CreateBucketCommand({
        Bucket: name,
        ...(locked ? { ObjectLockEnabledForBucket: true } : {}),
      }),
    );
    buckets.add(name);
    if (locked)
      await s3.send(
        new PutObjectLockConfigurationCommand({
          Bucket: name,
          ObjectLockConfiguration: {
            ObjectLockEnabled: 'Enabled',
            Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: days } },
          },
        }),
      );
  }
  async function poison(suffix: string, bytes: Buffer) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key(value, suffix),
        Body: bytes,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: new Date(Date.now() + 38 * DAY),
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
      }),
    );
  }
  beforeAll(async () => {
    await create(bucket);
  }, 30_000);
  beforeEach(async () => {
    value = origin();
    archive = open();
    await archive.assertReady(signal());
  });
  afterEach(() => {
    archive.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      for (const name of buckets) {
        for (let page = 0; page < 10_000; page++) {
          const listed = await s3.send(
            new ListObjectVersionsCommand({ Bucket: name, MaxKeys: 1000 }),
          );
          const versions = [
            ...(listed.Versions ?? []),
            ...(listed.DeleteMarkers ?? []),
          ];
          if (!versions.length) break;
          for (const version of versions) {
            if (!version.Key || !version.VersionId)
              throw new Error(
                'Synthetic archive cleanup received an incomplete version identity.',
              );
            await s3.send(
              new DeleteObjectCommand({
                Bucket: name,
                Key: version.Key,
                VersionId: version.VersionId,
                BypassGovernanceRetention: true,
              }),
            );
          }
          if (page === 9999)
            throw new Error(
              'Synthetic archive cleanup exceeded its version bound.',
            );
        }
        await s3.send(new DeleteBucketCommand({ Bucket: name }));
      }
    } finally {
      s3.destroy();
    }
  }, 60_000);

  it('requires private versioned Object Lock storage with sufficient retention and no expiring lifecycle', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cases = [
      'unversioned',
      'short-retention',
      'lifecycle',
      'public-policy',
    ] as const;
    for (const type of cases) {
      const name = `deletion-${type}-${randomUUID()}`;
      await create(
        name,
        type === 'short-retention' ? 36 : 37,
        type !== 'unversioned',
      );
      if (type === 'lifecycle')
        await s3.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: name,
            LifecycleConfiguration: {
              Rules: [
                {
                  ID: 'synthetic-expiry',
                  Status: 'Enabled',
                  Filter: { Prefix: '' },
                  Expiration: { Days: 90 },
                },
              ],
            },
          }),
        );
      if (type === 'public-policy')
        await s3.send(
          new PutBucketPolicyCommand({
            Bucket: name,
            Policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Principal: '*',
                  Action: 's3:GetObject',
                  Resource: `arn:aws:s3:::${name}/*`,
                },
              ],
            }),
          }),
        );
      const other = open(name);
      try {
        await expect(other.assertReady(signal())).rejects.toThrow();
        await expect(other.initialize(value, signal())).rejects.toMatchObject({
          code: 'deletion_archive_not_ready',
        });
      } finally {
        other.close();
      }
    }
    expect(JSON.stringify(logs.mock.calls)).not.toContain(
      credentials.secretAccessKey,
    );
  }, 30_000);

  it('does not weaken unversioned media deletion when sharing private access validation', async () => {
    const media = new RecordingBlobs(config);
    try {
      await expect(media.assertReady()).rejects.toThrow('unversioned');
    } finally {
      media.close();
    }
  });

  it('rejects missing archives, explicitly initializes a verifiable zero-entry genesis, and never resets an existing history', async () => {
    await expect(
      archive.verify(value, async () => {}, signal()),
    ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
    await expect(archive.append(batch(value), signal())).rejects.toMatchObject({
      code: 'deletion_archive_invalid',
    });
    expect(
      (
        await s3.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key(value, ''),
          }),
        )
      ).Versions ?? [],
    ).toHaveLength(0);
    const initial = await archive.initialize(value, signal());
    expect(initial).toMatchObject({
      origin: value,
      generation: '0',
      entry_references: '0',
      tip: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const visit = vi.fn(async () => {});
    expect(await archive.verify(value, visit, signal())).toEqual(initial);
    expect(visit).not.toHaveBeenCalled();
    const accepted = await archive.append(batch(value), signal());
    expect(await archive.initialize(value, signal())).toEqual(accepted);
  });

  it('preserves concurrent publishers and verifies every reachable batch against the genesis and exact reference counts', async () => {
    const other = open();
    try {
      await other.assertReady(signal());
      await archive.initialize(value, signal());
      const batches = Array.from({ length: 6 }, () => batch(value, 2));
      await Promise.all(
        batches.map((entry, index) =>
          (index % 2 ? archive : other).append(entry, signal()),
        ),
      );
      const read: DeletionBatch[] = [];
      const verified = await other.verify(
        value,
        async (entry) => {
          read.push(entry);
        },
        signal(),
      );
      expect(verified).toMatchObject({
        generation: '6',
        entry_references: '12',
      });
      expect(read.map((entry) => entry.id).sort()).toEqual(
        batches.map((entry) => entry.id).sort(),
      );
      expect(
        new Set(
          read.flatMap((entry) => entry.entries.map((intent) => intent.id)),
        ).size,
      ).toBe(12);
    } finally {
      other.close();
    }
  }, 30_000);

  it('binds immutable batch IDs to exact metadata and treats repeated publication as references, not distinct deletion counts', async () => {
    await archive.initialize(value, signal());
    const first = batch(value);
    await archive.append(first, signal());
    await archive.append(first, signal());
    const before = await archive.verify(value, async () => {}, signal());
    expect(before).toMatchObject({ generation: '2', entry_references: '2' });
    await expect(
      archive.append(
        {
          ...first,
          entries: [{ ...first.entries[0]!, resource_id: randomUUID() }],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'deletion_archive_conflict' });
    expect(await archive.verify(value, async () => {}, signal())).toEqual(
      before,
    );
    const versions = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key(value, `batches/${first.id}.json`),
      }),
    );
    expect(versions.Versions).toHaveLength(1);
  });

  it('rejects cross-lineage reads, writes and initialization without modifying the existing archive', async () => {
    const initial = await archive.initialize(value, signal());
    const wrong = {
      ...value,
      initialized_at: new Date(Date.now() + 1000).toISOString(),
    };
    await expect(archive.initialize(wrong, signal())).rejects.toMatchObject({
      code: 'deletion_archive_invalid',
    });
    await expect(archive.append(batch(wrong), signal())).rejects.toMatchObject({
      code: 'deletion_archive_invalid',
    });
    await expect(
      archive.verify(wrong, async () => {}, signal()),
    ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
    expect(await archive.verify(value, async () => {}, signal())).toEqual(
      initial,
    );
  });

  it.each(['rollback', 'fork'] as const)(
    'retains its observed history after a %s, failed scans and readiness rechecks',
    async (kind) => {
      const initial = await archive.initialize(value, signal());
      await archive.append(batch(value), signal());
      const acknowledged = await archive.append(batch(value), signal());
      await poison('head.json', Buffer.from(canonicalJson(initial)));
      if (kind === 'fork') {
        const other = open();
        try {
          await other.assertReady(signal());
          for (let index = 0; index < 3; index++)
            await other.append(batch(value), signal());
        } finally {
          other.close();
        }
      }
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          archive.verify(value, async () => {}, signal()),
        ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
      await archive.assertReady(signal());
      await expect(
        archive.append(batch(value), signal()),
      ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
      await poison('head.json', Buffer.from(canonicalJson(acknowledged)));
      expect(await archive.verify(value, async () => {}, signal())).toEqual(
        acknowledged,
      );
    },
  );

  it('does not share its trusted prefix with mutable returned heads', async () => {
    const returned = await archive.initialize(value, signal());
    returned.generation = '99';
    returned.origin.initialized_at = '1970-01-01T00:00:00.000Z';
    expect(await archive.append(batch(value), signal())).toMatchObject({
      origin: value,
      generation: '1',
      entry_references: '1',
    });
  });

  it.each(['head', 'genesis', 'link', 'batch'] as const)(
    'fails closed on missing %s instead of treating an incomplete archive as empty',
    async (missing) => {
      await archive.initialize(value, signal());
      const entry = batch(value),
        head = await archive.append(entry, signal());
      const suffix =
        missing === 'head'
          ? 'head.json'
          : missing === 'genesis'
            ? 'genesis.json'
            : missing === 'link'
              ? `links/${head.tip}.json`
              : `batches/${entry.id}.json`;
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key(value, suffix) }),
      );
      await expect(
        archive.verify(value, async () => {}, signal()),
      ).rejects.toThrow();
      await expect(archive.initialize(value, signal())).rejects.toThrow();
      const other = open();
      try {
        await other.assertReady(signal());
        await expect(other.append(batch(value), signal())).rejects.toThrow();
      } finally {
        other.close();
      }
    },
  );

  it('does not silently reinitialize a namespace whose head and genesis are both masked by delete markers', async () => {
    await archive.initialize(value, signal());
    await archive.append(batch(value), signal());
    for (const suffix of ['head.json', 'genesis.json'])
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key(value, suffix) }),
      );
    const before = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key(value, '') }),
    );
    await expect(archive.initialize(value, signal())).rejects.toThrow();
    const after = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key(value, '') }),
    );
    expect(after.DeleteMarkers?.length).toBe(before.DeleteMarkers?.length);
    expect(after.Versions?.length).toBe(before.Versions?.length);
  });

  it.each(['link', 'batch', 'head'] as const)(
    'detects corrupted %s bytes or chain counters without exposing private payloads in errors',
    async (changed) => {
      await archive.initialize(value, signal());
      const entry = batch(value),
        head = await archive.append(entry, signal());
      const suffix =
        changed === 'link'
          ? `links/${head.tip}.json`
          : changed === 'batch'
            ? `batches/${entry.id}.json`
            : 'head.json';
      const malformed =
        changed === 'head'
          ? { ...head, generation: '100', entry_references: '100' }
          : { notes: 'private-archive-meeting' };
      await poison(suffix, Buffer.from(canonicalJson(malformed)));
      await expect(
        archive.verify(value, async () => {}, signal()),
      ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
    },
  );

  it('does not report completion for a valid prefix when an older link is missing', async () => {
    const initial = await archive.initialize(value, signal());
    await archive.append(batch(value), signal());
    await archive.append(batch(value), signal());
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key(value, `links/${initial.tip}.json`),
      }),
    );
    const visit = vi.fn(async () => {});
    let released = false;
    await expect(
      (async () => {
        await archive.verify(value, visit, signal());
        released = true;
      })(),
    ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
    expect(visit).toHaveBeenCalledTimes(2);
    expect(released).toBe(false);
  });

  it('propagates consumer failures without misreporting a storage error, then allows complete re-verification', async () => {
    await archive.initialize(value, signal());
    await archive.append(batch(value), signal());
    const failure = new Error('private-replay-database-failure');
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      archive.verify(
        value,
        async () => {
          throw failure;
        },
        signal(),
      ),
    ).rejects.toBe(failure);
    expect(logs).not.toHaveBeenCalled();
    expect(await archive.verify(value, async () => {}, signal())).toMatchObject(
      { generation: '1', entry_references: '1' },
    );
  });

  it('keeps bounded or aborted partial replay unverified', async () => {
    await archive.initialize(value, signal());
    await archive.append(batch(value), signal());
    await expect(
      archive.verify(value, async () => {}, signal(), 1),
    ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
    const abort = new AbortController(),
      failure = new Error('synthetic-stop');
    await expect(
      archive.verify(
        value,
        async () => {
          abort.abort(failure);
        },
        abort.signal,
      ),
    ).rejects.toBe(failure);
    await expect(
      archive.verify(value, async () => {}, signal(), 0),
    ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
  });
});

it.each(['oversized', 'stalled'] as const)(
  'bounds an %s archive response and closes its reader',
  async (kind) => {
    const value = origin();
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://synthetic.test');
      if (request.method === 'HEAD') {
        response.writeHead(200).end();
        return;
      }
      response.setHeader('content-type', 'application/xml');
      if (url.searchParams.has('versioning'))
        response.end(
          '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
        );
      else if (url.searchParams.has('acl'))
        response.end(
          '<AccessControlPolicy><AccessControlList/></AccessControlPolicy>',
        );
      else if (url.searchParams.has('policy'))
        response
          .writeHead(404)
          .end('<Error><Code>NoSuchBucketPolicy</Code></Error>');
      else if (url.searchParams.has('object-lock'))
        response.end(
          '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>37</Days></DefaultRetention></Rule></ObjectLockConfiguration>',
        );
      else if (url.searchParams.has('lifecycle'))
        response
          .writeHead(404)
          .end('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>');
      else {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': kind === 'oversized' ? '8192' : '1000',
          etag: '"synthetic"',
          'last-modified': new Date().toUTCString(),
          'x-amz-object-lock-mode': 'GOVERNANCE',
          'x-amz-object-lock-retain-until-date': new Date(
            Date.now() + 38 * DAY,
          ).toISOString(),
        });
        if (kind === 'oversized') response.end(Buffer.alloc(8192));
        else response.write('{');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Synthetic archive server did not bind loopback.');
    const archive = new DeletionArchive({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: 'us-east-1',
      bucket: 'synthetic-archive',
      encryption: 'none',
      credentials,
      mode: 'development',
      retentionDays: 37,
    });
    try {
      await archive.assertReady(signal());
      if (kind === 'oversized')
        await expect(
          archive.verify(value, async () => {}, signal()),
        ).rejects.toMatchObject({ code: 'deletion_archive_invalid' });
      else
        await expect(
          archive.verify(value, async () => {}, AbortSignal.timeout(150)),
        ).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      archive.close();
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  },
);
