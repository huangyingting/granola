import { describe, expect, it } from 'vitest';
import {
  cachedUpdateSchema,
  compareUpdateVersions,
  desktopUpdateCommandSchema,
  desktopUpdateResponseSchema,
  desktopUpdateStateSchema,
  packagedUpdatePolicySchema,
  updateFeedSchema,
  updateInstallationSchema,
} from './updates.js';

const policy = {
  version: 1,
  feed_url: 'https://updates.example/windows/stable.json',
  certificate_sha256: 'ab'.repeat(32),
  publisher: 'Synthetic publisher',
  product_name: 'Windows AI Notes Preview',
};
const feed = {
  version: 1,
  kind: 'windows_update',
  application_version: '0.1.1',
  architecture: 'x64',
  installer: 'windows-ai-notes-0.1.1-x64-signed.exe',
  bytes: 100,
  sha512: Buffer.alloc(64).toString('base64'),
};

describe('packaged update and feed contracts', () => {
  it('accepts a pinned policy and an exact stable x64 installer descriptor', () => {
    expect(packagedUpdatePolicySchema.parse(policy)).toEqual(policy);
    expect(updateFeedSchema.parse(feed)).toEqual(feed);
    expect(compareUpdateVersions('0.10.0', '0.9.99')).toBe(1);
    expect(compareUpdateVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareUpdateVersions('1.0.0', '2.0.0')).toBe(-1);
  });

  describe('action-only desktop update contracts', () => {
    const state = {
      version: 1,
      revision: 1,
      installed_version: '0.1.0',
      phase: 'disabled',
      available_version: null,
      download_bytes: null,
      can_check: false,
      can_download: false,
      can_cancel: false,
      installation_enabled: false,
      cache: null,
      error: null,
    };
    it.each(['getState', 'check', 'download', 'cancel'])(
      'accepts only a named action without renderer-supplied update authority: %s',
      (operation) => {
        expect(desktopUpdateCommandSchema.parse({ operation })).toEqual({
          operation,
        });

        for (const extra of [
          { feed_url: policy.feed_url },
          { installer: feed.installer },
          { application_version: feed.application_version },
          { expected: policy },
          { path: 'C:\\Synthetic\\setup.exe' },
          { feed },
          { scope: 1 },
        ])
          expect(
            desktopUpdateCommandSchema.safeParse({ operation, ...extra })
              .success,
          ).toBe(false);
      },
    );
    it('rejects install and unknown actions and keeps executable details out of state', () => {
      for (const operation of ['install', 'restart', 'openFolder', '', null])
        expect(
          desktopUpdateCommandSchema.safeParse({ operation }).success,
        ).toBe(false);
      expect(desktopUpdateResponseSchema.parse({ ok: true, state })).toEqual({
        ok: true,
        state,
      });
      for (const extra of [
        { feed },
        { expected: policy },
        { installer: 'C:\\Synthetic\\setup.exe' },
        { installation_enabled: true },
        { revision: Number.MAX_SAFE_INTEGER + 1 },
        { download_bytes: 2 * 1024 ** 3 + 1 },
        { available_version: '01.1.1' },
        { cache: { removed: 0, rejected: 129, incomplete: 0 } },
        { installed_version: '0.1.0\n' },
        { error: { code: 'INVALID CODE', message: 'Invalid.' } },
      ])
        expect(
          desktopUpdateStateSchema.safeParse({ ...state, ...extra }).success,
        ).toBe(false);
    });
  });
  describe('Main-only registered update installation metadata', () => {
    const installation = {
      directory: 'C:\\Installed app',
      executable: 'C:\\Installed app\\Windows AI Notes Preview.exe',
      application_version: '0.1.0',
      product_name: policy.product_name,
      architecture: 'x64',
    };
    it('accepts bounded installation identity without granting it installer-signature authority', () => {
      expect(updateInstallationSchema.parse(installation)).toEqual(
        installation,
      );
      for (const change of [
        { directory: '\\\\server\\share' },
        { executable: 'relative.exe' },
        { executable: 'C:\\app.exe\n' },
        { application_version: '01.1.0' },
        { architecture: 'arm64' },
        { verified: true },
        { certificate_sha256: policy.certificate_sha256 },
      ])
        expect(
          updateInstallationSchema.safeParse({ ...installation, ...change })
            .success,
        ).toBe(false);
    });
  });
  it.each([
    'http://updates.example/stable.json',
    'https://user:password@updates.example/stable.json',
    'https://updates.example/stable.json?token=synthetic',
    'https://updates.example/stable.json#fragment',
    'https://updates.example/stable.json?',
    'https://updates.example/stable.json#',
    'https://UPDATES.example/stable.json',
    'https://updates.example/a/../stable.json',
    'https://updates.example/stable.json\n',
    'https://updates.example/',
    'file:///C:/updates/stable.json',
  ])('rejects an unsafe or noncanonical feed endpoint: %s', (feed_url) => {
    expect(
      packagedUpdatePolicySchema.safeParse({ ...policy, feed_url }).success,
    ).toBe(false);
  });
  it.each([
    { installer: '../outside.exe' },
    { installer: 'https://other.example/installer.exe' },
    { installer: 'windows-ai-notes-0.1.0-x64-signed.exe' },
    { installer: 'windows-ai-notes-0.1.1-x64-unsigned.exe' },
    { architecture: 'arm64' },
    { application_version: '0.1.1-preview' },
    { application_version: '0.1.1\n' },
    { bytes: 2 * 1024 ** 3 + 1 },
    { bytes: 0 },
    { sha512: `${feed.sha512}\n` },
    { certificate_sha256: policy.certificate_sha256 },
    { production_accepted: true },
  ])('rejects unsupported or ambiguous feed metadata: %j', (change) => {
    expect(updateFeedSchema.safeParse({ ...feed, ...change }).success).toBe(
      false,
    );
  });
  it('validates bounded cache receipts without granting their saved verification claims authority', () => {
    const receipt = {
      version: 1,
      feed,
      expected: {
        current_version: '0.1.0',
        version: '0.1.1',
        certificate_sha256: policy.certificate_sha256,
        publisher: policy.publisher,
        product_name: policy.product_name,
        bytes: feed.bytes,
        sha512: feed.sha512,
      },
      verified_at: '2026-01-01T00:00:00.000Z',
    };
    expect(cachedUpdateSchema.parse(receipt)).toEqual(receipt);
    for (const change of [
      { verified: true },
      { verified_at: 'not a date' },
      { version: 2 },
      { expected: { ...receipt.expected, version: '01.1.1' } },
    ])
      expect(
        cachedUpdateSchema.safeParse({ ...receipt, ...change }).success,
      ).toBe(false);
  });
});
