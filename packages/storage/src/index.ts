import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  GetBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { addAbortSignal, Readable } from 'node:stream';
import { resourceId, ServiceError } from '@windows-ai-notes/contracts/server';
import {
  assertPrivateBucketAccess,
  objectStoreStatus as status,
} from './private-bucket.js';

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  encryption: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}
export function loadStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig | null {
  const fields = [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_ENCRYPTION',
    'S3_KMS_KEY_ID',
  ];
  if (!fields.some((key) => env[key] !== undefined)) return null;
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_REGION)
    throw new Error('Configure S3_ENDPOINT, S3_BUCKET and S3_REGION together.');
  const endpoint = new URL(env.S3_ENDPOINT);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' &&
      !(
        env.NODE_ENV !== 'production' &&
        local &&
        endpoint.protocol === 'http:'
      )) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error(
      'S3_ENDPOINT must be a credential-free HTTPS origin; only explicit loopback development permits HTTP.',
    );
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET))
    throw new Error('S3_BUCKET must be a valid DNS-style bucket name.');
  const encryption =
    env.S3_ENCRYPTION ?? (env.NODE_ENV === 'production' ? undefined : 'none');
  if (
    encryption !== 'none' &&
    encryption !== 'AES256' &&
    encryption !== 'aws:kms'
  )
    throw new Error('Choose S3_ENCRYPTION= AES256 or aws:kms in production.');
  if (env.NODE_ENV === 'production' && encryption === 'none')
    throw new Error(
      'Production recording objects require explicit server-side encryption.',
    );
  if ((encryption === 'aws:kms') !== !!env.S3_KMS_KEY_ID)
    throw new Error('S3_KMS_KEY_ID is required only for aws:kms encryption.');
  if (!!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY)
    throw new Error(
      'Configure both S3 credentials, or neither to use the server workload identity.',
    );
  return {
    endpoint: endpoint.origin,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    encryption,
    ...(env.S3_KMS_KEY_ID ? { kmsKeyId: env.S3_KMS_KEY_ID } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  };
}
export type ObjectIdentity = { id: string; kind: 'staging' | 'verified' };
export function objectKey(object: ObjectIdentity) {
  resourceId.parse(object.id);
  if (!['staging', 'verified'].includes(object.kind))
    throw new Error('Unsupported recording object kind.');
  return `recordings/v1/${object.kind}/${object.id}`;
}
function unavailable(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  console.error(
    JSON.stringify({
      code: 'recording_storage_failed',
      kind: error instanceof Error ? error.name : 'unknown',
    }),
  );
  throw new ServiceError(
    'storage_unavailable',
    'Recording storage could not complete this operation. Retry without deleting local audio.',
    503,
    true,
  );
}
export class RecordingBlobs {
  private readonly client: S3Client;
  constructor(readonly config: StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      ...(config.credentials ? { credentials: config.credentials } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 2,
    });
  }
  close() {
    this.client.destroy();
  }
  private encryption() {
    return this.config.encryption === 'none'
      ? {}
      : {
          ServerSideEncryption: this.config.encryption,
          ...(this.config.kmsKeyId
            ? { SSEKMSKeyId: this.config.kmsKeyId }
            : {}),
        };
  }
  async assertReady() {
    const input = { Bucket: this.config.bucket };
    const signal = AbortSignal.timeout(15_000);
    await this.client.send(new HeadBucketCommand(input), {
      abortSignal: signal,
    });
    const versioning = await this.client.send(
      new GetBucketVersioningCommand(input),
      { abortSignal: signal },
    );
    if (versioning.Status)
      throw new Error(
        'Recording storage currently requires an unversioned bucket so deletion does not retain old object versions.',
      );
    await assertPrivateBucketAccess(this.client, this.config.bucket, signal);
  }
  async authorize(
    object: ObjectIdentity,
    size: number,
    sha256: string,
    expires: Date,
  ) {
    if (
      object.kind !== 'staging' ||
      !Number.isInteger(size) ||
      size < 46 ||
      size > 960_044 ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      throw new Error(
        'Only bounded canonical audio staging objects can be authorized.',
      );
    const headers: Record<string, string> = {
      'x-amz-acl': 'bucket-owner-full-control',
      'content-type': 'audio/wav',
      'content-length': String(size),
      'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
    };
    if (this.config.encryption !== 'none')
      headers['x-amz-server-side-encryption'] = this.config.encryption;
    if (this.config.kmsKeyId)
      headers['x-amz-server-side-encryption-aws-kms-key-id'] =
        this.config.kmsKeyId;
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey(object),
          ContentType: 'audio/wav',
          ACL: 'bucket-owner-full-control',
          ContentLength: size,
          ChecksumSHA256: headers['x-amz-checksum-sha256']!,
          ...this.encryption(),
        }),
        {
          expiresIn: 300,
          signingDate: new Date(expires.getTime() - 300_000),
          signableHeaders: new Set(Object.keys(headers)),
          unhoistableHeaders: new Set(
            Object.keys(headers).filter((name) => name.startsWith('x-amz-')),
          ),
        },
      );
      return { id: object.id, url, headers, expires_at: expires.toISOString() };
    } catch (error) {
      unavailable(error);
    }
  }
  async read(
    object: ObjectIdentity,
    size: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (!Number.isInteger(size) || size < 46 || size > 960_044)
      throw new Error('Read a bounded canonical audio object.');
    try {
      const output = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey(object),
          Range: `bytes=0-${size}`,
        }),
        { abortSignal: signal },
      );
      if (!output.Body) throw new Error('Storage returned no object body.');
      if (!(output.Body instanceof Readable))
        throw new Error('Storage returned an unsupported object stream.');
      addAbortSignal(signal, output.Body);
      const reader = output.Body.transformToWebStream().getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > size) {
            part.value.fill(0);
            throw new ServiceError(
              'checksum_mismatch',
              'The uploaded object exceeds its immutable declared size.',
              409,
            );
          }
          chunks.push(part.value);
        }
        return Buffer.concat(chunks, length);
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
          for (const chunk of chunks) chunk.fill(0);
        }
      }
    } catch (error) {
      if (status(error) === 404)
        throw new ServiceError(
          'upload_missing',
          'The authorized audio object has not been uploaded or has expired. Upload it again.',
          409,
          true,
        );
      unavailable(error);
    }
  }
  async promote(object: ObjectIdentity, bytes: Buffer, signal: AbortSignal) {
    if (
      object.kind !== 'verified' ||
      bytes.length < 46 ||
      bytes.length > 960_044
    )
      throw new Error(
        'Only verified, bounded bytes can be promoted to a private object.',
      );
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey(object),
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: 'audio/wav',
          IfNoneMatch: '*',
          ...this.encryption(),
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (status(error) === 412) {
        const existing = await this.read(object, bytes.length, signal);
        try {
          if (existing.equals(bytes)) return;
          throw new ServiceError(
            'immutable_object_conflict',
            'An immutable verified object already contains different bytes.',
            409,
          );
        } finally {
          existing.fill(0);
        }
      }
      unavailable(error);
    }
  }
  async remove(object: ObjectIdentity, signal: AbortSignal) {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey(object),
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      unavailable(error);
    }
  }
}
