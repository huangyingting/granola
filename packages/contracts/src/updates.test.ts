import { describe, expect, it } from 'vitest';
import {
  cachedUpdateSchema,
  compareUpdateVersions,
  desktopUpdateCommandSchema,
  desktopUpdateResponseSchema,
  desktopUpdateStateSchema,
  packagedUpdatePolicySchema,
  stagedUpdateRuntimeSchema,
  updateFeedSchema,
  updateInstallationSchema,
  updateHandoffDecisionSchema,
  updateParentCommittedSchema,
  updateParentIdentitySchema,
  updateParentReadySchema,
  updateWorkerFailureSchema,
  updateWorkerOutcomeSchema,
  updateWorkerRequestSchema,
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
  it('keeps process creation identity exact without exposing executable or authorization claims', () => {
    const parent = { pid: 1234, creation_file_time: '134000000000000001' };
    expect(updateParentIdentitySchema.parse(parent)).toEqual(parent);
    for (const change of [
      { pid: 0 },
      { pid: 2 ** 31 },
      { creation_file_time: 134000000000000001 },
      { creation_file_time: 'not-a-time' },
      { creation_file_time: '0' },
      { creation_file_time: '0134000000000000001' },
      { creation_file_time: '9223372036854775808' },
      { executable: 'C:\\Synthetic\\app.exe' },
      { installation_enabled: true },
    ])
      expect(
        updateParentIdentitySchema.safeParse({ ...parent, ...change }).success,
      ).toBe(false);
  });
  it('bounds worker failures to a strict diagnostic code without granting update authority', () => {
    const failure = {
      version: 1,
      event: 'update_worker_failed',
      code: 'update_signature_invalid',
    };
    expect(updateWorkerFailureSchema.parse(failure)).toEqual(failure);
    for (const change of [
      { version: 2 },
      { event: 'update_runtime_failed' },
      { code: '' },
      { code: 'INVALID' },
      { code: 'invalid\n' },
      { code: 'a'.repeat(101) },
      { code: 1 },
      { parent_pid: 123 },
      { certificate_sha256: policy.certificate_sha256 },
      { installation_enabled: true },
    ])
      expect(
        updateWorkerFailureSchema.safeParse({ ...failure, ...change }).success,
      ).toBe(false);
  });
  it('limits the private handoff channel to a challenge and exact process identity, never install metadata', () => {
    const parent = { pid: 1234, creation_file_time: '134000000000000001' };
    const challenge = 'ab'.repeat(32);
    const ready = {
      version: 1,
      event: 'update_parent_ready',
      challenge,
      parent,
    };
    const committed = { version: 1, event: 'update_parent_committed', parent };
    expect(updateParentReadySchema.parse(ready)).toEqual(ready);
    expect(updateParentCommittedSchema.parse(committed)).toEqual(committed);
    for (const operation of ['commit', 'cancel']) {
      const decision = { version: 1, operation, challenge };
      expect(updateHandoffDecisionSchema.parse(decision)).toEqual(decision);
      for (const change of [
        { version: 2 },
        { operation: 'install' },
        { challenge: challenge.toUpperCase() },
        { challenge: 'short' },
        { installer: 'C:\\Synthetic\\other.exe' },
        { expected: policy },
        { parent },
      ])
        expect(
          updateHandoffDecisionSchema.safeParse({ ...decision, ...change })
            .success,
        ).toBe(false);
    }
    expect(
      updateParentReadySchema.safeParse({ ...ready, verified: true }).success,
    ).toBe(false);
    expect(
      updateParentCommittedSchema.safeParse({
        ...committed,
        installation_enabled: true,
      }).success,
    ).toBe(false);
  });
  it('bounds staged runtime metadata without granting installation or signature authority', () => {
    const runtime = {
      directory:
        'C:\\Private cache\\worker-11111111-1111-4111-8111-111111111111',
      executable:
        'C:\\Private cache\\worker-11111111-1111-4111-8111-111111111111\\AudioHost.exe',
      files: 200,
      bytes: 100 * 1024 ** 2,
      sha256: 'ab'.repeat(32),
    };
    expect(stagedUpdateRuntimeSchema.parse(runtime)).toEqual(runtime);
    for (const change of [
      { files: 0 },
      { files: 513 },
      { bytes: 0 },
      { bytes: 512 * 1024 ** 2 + 1 },
      { sha256: 'AB'.repeat(32) },
      { executable: 'relative.exe' },
      { verified: true },
      { installation_enabled: true },
    ])
      expect(
        stagedUpdateRuntimeSchema.safeParse({ ...runtime, ...change }).success,
      ).toBe(false);
  });
  it('keeps worker setup Main-only without caller-selected trust policy or installer commands', () => {
    const request = {
      parent_pid: 1234,
      application: 'C:\\Installed app\\Windows AI Notes Preview.exe',
      current_version: '0.1.0',
      offered_version: '0.1.1',
      installer: 'C:\\Private cache\\candidate.exe',
      bytes: feed.bytes,
      sha512: feed.sha512,
      runtime_sha256: 'ab'.repeat(32),
    };
    expect(updateWorkerRequestSchema.parse(request)).toEqual(request);
    for (const extra of [
      { expected: policy },
      { certificate_sha256: policy.certificate_sha256 },
      { feed_url: policy.feed_url },
      { arguments: ['/allusers'] },
      { destination: 'C:\\Other application' },
      { runtime_sha256: 'AB'.repeat(32) },
      { parent_pid: 0 },
    ])
      expect(
        updateWorkerRequestSchema.safeParse({ ...request, ...extra }).success,
      ).toBe(false);
  });
  it('distinguishes durable installation intent and failure from verified installed files, not restart health', () => {
    const outcome = {
      version: 1,
      session_id: '11111111-1111-4111-8111-111111111111',
      current_version: '0.1.0',
      offered_version: '0.1.1',
      phase: 'installing',
      code: 'update_installer_starting',
      installer_started: false,
      installer_process: null,
      installer_exit_code: null,
      updated_at: '2026-10-22T12:00:00.1234567Z',
    };
    expect(updateWorkerOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(
      updateWorkerOutcomeSchema.safeParse({
        ...outcome,
        installer_started: true,
      }).success,
    ).toBe(true);
    for (const change of [
      { phase: 'installed' },
      { phase: 'prepared', installer_started: true },
      { phase: 'installing', installer_exit_code: 0 },
      { phase: 'failed', installer_exit_code: 0 },
      { phase: 'healthy' },
      { phase: 'installed', installer_started: true, installer_exit_code: 1 },
      { phase: 'installed', installer_started: true, installer_exit_code: 0 },
      {
        installer_process: {
          pid: 1234,
          creation_file_time: '134000000000000001',
        },
      },
      {
        installer_started: true,
        installer_process: { pid: 0, creation_file_time: '134000000000000001' },
      },
      { expected: policy },
      { rollback_safe: true },
    ])
      expect(
        updateWorkerOutcomeSchema.safeParse({ ...outcome, ...change }).success,
      ).toBe(false);
    expect(
      updateWorkerOutcomeSchema.safeParse({
        ...outcome,
        phase: 'installed',
        installer_started: true,
        installer_exit_code: 0,
        installer_process: {
          pid: 1234,
          creation_file_time: '134000000000000001',
        },
      }).success,
    ).toBe(true);
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
