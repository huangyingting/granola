import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadStorageConfig, objectKey, RecordingBlobs } from './index.js';

const development = {
  NODE_ENV: 'development',
  S3_ENDPOINT: 'http://127.0.0.1:59000',
  S3_BUCKET: 'synthetic-recordings',
  S3_REGION: 'us-east-1',
};
describe('private recording storage configuration', () => {
  it('does not silently enable storage or import unrelated credentials', () => {
    expect(loadStorageConfig({})).toBeNull();
    expect(loadStorageConfig(development)).toMatchObject({
      encryption: 'none',
      bucket: 'synthetic-recordings',
    });
    expect(() => loadStorageConfig({ S3_REGION: 'us-east-1' })).toThrow(
      'together',
    );
  });
  it('requires HTTPS and explicit encryption in production', () => {
    expect(() =>
      loadStorageConfig({
        ...development,
        NODE_ENV: 'production',
        S3_ENCRYPTION: 'AES256',
      }),
    ).toThrow('HTTPS');
    const production = {
      ...development,
      NODE_ENV: 'production',
      S3_ENDPOINT: 'https://objects.example.test',
    };
    expect(() => loadStorageConfig(production)).toThrow('S3_ENCRYPTION');
    expect(() =>
      loadStorageConfig({ ...production, S3_ENCRYPTION: 'none' }),
    ).toThrow('encryption');
    expect(
      loadStorageConfig({ ...production, S3_ENCRYPTION: 'AES256' }),
    ).toMatchObject({ encryption: 'AES256' });
  });
  it('rejects credential-bearing URLs, non-loopback cleartext, partial credentials and ambiguous KMS', () => {
    for (const S3_ENDPOINT of [
      'http://objects.example.test',
      'https://user:password@objects.example.test',
      'https://objects.example.test/private',
      'https://objects.example.test/?token=synthetic',
      'file:///tmp/recordings',
    ])
      expect(() =>
        loadStorageConfig({ ...development, S3_ENDPOINT }),
      ).toThrow();
    expect(() =>
      loadStorageConfig({ ...development, S3_ACCESS_KEY_ID: 'synthetic' }),
    ).toThrow('both');
    expect(() =>
      loadStorageConfig({ ...development, S3_ENCRYPTION: 'aws:kms' }),
    ).toThrow('S3_KMS_KEY_ID');
    expect(() =>
      loadStorageConfig({ ...development, S3_KMS_KEY_ID: 'synthetic' }),
    ).toThrow('S3_KMS_KEY_ID');
  });
  it('permits only server-selected opaque recording object namespaces', () => {
    const id = '75048e79-2b45-440f-8609-b80a37635b4a';
    expect(objectKey({ id, kind: 'staging' })).toBe(
      `recordings/v1/staging/${id}`,
    );
    expect(objectKey({ id, kind: 'verified' })).toBe(
      `recordings/v1/verified/${id}`,
    );
    expect(() => objectKey({ id: '../../outside', kind: 'staging' })).toThrow();
  });
  it('aborts an object body that stalls after headers instead of hanging verification', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(206, {
        'content-type': 'audio/wav',
        'content-length': '32044',
      });
      response.write(Buffer.alloc(46));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('The synthetic object stream did not bind loopback.');
    const blobs = new RecordingBlobs({
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: 'synthetic-stream',
      region: 'us-east-1',
      encryption: 'none',
      credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        blobs.read(
          { id: '75048e79-2b45-440f-8609-b80a37635b4a', kind: 'staging' },
          32044,
          AbortSignal.timeout(200),
        ),
      ).rejects.toMatchObject({ code: 'storage_unavailable', retryable: true });
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('recording_storage_failed'),
      );
    } finally {
      errors.mockRestore();
      blobs.close();
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  });
});
