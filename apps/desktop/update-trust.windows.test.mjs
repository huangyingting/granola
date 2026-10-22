import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { inspectWindowsSignature } from './release.mjs';
import { verifyUpdateArtifact } from './src/main/update-trust.js';
import { UpdateDownloads } from './src/main/update-downloads.js';

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
        const packagedPolicy = {
          version: 1,
          feed_url: 'https://updates.example/windows/stable.json',
          certificate_sha256: policy.certificate_sha256,
          publisher: policy.publisher,
          product_name: policy.product_name,
        };
        const feed = {
          version: 1,
          kind: 'windows_update',
          application_version: policy.version,
          architecture: 'x64',
          installer: `windows-ai-notes-${policy.version}-x64-signed.exe`,
          bytes: policy.bytes,
          sha512: policy.sha512,
        };
        const downloads = new UpdateDownloads(
          join(directory, 'Update cache'),
          helper,
          packagedPolicy,
          '0.0.0',
          {
            fetch: async (input) => {
              const url = String(input);
              const response = new Response(
                url === packagedPolicy.feed_url
                  ? JSON.stringify(feed)
                  : Readable.toWeb(createReadStream(file)),
              );
              Object.defineProperty(response, 'url', { value: url });
              return response;
            },
          },
        );
        expect(await downloads.check()).toEqual(feed);
        const ready = await downloads.download(feed);
        expect((await stat(ready.installer)).size).toBe(policy.bytes);
        expect(
          JSON.parse(
            await readFile(
              join(ready.directory, 'verified-update.json'),
              'utf8',
            ),
          ),
        ).toMatchObject({ version: 1, feed, expected: ready.expected });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 240_000);
  },
);
