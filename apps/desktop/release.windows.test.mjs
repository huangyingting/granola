import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  childEnvironment,
  inspectWindowsSignature,
  verifiedFile,
  windowsVerifierPath,
} from './release.mjs';

function signedReference() {
  return windowsVerifierPath();
}

describe.skipIf(process.platform !== 'win32')(
  'actual Windows signed-candidate verification',
  () => {
    it('accepts the trusted timestamped Microsoft reference only with its exact signer and rejects a different certificate pin', async () => {
      const reference = signedReference();
      const observed = await inspectWindowsSignature(reference);
      expect(observed).toMatchObject({
        status: 'Valid',
        signature_type: 'Authenticode',
        timestamped: true,
        publisher: 'Microsoft Corporation',
      });
      const policy = {
        certificate_sha256: observed.certificate_sha256,
        publisher: observed.publisher,
      };
      const measured = await verifiedFile(reference, policy);
      expect(measured).toMatchObject(policy);
      expect(measured.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(measured.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      await expect(
        verifiedFile(reference, {
          ...policy,
          certificate_sha256: '0'.repeat(64),
        }),
      ).rejects.toThrow('pinned certificate');
    }, 180_000);
    it('rejects changed executable code through the actual Windows signature verifier', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'notes-tampered-pe-'));
      try {
        const file = join(directory, 'tampered.exe');
        await copyFile(signedReference(), file);
        const handle = await open(file, 'r+');
        try {
          const dos = Buffer.alloc(64);
          await handle.read(dos, 0, dos.length, 0);
          const peOffset = dos.readUInt32LE(0x3c);
          const pe = Buffer.alloc(24);
          await handle.read(pe, 0, pe.length, peOffset);
          expect(pe.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x45, 0, 0]));
          const section = Buffer.alloc(40);
          await handle.read(
            section,
            0,
            section.length,
            peOffset + 24 + pe.readUInt16LE(20),
          );
          expect(section.readUInt32LE(16)).toBeGreaterThan(0);
          const offset = section.readUInt32LE(20);
          const byte = Buffer.alloc(1);
          await handle.read(byte, 0, 1, offset);
          byte[0] ^= 1;
          await handle.write(byte, 0, 1, offset);
        } finally {
          await handle.close();
        }
        const observed = await inspectWindowsSignature(file);
        expect(observed.status).toBe('HashMismatch');
        await expect(
          verifiedFile(file, {
            certificate_sha256: observed.certificate_sha256,
            publisher: observed.publisher,
          }),
        ).rejects.toThrow('trusted, timestamped');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 150_000);
    it('rejects an unsigned first-party PE using the real OS verifier without installing a test CA', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'notes-unsigned-pe-'));
      try {
        const file = join(directory, 'unsigned.dll');
        await promisify(execFile)(
          windowsVerifierPath(),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'public static class SyntheticReleaseProbe { public static void Marker() {} }' -OutputAssembly $env:NOTES_RELEASE_FIXTURE -OutputType Library -ErrorAction Stop",
          ],
          {
            env: { ...childEnvironment(), NOTES_RELEASE_FIXTURE: file },
            timeout: 30_000,
            maxBuffer: 16_384,
            windowsHide: true,
          },
        );
        const before = await readFile(file);
        expect(before.subarray(0, 2).toString('ascii')).toBe('MZ');
        const observed = await inspectWindowsSignature(file);
        expect(observed.status).toBe('NotSigned');
        await expect(
          verifiedFile(file, {
            certificate_sha256: '0'.repeat(64),
            publisher: 'Synthetic release publisher',
          }),
        ).rejects.toThrow('trusted, timestamped');
        expect(await readFile(file)).toEqual(before);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
