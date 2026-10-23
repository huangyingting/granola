import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptancePair,
  newWorkerOutcome,
  readAcceptanceMetadata,
  workerDirectories,
} from './tests/signed-activation-support.js';

const policy = {
  version: 1,
  feed_url: 'https://updates.example/windows/stable.json',
  certificate_sha256: 'a'.repeat(64),
  publisher: 'Synthetic acceptance publisher',
  product_name: 'Windows AI Notes Preview',
};
const feed = {
  version: 1,
  kind: 'windows_update',
  application_version: '0.1.0',
  architecture: 'x64',
  installer: 'windows-ai-notes-0.1.0-x64-signed.exe',
  bytes: 100,
  sha512: Buffer.alloc(64).toString('base64'),
};
const manifest = {
  version: 1,
  kind: 'signed_activation_pair',
  scope: 'same_source_compatible_patch',
  source_commit: 'b'.repeat(40),
  production_accepted: false,
  policy,
  current: feed,
  offered: {
    ...feed,
    application_version: '0.1.1',
    installer: 'windows-ai-notes-0.1.1-x64-signed.exe',
  },
};
const environment = {
  GITHUB_SHA: manifest.source_commit,
  WINDOWS_UPDATE_FEED_URL: policy.feed_url,
  WINDOWS_SIGNING_CERT_SHA256: policy.certificate_sha256,
  WINDOWS_PUBLISHER_NAME: policy.publisher,
};
const pair = acceptancePair(
  manifest,
  environment,
  policy.product_name,
  '0.1.0',
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'notes-acceptance-bookkeeping-'));
  roots.push(root);
  return root;
}
const session = '00000000-0000-4000-8000-000000000001';
const name = `worker-${session}`;
const outcome = {
  version: 1,
  session_id: session,
  current_version: '0.1.0',
  offered_version: '0.1.1',
  phase: 'prepared',
  code: 'update_worker_prepared',
  installer_started: false,
  installer_process: null,
  installer_exit_code: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  restart: null,
};

describe('signed acceptance bookkeeping, not signature or health authority', () => {
  it('requires exact source, actual baseline and independently configured public trust pins', () => {
    expect(pair).toEqual(manifest);
    expect(
      acceptancePair(
        manifest,
        {
          ...environment,
          WINDOWS_SIGNING_CERT_SHA256: policy.certificate_sha256.toUpperCase(),
        },
        policy.product_name,
        '0.1.0',
      ),
    ).toEqual(pair);
    for (const change of [
      { GITHUB_SHA: 'c'.repeat(40) },
      { WINDOWS_SIGNING_CERT_SHA256: '0'.repeat(64) },
      { WINDOWS_SIGNING_CERT_SHA256: undefined },
      { WINDOWS_PUBLISHER_NAME: 'Other publisher' },
      { WINDOWS_UPDATE_FEED_URL: 'https://other.example/feed.json' },
    ])
      expect(() =>
        acceptancePair(
          manifest,
          { ...environment, ...change },
          policy.product_name,
          '0.1.0',
        ),
      ).toThrow();
    expect(() =>
      acceptancePair(manifest, environment, 'Other product', '0.1.0'),
    ).toThrow();
    expect(() =>
      acceptancePair(manifest, environment, policy.product_name, '0.0.9'),
    ).toThrow();
  });
  it('refuses signing-secret inheritance before any installed process can launch', () => {
    for (const key of [
      'WIN_CSC_LINK',
      'WIN_CSC_KEY_PASSWORD',
      'WINDOWS_SIGNING_PFX_BASE64',
      'WINDOWS_SIGNING_PFX_PASSWORD',
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
    ])
      for (const value of ['synthetic-sensitive-fixture', ''])
        expect(() =>
          acceptancePair(
            manifest,
            { ...environment, [key]: value },
            policy.product_name,
            '0.1.0',
          ),
        ).toThrow('Signing material must be removed');
  });
  it('bounds metadata reads and rejects invalid JSON and non-regular records', async () => {
    const root = await fixture(),
      file = join(root, 'record.json');
    await writeFile(file, JSON.stringify(manifest));
    expect(await readAcceptanceMetadata(file)).toEqual(manifest);
    await expect(readAcceptanceMetadata(root)).rejects.toThrow(
      'bounded regular file',
    );
    for (const bytes of ['', 'not-json', ' '.repeat(16_385)]) {
      await writeFile(file, bytes);
      await expect(readAcceptanceMetadata(file)).rejects.toThrow();
    }
  });
  it('distinguishes not-yet-created diagnostic journals from malformed and failed outcomes', async () => {
    const root = await fixture();
    expect(await workerDirectories(join(root, 'missing'))).toEqual([]);
    expect(await newWorkerOutcome(root, new Set(), pair)).toBeNull();
    const directory = join(root, name);
    await mkdir(directory);
    expect(await newWorkerOutcome(root, new Set(), pair)).toBeNull();
    const file = join(directory, 'update-outcome.json');
    await writeFile(file, JSON.stringify(outcome));
    expect(await newWorkerOutcome(root, new Set(), pair)).toEqual(outcome);
    expect(await newWorkerOutcome(root, new Set([name]), pair)).toBeNull();
    for (const change of [
      { session_id: '00000000-0000-4000-8000-000000000002' },
      { current_version: '0.0.9' },
      { offered_version: '0.1.2' },
      { phase: 'healthy' },
      { unknown: true },
    ]) {
      await writeFile(file, JSON.stringify({ ...outcome, ...change }));
      await expect(newWorkerOutcome(root, new Set(), pair)).rejects.toThrow();
    }
    await writeFile(
      file,
      JSON.stringify({
        ...outcome,
        phase: 'failed',
        code: 'update_signature_invalid',
      }),
    );
    await expect(newWorkerOutcome(root, new Set(), pair)).rejects.toThrow(
      'Signed activation failed: update_signature_invalid',
    );
    await writeFile(file, '{');
    await expect(newWorkerOutcome(root, new Set(), pair)).rejects.toThrow();
  });
  it('rejects concurrent new workers and excessive diagnostic scanning', async () => {
    const root = await fixture();
    await mkdir(join(root, name));
    await mkdir(join(root, 'worker-00000000-0000-4000-8000-000000000002'));
    await expect(newWorkerOutcome(root, new Set(), pair)).rejects.toThrow(
      'More than one new worker',
    );
    for (let index = 0; index < 127; index++)
      await writeFile(join(root, `unknown-${index}`), '');
    expect((await readdir(root)).length).toBe(129);
    await expect(workerDirectories(root)).rejects.toThrow('inspection bound');
  });
});
