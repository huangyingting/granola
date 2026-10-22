import { createHash } from 'node:crypto';
import { Readable, addAbortSignal } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  S3Client,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectVersionsCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import {
  deletionOriginSchema,
  deletionBatchSchema,
  deletionArchiveHeadSchema,
  deletionArchiveLinkSchema,
  type DeletionOrigin,
  type DeletionBatch,
  type DeletionArchiveHead,
  type DeletionArchiveLink,
} from '@windows-ai-notes/contracts/deletion';
import { loadStorageConfig, type StorageConfig } from './index.js';
import {
  assertPrivateBucketAccess,
  objectStoreStatus,
} from './private-bucket.js';

const DAY = 86_400_000;
const MAX_BODY = 128 * 1024;
export interface DeletionArchiveConfig extends StorageConfig {
  mode: 'development' | 'production';
  retentionDays: number;
}
export function loadDeletionArchiveConfig(
  environment: NodeJS.ProcessEnv = process.env,
  required = environment.NODE_ENV === 'production',
): DeletionArchiveConfig | null {
  const names = [
    'ENDPOINT',
    'REGION',
    'BUCKET',
    'ENCRYPTION',
    'KMS_KEY_ID',
    'ACCESS_KEY_ID',
    'SECRET_ACCESS_KEY',
    'RETENTION_DAYS',
  ];
  if (
    !names.some((name) => environment[`DELETION_ARCHIVE_${name}`] !== undefined)
  ) {
    if (required)
      throw new Error(
        'Configure independent DELETION_ARCHIVE storage before production startup.',
      );
    return null;
  }
  const days = environment.DELETION_ARCHIVE_RETENTION_DAYS;
  if (
    !days ||
    days !== days.trim() ||
    !/^[0-9]{2,4}$/.test(days) ||
    Number(days) < 37 ||
    Number(days) > 3650
  )
    throw new Error(
      'DELETION_ARCHIVE_RETENTION_DAYS must cover backup and recovery retention (37-3650 days).',
    );
  const storage = loadStorageConfig({
    NODE_ENV: environment.NODE_ENV,
    S3_ENDPOINT: environment.DELETION_ARCHIVE_ENDPOINT,
    S3_REGION: environment.DELETION_ARCHIVE_REGION,
    S3_BUCKET: environment.DELETION_ARCHIVE_BUCKET,
    S3_ENCRYPTION: environment.DELETION_ARCHIVE_ENCRYPTION,
    S3_KMS_KEY_ID: environment.DELETION_ARCHIVE_KMS_KEY_ID,
    S3_ACCESS_KEY_ID: environment.DELETION_ARCHIVE_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: environment.DELETION_ARCHIVE_SECRET_ACCESS_KEY,
  });
  if (!storage)
    throw new Error('Configure independent deletion archive storage.');
  if (
    storage.bucket === environment.S3_BUCKET &&
    storage.endpoint ===
      (environment.S3_ENDPOINT
        ? new URL(environment.S3_ENDPOINT).origin
        : undefined)
  )
    throw new Error(
      'Deletion archives must not share the recording media bucket.',
    );
  if (
    environment.NODE_ENV === 'production' &&
    storage.credentials &&
    storage.credentials.accessKeyId === environment.S3_ACCESS_KEY_ID &&
    storage.credentials.secretAccessKey === environment.S3_SECRET_ACCESS_KEY
  )
    throw new Error(
      'Use independently scoped deletion archive credentials, not recording media credentials.',
    );
  return {
    ...storage,
    mode: environment.NODE_ENV === 'production' ? 'production' : 'development',
    retentionDays: Number(days),
  };
}
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(canonicalJson(value));
function invalid(stage: string): never {
  throw new ServiceError(
    'deletion_archive_invalid',
    `Deletion archive ${stage} verification failed. Keep restored services offline.`,
    503,
  );
}
function decode(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) invalid('JSON');
    throw error;
  }
}
function etag(value: string | undefined): string {
  if (
    !value ||
    value.length < 3 ||
    value.length > 256 ||
    !value.startsWith('"') ||
    !value.endsWith('"') ||
    /[^\x21-\x7e]/.test(value) ||
    value.slice(1, -1).includes('"')
  )
    invalid('ETag');
  return value;
}
function origin(value: unknown): DeletionOrigin {
  const parsed = deletionOriginSchema.safeParse(value);
  if (!parsed.success) invalid('origin');
  return parsed.data;
}
function sameOrigin(left: DeletionOrigin, right: DeletionOrigin) {
  if (
    left.deployment_id !== right.deployment_id ||
    left.initialized_at !== right.initialized_at
  )
    invalid('lineage');
}
function genesis(value: DeletionOrigin): DeletionArchiveLink {
  return {
    version: 1,
    kind: 'genesis',
    origin: value,
    generation: '0',
    entry_references: '0',
    previous: null,
  };
}
type Stored = { bytes: Buffer; etag: string };
class VisitorFailure extends Error {
  constructor(readonly original: unknown) {
    super('Deletion archive visitor failed.');
  }
}

