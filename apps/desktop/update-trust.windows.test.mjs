import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectWindowsSignature } from './release.mjs';
import { verifyUpdateArtifact } from './src/main/update-trust.js';

describe.skipIf(process.platform !== 'win32')(
  'actual desktop-to-native update verification',
  () => {
    it('accepts an independently inspected signed runtime through the real helper and rejects pin and feed-digest mismatches', async () => {
      const helper = fileURLToPath(
        new URL(
          '../../native/audio-host/AudioHost/bin/Release/net10.0-windows/AudioHost.exe',
          import.meta.url,
        ),
      );
      expect(existsSync(helper)).toBe(true);
      const observed = await inspectWindowsSignature(process.execPath);
      expect(observed).toMatchObject({
        status: 'Valid',
        signature_type: 'Authenticode',
        timestamped: true,
      });
      expect(observed.certificate_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(observed.publisher).toBeTruthy();
      const directory = await mkdtemp(join(tmpdir(), 'notes-native-update-'));
      try {
        const file = join(directory, 'Signed runtime fixture.exe');
        await copyFile(process.execPath, file);
        const policy = {
          current_version: '0.0.0',
          version: process.versions.node,
          certificate_sha256: observed.certificate_sha256,
          publisher: observed.publisher,
          product_name: 'Node.js',
          bytes: (await stat(file)).size,
          sha512: createHash('sha512')
            .update(await readFile(file))
            .digest('base64'),
        };
        expect(await verifyUpdateArtifact(helper, file, policy)).toMatchObject({
          bytes: policy.bytes,
          sha512: policy.sha512,
          certificate_sha256: policy.certificate_sha256,
          publisher: policy.publisher,
          product_name: policy.product_name,
        });
        await expect(
          verifyUpdateArtifact(helper, file, {
            ...policy,
            certificate_sha256: '0'.repeat(64),
          }),
        ).rejects.toMatchObject({ code: 'update_identity_mismatch' });
        await expect(
          verifyUpdateArtifact(helper, file, {
            ...policy,
            sha512: Buffer.alloc(64).toString('base64'),
          }),
        ).rejects.toMatchObject({ code: 'update_artifact_mismatch' });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 240_000);
  },
);
