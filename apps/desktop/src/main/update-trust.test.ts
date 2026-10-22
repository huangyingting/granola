import type {
  ExecFileException,
  ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertVerifiedInstaller,
  assertVerifiedUpdate,
  verifyInstallerUpdateArtifact,
  verifyUpdateArtifact,
  verifyUpdateInstallation,
} from './update-trust.js';
import { UpdateDownloads } from './update-downloads.js';

const execution = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => void
  >(),
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(execution, {
    [Symbol.for('nodejs.util.promisify.custom')]: (
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
    ) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execution(file, args, options, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  }),
}));
beforeEach(() => {
  execution.mockReset();
  vi.unstubAllEnvs();
});
afterEach(() => vi.restoreAllMocks());

const policy = {
  current_version: '0.1.0',
  version: '0.1.1',
  certificate_sha256: 'ab'.repeat(32),
  publisher: 'Synthetic signing publisher',
  product_name: 'Windows AI Notes Preview',
  bytes: 123_456,
  sha512: Buffer.alloc(64, 1).toString('base64'),
};
const report = {
  version: 1,
  verified: true,
  code: 'update_verified',
  artifact: {
    bytes: policy.bytes,
    sha512: policy.sha512,
    certificate_sha256: policy.certificate_sha256,
    publisher: policy.publisher,
    product_name: policy.product_name,
    product_version: policy.version,
  },
};

describe('native registered installation preflight', () => {
  const helper = 'C:\\Installed app\\resources\\audio-host\\AudioHost.exe';
  const executable = 'C:\\Installed app\\Windows AI Notes Preview.exe';
  const installed = {
    version: 1,
    registered: true,
    code: 'update_installation_verified',
    installation: {
      directory: 'C:\\Installed app',
      executable,
      application_version: '0.1.0',
      product_name: policy.product_name,
      architecture: 'x64',
    },
  };
  it('uses a separate bounded mode and checks exact installation identity without an installation action', async () => {
    vi.stubEnv('WIN_CSC_KEY_PASSWORD', 'synthetic-not-a-password');
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(null, JSON.stringify(installed), ''),
    );
    const signal = new AbortController().signal;
    expect(
      await verifyUpdateInstallation(
        helper,
        executable,
        '0.1.0',
        policy.product_name,
        signal,
      ),
    ).toEqual(installed.installation);
    expect(execution).toHaveBeenCalledExactlyOnceWith(
      helper,
      [
        '--verify-update-installation',
        executable,
        '0.1.0',
        policy.product_name,
      ],
      expect.objectContaining({
        timeout: 60_000,
        maxBuffer: 16_384,
        windowsHide: true,
        signal,
      }),
      expect.any(Function),
    );
    expect(execution.mock.calls[0]?.[2].env).not.toHaveProperty(
      'WIN_CSC_KEY_PASSWORD',
    );
    expect(execution.mock.calls[0]?.[2].shell).not.toBe(true);
  });
  it.each([
    { directory: 'C:\\Different' },
    { executable: 'C:\\Different\\Windows AI Notes Preview.exe' },
    { application_version: '0.1.1' },
    { product_name: 'Different product' },
    { architecture: 'arm64' },
    { installer: 'C:\\Synthetic\\installer.exe' },
  ])(
    'rejects inconsistent or extra native installation metadata: %j',
    async (change) => {
      execution.mockImplementation((_file, _args, _options, callback) =>
        callback(
          null,
          JSON.stringify({
            ...installed,
            installation: { ...installed.installation, ...change },
          }),
          '',
        ),
      );
      await expect(
        verifyUpdateInstallation(
          helper,
          executable,
          '0.1.0',
          policy.product_name,
        ),
      ).rejects.toMatchObject({
        code:
          'architecture' in change || 'installer' in change
            ? 'update_verifier_protocol'
            : 'update_installation_mismatch',
      });
    },
  );
  it.each([
    'update_installation_location',
    'update_installation_missing',
    'update_installation_machine',
    'update_installation_mismatch',
  ])(
    'surfaces a native rejection without accepting another success protocol: %s',
    async (code) => {
      execution.mockImplementation((_file, _args, _options, callback) =>
        callback(
          Object.assign(new Error('Synthetic native error.'), {
            code: 2,
            stdout: JSON.stringify({
              version: 1,
              registered: false,
              code,
              installation: null,
            }),
          }),
          '',
          '',
        ),
      );
      await expect(
        verifyUpdateInstallation(
          helper,
          executable,
          '0.1.0',
          policy.product_name,
        ),
      ).rejects.toMatchObject({ code });
      execution.mockImplementation((_file, _args, _options, callback) =>
        callback(null, JSON.stringify(report), ''),
      );
      await expect(
        verifyUpdateInstallation(
          helper,
          executable,
          '0.1.0',
          policy.product_name,
        ),
      ).rejects.toMatchObject({ code: 'update_verifier_protocol' });
    },
  );
  it.each(['0.1.0-preview', '01.1.0', '0.1.0\n'])(
    'rejects an unsupported installed version before starting a process: %s',
    async (version) => {
      await expect(
        verifyUpdateInstallation(
          helper,
          executable,
          version,
          policy.product_name,
        ),
      ).rejects.toMatchObject({ code: 'update_installation_arguments' });
      expect(execution).not.toHaveBeenCalled();
    },
  );
  it('does not accept success-shaped output from a rejected process', async () => {
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(
        Object.assign(new Error('Synthetic failed process.'), {
          code: 2,
          stdout: JSON.stringify(installed),
        }),
        '',
        '',
      ),
    );
    await expect(
      verifyUpdateInstallation(
        helper,
        executable,
        '0.1.0',
        policy.product_name,
      ),
    ).rejects.toMatchObject({ code: 'update_verifier_protocol' });
  });
  it('rejects noncanonical paths before invoking the helper', async () => {
    await expect(
      verifyUpdateInstallation(
        helper,
        'C:\\Installed app\\..\\app.exe',
        '0.1.0',
        policy.product_name,
      ),
    ).rejects.toMatchObject({ code: 'update_installation_arguments' });
    expect(execution).not.toHaveBeenCalled();
  });
});