export class DeletionArchive {
  readonly identity: string;
  private readonly client: S3Client;
  private readonly config: DeletionArchiveConfig;
  private ready = false;
  private verified: DeletionArchiveHead | undefined;
  private shortcut = false;
  constructor(value: DeletionArchiveConfig) {
    if (
      !['development', 'production'].includes(value.mode) ||
      !Number.isSafeInteger(value.retentionDays) ||
      value.retentionDays < 37 ||
      value.retentionDays > 3650
    )
      throw new Error(
        'Choose a deletion archive mode and retention of 37-3650 days covering the longest backup and recovery window.',
      );
    const storage = loadStorageConfig({
      NODE_ENV: value.mode,
      S3_ENDPOINT: value.endpoint,
      S3_REGION: value.region,
      S3_BUCKET: value.bucket,
      S3_ENCRYPTION: value.encryption,
      ...(value.kmsKeyId ? { S3_KMS_KEY_ID: value.kmsKeyId } : {}),
      ...(value.credentials
        ? {
            S3_ACCESS_KEY_ID: value.credentials.accessKeyId,
            S3_SECRET_ACCESS_KEY: value.credentials.secretAccessKey,
          }
        : {}),
    });
    if (!storage)
      throw new Error('Configure independent deletion archive storage.');
    this.config = {
      ...storage,
      mode: value.mode,
      retentionDays: value.retentionDays,
    };
    this.identity = digest(
      encode({
        version: 1,
        endpoint: storage.endpoint,
        region: storage.region,
        bucket: storage.bucket,
      }),
    );
    this.client = new S3Client({
      ...storage,
      forcePathStyle: true,
      maxAttempts: 2,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  close() {
    this.ready = false;
    this.verified = undefined;
    this.shortcut = false;
    this.client.destroy();
  }
  private mode(): 'COMPLIANCE' | 'GOVERNANCE' {
    return this.config.mode === 'production' ? 'COMPLIANCE' : 'GOVERNANCE';
  }
  private checkReady() {
    if (!this.ready)
      throw new ServiceError(
        'deletion_archive_not_ready',
        'Verify independent deletion archive protection before use.',
        503,
      );
  }
  private async protect<T>(
    operation: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      return await work();
    } catch (error) {
      this.shortcut = false;
      signal.throwIfAborted();
      if (error instanceof VisitorFailure) throw error.original;
      if (error instanceof ServiceError) throw error;
      console.error(
        JSON.stringify({ code: 'deletion_archive_storage_failed', operation }),
      );
      throw new ServiceError(
        'deletion_archive_unavailable',
        'Independent deletion storage is unavailable. Do not acknowledge deletion or expose restored services.',
        503,
        true,
      );
    }
  }
  async assertReady(signal: AbortSignal) {
    this.ready = false;
    this.shortcut = false;
    return this.protect('readiness', signal, async () => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const input = { Bucket: this.config.bucket };
      await this.client.send(new HeadBucketCommand(input), {
        abortSignal: bounded,
      });
      const versioning = await this.client.send(
        new GetBucketVersioningCommand(input),
        { abortSignal: bounded },
      );
      if (versioning.Status !== 'Enabled') invalid('versioning');
      await assertPrivateBucketAccess(this.client, this.config.bucket, bounded);
      const lock = (
        await this.client.send(new GetObjectLockConfigurationCommand(input), {
          abortSignal: bounded,
        })
      ).ObjectLockConfiguration;
      const retention = lock?.Rule?.DefaultRetention;
      const days =
        retention?.Days ??
        (retention?.Years === undefined ? NaN : retention.Years * 365);
      if (
        lock?.ObjectLockEnabled !== 'Enabled' ||
        retention?.Mode !== this.mode() ||
        !Number.isSafeInteger(days) ||
        days < this.config.retentionDays ||
        (retention?.Days !== undefined && retention.Years !== undefined)
      )
        invalid('retention');
      try {
        const lifecycle = await this.client.send(
          new GetBucketLifecycleConfigurationCommand(input),
          { abortSignal: bounded },
        );
        if (
          lifecycle.Rules?.some(
            (rule) =>
              rule.Status === 'Enabled' &&
              (rule.Expiration !== undefined ||
                rule.NoncurrentVersionExpiration !== undefined),
          )
        )
          invalid('lifecycle');
      } catch (error) {
        if (!(
          objectStoreStatus(error) === 404 &&
          error instanceof Error &&
          error.name === 'NoSuchLifecycleConfiguration'
        ))
          throw error;
      }
      this.ready = true;
    });
  }
  private key(value: DeletionOrigin, suffix: string) {
    return `deletion/v1/${value.deployment_id}/${suffix}`;
  }
  private async read(
    key: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Stored | null> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: bounded },
      );
    } catch (error) {
      if (objectStoreStatus(error) === 404) return null;
      throw error;
    }
    if (!(output.Body instanceof Readable)) invalid('body');
    const body = addAbortSignal(bounded, output.Body);
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      const modified = output.LastModified?.getTime(),
        until = output.ObjectLockRetainUntilDate?.getTime();
      if (
        output.ObjectLockMode !== this.mode() ||
        modified === undefined ||
        until === undefined ||
        !Number.isFinite(modified) ||
        !Number.isFinite(until) ||
        until - modified < this.config.retentionDays * DAY ||
        (this.config.encryption !== 'none' &&
          output.ServerSideEncryption !== this.config.encryption)
      )
        invalid('object protection');
      if (output.ContentLength !== undefined && output.ContentLength > limit)
        invalid('body size');
      for await (const chunk of body) {
        if (!Buffer.isBuffer(chunk)) invalid('body encoding');
        length += chunk.length;
        if (length > limit) {
          chunk.fill(0);
          invalid('body size');
        }
        chunks.push(chunk);
      }
      bounded.throwIfAborted();
      if (!length) invalid('empty body');
      return { bytes: Buffer.concat(chunks, length), etag: etag(output.ETag) };
    } finally {
      body.destroy();
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  private async put(
    key: string,
    bytes: Buffer,
    condition: { IfNoneMatch: '*' } | { IfMatch: string },
    signal: AbortSignal,
  ) {
    if (!bytes.length || bytes.length > MAX_BODY) invalid('write size');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: 'application/json',
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        ...condition,
        ObjectLockMode: this.mode(),
        ObjectLockRetainUntilDate: new Date(
          Date.now() + (this.config.retentionDays + 1) * DAY,
        ),
        ...(this.config.encryption === 'none'
          ? {}
          : { ServerSideEncryption: this.config.encryption }),
        ...(this.config.kmsKeyId ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
      }),
      { abortSignal: signal },
    );
  }
  private async immutable(
    key: string,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.put(key, bytes, { IfNoneMatch: '*' }, signal);
        return true;
      } catch (error) {
        if (objectStoreStatus(error) === 409) {
          await delay(20 * (attempt + 1), undefined, { signal });
          continue;
        }
        if (objectStoreStatus(error) !== 412) throw error;
        const existing = await this.read(key, MAX_BODY, signal);
        try {
          if (!existing || !existing.bytes.equals(bytes))
            throw new ServiceError(
              'deletion_archive_conflict',
              'An immutable deletion archive object has conflicting metadata.',
              503,
            );
          return false;
        } finally {
          existing?.bytes.fill(0);
        }
      }
    }
    throw new ServiceError(
      'deletion_archive_busy',
      'Independent deletion storage is busy. Retry without acknowledging deletion.',
      503,
      true,
    );
  }
  private async head(value: DeletionOrigin, signal: AbortSignal) {
    const stored = await this.read(this.key(value, 'head.json'), 4096, signal);
    if (!stored)
      throw new ServiceError(
        'deletion_archive_uninitialized',
        'The independent archive head is missing. Do not initialize from a restored database.',
        503,
      );
    try {
      const parsed = deletionArchiveHeadSchema.safeParse(decode(stored.bytes));
      if (!parsed.success) invalid('head');
      sameOrigin(value, parsed.data.origin);
      return { head: parsed.data, etag: stored.etag };
    } finally {
      stored.bytes.fill(0);
    }
  }
  private async checkGenesis(value: DeletionOrigin, signal: AbortSignal) {
    const expected = encode(genesis(value));
    const marker = await this.read(
      this.key(value, 'genesis.json'),
      4096,
      signal,
    );
    try {
      if (!marker || !marker.bytes.equals(expected)) invalid('genesis');
      return digest(expected);
    } finally {
      expected.fill(0);
      marker?.bytes.fill(0);
    }
  }
  async initialize(
    input: DeletionOrigin,
    signal: AbortSignal,
    fresh = false,
  ): Promise<DeletionArchiveHead> {
    this.checkReady();
    const value = origin(input);
    return this.protect('initialize', signal, async () => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const existing = () => {
        if (fresh)
          throw new ServiceError(
            'deletion_archive_exists',
            'Fresh deployment initialization requires an unused archive namespace. Do not reinitialize a restored or partially initialized deployment.',
            503,
          );
        return this.verify(value, async () => {}, bounded);
      };
      const namespace = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.bucket,
          Prefix: fresh ? 'deletion/v1/' : this.key(value, ''),
          MaxKeys: 1,
        }),
        { abortSignal: bounded },
      );
      if (namespace.Versions?.length || namespace.DeleteMarkers?.length)
        return existing();
      if (namespace.IsTruncated !== false) invalid('namespace listing');
      const bytes = encode(genesis(value));
      try {
        const created = await this.immutable(
          this.key(value, 'genesis.json'),
          bytes,
          bounded,
        );
        if (!created) return existing();
        const tip = digest(bytes);
        await this.immutable(
          this.key(value, `links/${tip}.json`),
          bytes,
          bounded,
        );
        const head: DeletionArchiveHead = {
          version: 1,
          origin: value,
          generation: '0',
          entry_references: '0',
          tip,
        };
        await this.put(
          this.key(value, 'head.json'),
          encode(head),
          { IfNoneMatch: '*' },
          bounded,
        );
        this.remember(head);
        return head;
      } finally {
        bytes.fill(0);
      }
    });
  }
  async append(
    input: DeletionBatch,
    signal: AbortSignal,
  ): Promise<DeletionArchiveHead> {
    this.checkReady();
    const parsed = deletionBatchSchema.safeParse(input);
    if (!parsed.success) invalid('batch input');
    const batch = parsed.data;
    return this.protect('append', signal, async () => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const root = await this.checkGenesis(batch.origin, bounded);
      const bytes = encode(batch);
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const trusted = this.prefix(batch.origin),
            shortcut = this.shortcut;
          const previous = await this.head(batch.origin, bounded);
          await this.walk(
            batch.origin,
            previous.head,
            root,
            async () => {},
            bounded,
            10_000,
            trusted,
            shortcut,
          );
          this.remember(previous.head);
          if (attempt === 0)
            await this.immutable(
              this.key(batch.origin, `batches/${batch.id}.json`),
              bytes,
              bounded,
            );
          const link: DeletionArchiveLink = {
            version: 1,
            kind: 'batch',
            origin: batch.origin,
            generation: (BigInt(previous.head.generation) + 1n).toString(),
            entry_references: (
              BigInt(previous.head.entry_references) +
              BigInt(batch.entries.length)
            ).toString(),
            previous: previous.head.tip,
            batch_id: batch.id,
            batch_sha256: digest(bytes),
            batch_entries: batch.entries.length,
          };
          if (!deletionArchiveLinkSchema.safeParse(link).success)
            invalid('counter capacity');
          const encoded = encode(link),
            tip = digest(encoded);
          try {
            await this.immutable(
              this.key(batch.origin, `links/${tip}.json`),
              encoded,
              bounded,
            );
          } finally {
            encoded.fill(0);
          }
          const head: DeletionArchiveHead = {
            version: 1,
            origin: batch.origin,
            generation: link.generation,
            entry_references: link.entry_references,
            tip,
          };
          try {
            await this.put(
              this.key(batch.origin, 'head.json'),
              encode(head),
              { IfMatch: previous.etag },
              bounded,
            );
            this.remember(head);
            return head;
          } catch (error) {
            if (![409, 412].includes(objectStoreStatus(error) ?? 0))
              throw error;
            await delay(20 * (attempt + 1), undefined, { signal: bounded });
          }
        }
        throw new ServiceError(
          'deletion_archive_busy',
          'Concurrent archive updates did not settle. Retry without acknowledging deletion.',
          503,
          true,
        );
      } finally {
        bytes.fill(0);
      }
    });
  }
  async verify(
    input: DeletionOrigin,
    visit: (batch: DeletionBatch, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    maxLinks = 10_000,
    required?: DeletionArchiveHead,
  ): Promise<DeletionArchiveHead> {
    this.checkReady();
    const value = origin(input);
    if (!Number.isSafeInteger(maxLinks) || maxLinks < 1 || maxLinks > 1_000_000)
      invalid('scan limit');
    return this.protect('verify', signal, async () => {
      const trusted = this.prefix(value);
      let witness: DeletionArchiveHead | undefined;
      if (required) {
        const parsed = deletionArchiveHeadSchema.safeParse(required);
        if (!parsed.success) invalid('required witness');
        sameOrigin(value, parsed.data.origin);
        witness = parsed.data;
      }
      const root = await this.checkGenesis(value, signal);
      const { head } = await this.head(value, signal);
      await this.walk(
        value,
        head,
        root,
        visit,
        signal,
        maxLinks,
        trusted,
        false,
        witness,
      );
      this.remember(head);
      return head;
    });
  }
  private prefix(value: DeletionOrigin) {
    const previous = this.verified;
    return previous?.origin.deployment_id === value.deployment_id &&
      previous.origin.initialized_at === value.initialized_at
      ? previous
      : undefined;
  }
  private remember(head: DeletionArchiveHead) {
    if (
      this.verified?.origin.deployment_id === head.origin.deployment_id &&
      this.verified.origin.initialized_at === head.origin.initialized_at
    ) {
      if (BigInt(this.verified.generation) > BigInt(head.generation)) return;
      if (
        this.verified.generation === head.generation &&
        this.verified.tip !== head.tip
      )
        invalid('observed fork');
    }
    this.verified = { ...head, origin: { ...head.origin } };
    this.shortcut = true;
  }
  private async walk(
    value: DeletionOrigin,
    head: DeletionArchiveHead,
    root: string,
    visit: (batch: DeletionBatch, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    maxLinks: number,
    trusted?: DeletionArchiveHead,
    shortcut = false,
    required?: DeletionArchiveHead,
  ): Promise<void> {
    let tip = head.tip,
      generation = BigInt(head.generation),
      count = BigInt(head.entry_references);
    for (let position = 0; position < maxLinks; position++) {
      signal.throwIfAborted();
      if (required && generation <= BigInt(required.generation)) {
        if (
          tip !== required.tip ||
          generation !== BigInt(required.generation) ||
          count !== BigInt(required.entry_references)
        )
          invalid('required history');
        required = undefined;
      }
      if (trusted && generation <= BigInt(trusted.generation)) {
        if (
          tip !== trusted.tip ||
          generation !== BigInt(trusted.generation) ||
          count !== BigInt(trusted.entry_references)
        )
          invalid('observed prefix');
        if (shortcut) return;
        trusted = undefined;
      }
      const stored = await this.read(
        this.key(value, `links/${tip}.json`),
        4096,
        signal,
      );
      if (!stored) invalid('missing link');
      let link: DeletionArchiveLink;
      try {
        if (digest(stored.bytes) !== tip) invalid('link checksum');
        const parsed = deletionArchiveLinkSchema.safeParse(
          decode(stored.bytes),
        );
        if (!parsed.success) invalid('link shape');
        link = parsed.data;
      } finally {
        stored.bytes.fill(0);
      }
      sameOrigin(value, link.origin);
      if (
        BigInt(link.generation) !== generation ||
        BigInt(link.entry_references) !== count
      )
        invalid('chain counters');
      if (link.kind === 'genesis') {
        if (tip !== root || generation !== 0n || count !== 0n)
          invalid('chain root');
        signal.throwIfAborted();
        return;
      }
      if (count < BigInt(link.batch_entries)) invalid('entry count');
      const payload = await this.read(
        this.key(value, `batches/${link.batch_id}.json`),
        MAX_BODY,
        signal,
      );
      if (!payload) invalid('missing batch');
      let batch: DeletionBatch;
      try {
        if (digest(payload.bytes) !== link.batch_sha256)
          invalid('batch checksum');
        const parsed = deletionBatchSchema.safeParse(decode(payload.bytes));
        if (!parsed.success) invalid('batch shape');
        batch = parsed.data;
      } finally {
        payload.bytes.fill(0);
      }
      sameOrigin(value, batch.origin);
      if (
        batch.id !== link.batch_id ||
        batch.entries.length !== link.batch_entries
      )
        invalid('batch identity');
      try {
        await visit(batch, signal);
      } catch (error) {
        throw new VisitorFailure(error);
      }
      signal.throwIfAborted();
      tip = link.previous;
      generation--;
      count -= BigInt(link.batch_entries);
    }
    invalid('scan limit');
  }
}