describe('first-party installer-only update trust', () => {
  const installerReport = {
    ...report,
    code: 'update_installer_verified',
  };

  it('requires an explicit installer verification result and never upgrades a generic PE trust result', () => {
    expect(assertVerifiedInstaller(installerReport, policy)).toEqual(
      report.artifact,
    );
    expect(() => assertVerifiedInstaller(report, policy)).toThrow(
      'invalid metadata',
    );
    expect(() => assertVerifiedUpdate(installerReport, policy)).toThrow(
      'invalid metadata',
    );
    expect(() =>
      assertVerifiedInstaller(
        {
          ...installerReport,
          artifact: {
            ...report.artifact,
            sha512: Buffer.alloc(64, 2).toString('base64'),
          },
        },
        policy,
      ),
    ).toThrow('does not match');
  });

  it('uses the installer-only native mode with the same immutable pins, process bounds and cancellation signal', async () => {
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(null, JSON.stringify(installerReport), ''),
    );
    const signal = new AbortController().signal;
    expect(
      await verifyInstallerUpdateArtifact(
        'C:\\Helper\\AudioHost.exe',
        'C:\\Cache\\installer.exe',
        policy,
        signal,
      ),
    ).toEqual(report.artifact);
    expect(execution).toHaveBeenCalledExactlyOnceWith(
      'C:\\Helper\\AudioHost.exe',
      [
        '--verify-installer-update',
        'C:\\Cache\\installer.exe',
        policy.certificate_sha256,
        policy.publisher,
        policy.product_name,
        policy.version,
      ],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16_384,
        windowsHide: true,
        signal,
      }),
      expect.any(Function),
    );
  });

  it('surfaces an installer-role rejection without accepting generic signature success', async () => {
    for (const value of [
      {
        version: 1,
        verified: false,
        code: 'update_installer_mismatch',
        artifact: null,
      },
      report,
    ]) {
      execution.mockImplementation((_file, _args, _options, callback) =>
        callback(
          Object.assign(new Error('Synthetic private native output.'), {
            code: 2,
            stdout: JSON.stringify(value),
          }),
          JSON.stringify(value),
          '',
        ),
      );
      await expect(
        verifyInstallerUpdateArtifact(
          'C:\\Helper\\AudioHost.exe',
          'C:\\Cache\\installer.exe',
          policy,
        ),
      ).rejects.toMatchObject({
        code: value.verified
          ? 'update_verifier_protocol'
          : 'update_installer_mismatch',
      });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'defaults both downloaded and recovered Windows paths to installer-only verification with no generic fallback',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'notes-installer-only-'));
      try {
        const data = new Uint8Array(policy.bytes);
        const digest = createHash('sha512').update(data).digest('base64');
        const verified = {
          ...installerReport,
          artifact: { ...installerReport.artifact, sha512: digest },
        };
        execution.mockImplementation((_file, _args, _options, callback) =>
          callback(null, JSON.stringify(verified), ''),
        );
        const downloads = new UpdateDownloads(
          root,
          'C:\\Helper\\AudioHost.exe',
          {
            version: 1,
            feed_url: 'https://updates.example/stable.json',
            certificate_sha256: policy.certificate_sha256,
            publisher: policy.publisher,
            product_name: policy.product_name,
          },
          policy.current_version,
          {
            capacity: async () => {},
            fetch: async (input) => {
              const result = new Response(data);
              Object.defineProperty(result, 'url', {
                value: String(input),
              });
              return result;
            },
          },
        );
        const candidate = await downloads.download({
          version: 1,
          kind: 'windows_update',
          application_version: policy.version,
          architecture: 'x64',
          installer: `windows-ai-notes-${policy.version}-x64-signed.exe`,
          bytes: policy.bytes,
          sha512: digest,
        });
        expect(await downloads.recover()).toMatchObject({
          ready: { installer: candidate.installer },
          rejected: 0,
        });
        expect(execution.mock.calls.map((call) => call[1][0])).toEqual([
          '--verify-installer-update',
          '--verify-installer-update',
        ]);
        execution.mockImplementation((_file, _args, _options, callback) =>
          callback(
            null,
            JSON.stringify({ ...verified, code: 'update_verified' }),
            '',
          ),
        );
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await downloads.recover()).toMatchObject({
          ready: null,
          rejected: 1,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('native trusted update boundary', () => {
  it('accepts only the exact pinned identity and downloaded artifact', () => {
    expect(assertVerifiedUpdate(report, policy)).toEqual(report.artifact);
    expect(
      assertVerifiedUpdate(
        {
          ...report,
          artifact: {
            ...report.artifact,
            product_version: `${policy.version}.0`,
          },
        },
        policy,
      ),
    ).toMatchObject({ product_version: '0.1.1.0' });
  });

  it.each([
    { certificate_sha256: 'cd'.repeat(32) },
    { publisher: 'Different publisher' },
    { product_name: 'Different application' },
    { product_version: '0.1.0' },
    { bytes: policy.bytes + 1 },
    { sha512: Buffer.alloc(64, 2).toString('base64') },
  ])('rejects changed verified artifact metadata: %j', (change) => {
    expect(() =>
      assertVerifiedUpdate(
        { ...report, artifact: { ...report.artifact, ...change } },
        policy,
      ),
    ).toThrow('does not match');
  });

  it.each([
    { version: '0.1.0' },
    { version: '0.0.9' },
    { current_version: '1.0.0' },
    { current_version: '2.0.0', version: '1.99.99' },
  ])('does not accept reinstalls or downgrades: %j', (change) => {
    expect(() =>
      assertVerifiedUpdate(report, { ...policy, ...change }),
    ).toThrow('must be newer');
  });

  it.each([
    { current_version: '0.1.0', version: '0.1.10' },
    { current_version: '0.9.99', version: '0.10.0' },
    { current_version: '0.99.99', version: '1.0.0' },
  ])('compares version components numerically: %j', (change) => {
    const next = {
      ...report,
      artifact: { ...report.artifact, product_version: change.version },
    };
    expect(assertVerifiedUpdate(next, { ...policy, ...change })).toEqual(
      next.artifact,
    );
  });

  it.each([
    { version: '0.1.1\n' },
    { version: '0.1.01' },
    { version: '0.1.1-preview' },
    { version: '65536.0.0' },
    { certificate_sha256: `${'ab'.repeat(32)}\n` },
    { publisher: 'Publisher\n' },
    { product_name: ' Product' },
    { bytes: 2 * 1024 ** 3 + 1 },
    { sha512: `${policy.sha512}\n` },
    { unexpected: true },
  ])('rejects an invalid update expectation: %j', (change) => {
    expect(() =>
      assertVerifiedUpdate(report, { ...policy, ...change }),
    ).toThrow('is invalid');
  });

  it.each([
    null,
    { ...report, version: 2 },
    { ...report, verified: false },
    { ...report, code: 'unknown' },
    { ...report, artifact: null },
    { ...report, extra: true },
  ])('fails closed on an invalid native response: %j', (value) => {
    expect(() => assertVerifiedUpdate(value, policy)).toThrow(
      'invalid metadata',
    );
  });

  it.each(['relative.exe', '\\\\server\\share\\file.exe', 'C:\\file.exe\n'])(
    'rejects an unsafe process/file path before starting a child: %s',
    async (path) => {
      await expect(
        verifyUpdateArtifact(path, 'C:\\Synthetic\\installer.exe', policy),
      ).rejects.toThrow('local absolute');
      await expect(
        verifyUpdateArtifact('C:\\Synthetic\\AudioHost.exe', path, policy),
      ).rejects.toThrow('local absolute');
    },
  );

  it('uses a bounded, hidden, shell-free process with an OS-only environment', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'synthetic-not-a-secret');
    vi.stubEnv('WIN_CSC_KEY_PASSWORD', 'synthetic-not-a-password');
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(null, JSON.stringify(report), ''),
    );
    const helper = 'C:\\Synthetic path\\AudioHost.exe';
    const installer = 'C:\\Synthetic cache\\installer.exe';
    expect(await verifyUpdateArtifact(helper, installer, policy)).toEqual(
      report.artifact,
    );
    expect(execution).toHaveBeenCalledExactlyOnceWith(
      helper,
      [
        '--verify-update',
        installer,
        policy.certificate_sha256,
        policy.publisher,
        policy.product_name,
        policy.version,
      ],
      expect.objectContaining({
        cwd: 'C:\\Synthetic path',
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16_384,
        windowsHide: true,
      }),
      expect.any(Function),
    );
    const environment = execution.mock.calls[0]?.[2].env;
    expect(environment).not.toHaveProperty('AZURE_OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('WIN_CSC_KEY_PASSWORD');
    expect(execution.mock.calls[0]?.[2].shell).not.toBe(true);
  });

  it('surfaces an explicit native rejection, not a successful result or raw process error', async () => {
    const rejected = {
      version: 1,
      verified: false,
      code: 'update_signature_invalid',
      artifact: null,
    };
    const error = Object.assign(
      new Error('Synthetic raw private process detail'),
      {
        code: 2,
        stdout: JSON.stringify(rejected),
      },
    );
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(error, error.stdout, ''),
    );
    await expect(
      verifyUpdateArtifact(
        'C:\\Helper\\AudioHost.exe',
        'C:\\Cache\\installer.exe',
        policy,
      ),
    ).rejects.toMatchObject({
      code: 'update_signature_invalid',
      message:
        'The native verifier rejected the update. No installer was accepted.',
    });
  });

  it('never accepts a successful-looking response from a failed native process', async () => {
    const error = Object.assign(new Error('Synthetic process failure'), {
      code: 2,
      stdout: JSON.stringify(report),
    });
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(error, error.stdout, ''),
    );
    await expect(
      verifyUpdateArtifact(
        'C:\\Helper\\AudioHost.exe',
        'C:\\Cache\\installer.exe',
        policy,
      ),
    ).rejects.toMatchObject({ code: 'update_verifier_protocol' });
  });

  it('rejects malformed native JSON without reflecting raw output', async () => {
    execution.mockImplementation((_file, _args, _options, callback) =>
      callback(null, 'Synthetic malformed private output', ''),
    );
    await expect(
      verifyUpdateArtifact(
        'C:\\Helper\\AudioHost.exe',
        'C:\\Cache\\installer.exe',
        policy,
      ),
    ).rejects.toMatchObject({ code: 'update_verifier_protocol' });
  });

  it.each(['ETIMEDOUT', 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])(
    'does not accept a timeout, missing helper or excessive response: %s',
    async (code) => {
      execution.mockImplementation((_file, _args, _options, callback) =>
        callback(
          Object.assign(new Error('Synthetic raw process failure'), { code }),
          '',
          '',
        ),
      );
      await expect(
        verifyUpdateArtifact(
          'C:\\Helper\\AudioHost.exe',
          'C:\\Cache\\installer.exe',
          policy,
        ),
      ).rejects.toMatchObject({ code: 'update_verifier_failed' });
    },
  );
});
