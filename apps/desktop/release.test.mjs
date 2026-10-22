import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  signingPolicy,
  childEnvironment,
  windowsVerifierPath,
  assertSignature,
  signedConfiguration,
  verifiedFile,
  promoteCandidate,
  updatePolicy,
} from './release.mjs';

const policy = {
  certificate: 'C:\\private signing\\candidate.pfx',
  certificate_sha256: 'a'.repeat(64),
  publisher: 'Synthetic release publisher',
};
const environment = {
  WIN_CSC_LINK: policy.certificate,
  WIN_CSC_KEY_PASSWORD: 'synthetic-signing-password',
  WINDOWS_SIGNING_CERT_SHA256: policy.certificate_sha256,
  WINDOWS_PUBLISHER_NAME: policy.publisher,
};
const signature = {
  version: 1,
  status: 'Valid',
  signature_type: 'Authenticode',
  certificate_sha256: policy.certificate_sha256,
  publisher: policy.publisher,
  timestamped: true,
};
const packageFile = fileURLToPath(
  new URL('./electron-builder.unsigned.json', import.meta.url),
);
const commit = 'b'.repeat(40);
const version = '0.1.0';
const productName = 'Windows AI Notes Preview';
const expectedFiles = [
  `windows-ai-notes-${version}-x64-signed.exe`,
  `win-unpacked/${productName}.exe`,
  ...['AudioHost.exe', 'AudioHost.dll', 'AudioHost.Core.dll'].map(
    (name) => `win-unpacked/resources/audio-host/${name}`,
  ),
];
const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'notes-signed-candidate-'));
  directories.push(root);
  const output = join(root, 'staged'),
    destination = join(root, 'published');
  for (const file of expectedFiles) {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await writeFile(join(output, file), `synthetic:${file}`);
  }
  return { output, destination, version, commit, productName, policy };
}
describe('fail-closed signed candidate policy', () => {
  it('keeps updates unconfigured unless a direct HTTPS JSON feed is explicitly selected', async () => {
    expect(await updatePolicy({}, productName, policy)).toBeNull();
    expect(
      await updatePolicy({ WINDOWS_UPDATE_FEED_URL: '' }, productName, policy),
    ).toBeNull();
    const configured = await updatePolicy(
      {
        WINDOWS_UPDATE_FEED_URL: 'https://updates.example/windows/stable.json',
        ...environment,
      },
      productName,
      policy,
    );
    expect(configured).toEqual({
      version: 1,
      feed_url: 'https://updates.example/windows/stable.json',
      certificate_sha256: policy.certificate_sha256,
      publisher: policy.publisher,
      product_name: productName,
    });
    expect(JSON.stringify(configured)).not.toContain(
      environment.WIN_CSC_KEY_PASSWORD,
    );
    expect(JSON.stringify(configured)).not.toContain(policy.certificate);
    for (const url of [
      ' ',
      'http://updates.example/feed.json',
      'https://user:secret@updates.example/feed.json',
      'https://updates.example/feed.json?key=synthetic',
      'https://updates.example/feed.json#',
    ]) {
      await expect(
        updatePolicy({ WINDOWS_UPDATE_FEED_URL: url }, productName, policy),
      ).rejects.toMatchObject({
        code: 'release_update_policy',
      });
    }
  });
  it('bundles only a freshly staged public update policy and rejects a preexisting resource override', async () => {
    const base = JSON.parse(await readFile(packageFile, 'utf8'));
    const path = 'C:\\fresh-stage\\update-policy.json';
    const config = signedConfiguration(base, 'output', 'native', policy, path);
    expect(
      config.extraResources.filter(
        (entry) => entry.to === 'update-policy.json',
      ),
    ).toEqual([{ from: path, to: 'update-policy.json' }]);
    expect(() =>
      signedConfiguration(
        {
          ...base,
          extraResources: [
            ...base.extraResources,
            { from: 'stale.json', to: 'update-policy.json' },
          ],
        },
        'output',
        'native',
        policy,
        path,
      ),
    ).toThrow('fresh signed-build');
  });
  it('requires explicit local Windows signing material and independent identity pins', () => {
    expect(signingPolicy(environment, 'win32')).toEqual(policy);
    expect(
      signingPolicy(
        { ...environment, WINDOWS_SIGNING_CERT_SHA256: 'A'.repeat(64) },
        'win32',
      ),
    ).toEqual(policy);
    expect(() => signingPolicy(environment, 'linux')).toThrow(
      'require Windows',
    );
    for (const WIN_CSC_LINK of [
      '',
      'candidate.pfx',
      'C:candidate.pfx',
      '\\\\server\\private\\candidate.pfx',
      'https://private.example/candidate.pfx',
      'base64-private-certificate',
      'C:\\private\\candidate.txt',
      'C:\\private\\candidate.pfx\n',
    ])
      expect(() =>
        signingPolicy({ ...environment, WIN_CSC_LINK }, 'win32'),
      ).toThrow('WIN_CSC_LINK');
    for (const key of [
      'WIN_CSC_KEY_PASSWORD',
      'WINDOWS_SIGNING_CERT_SHA256',
      'WINDOWS_PUBLISHER_NAME',
    ]) {
      const missing = { ...environment };
      delete missing[key];
      expect(() => signingPolicy(missing, 'win32')).toThrow();
    }
    expect(() =>
      signingPolicy(
        { ...environment, WINDOWS_PUBLISHER_NAME: 'publisher\nprivate' },
        'win32',
      ),
    ).toThrow('independently verified');
    expect(() =>
      signingPolicy(
        { ...environment, ELECTRON_BUILDER_OFFLINE: 'true' },
        'win32',
      ),
    ).toThrow('Timestamping');
    for (const [key, value] of [
      ['WINDOWS_SIGNING_CERT_SHA256', `${policy.certificate_sha256}\n`],
      ['WINDOWS_PUBLISHER_NAME', `${policy.publisher}\n`],
      ['WINDOWS_PUBLISHER_NAME', `${policy.publisher}\r`],
    ])
      expect(() =>
        signingPolicy({ ...environment, [key]: value }, 'win32'),
      ).toThrow('independently verified');
  });
  it('does not forward signing, model, login or Node bootstrap secrets to builds or the verifier', () => {
    const child = childEnvironment({
      ...environment,
      PATH: 'synthetic-path',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      ProgramFiles: 'C:\\Program Files',
      ProgramData: 'C:\\ProgramData',
      NODE_OPTIONS: '--import=private-bootstrap.mjs',
      NODE_EXTRA_CA_CERTS: 'private-ca.pem',
      AZURE_OPENAI_API_KEY: 'private-model-key',
      DELETION_ARCHIVE_SECRET_ACCESS_KEY: 'private-archive-key',
      WINDOWS_SIGNING_PFX_BASE64: 'private-certificate',
      GITHUB_TOKEN: 'private-github-token',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(child).toEqual({
      PATH: 'synthetic-path',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      ProgramFiles: 'C:\\Program Files',
      ProgramData: 'C:\\ProgramData',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      POWERSHELL_TELEMETRY_OPTOUT: '1',
      POWERSHELL_UPDATECHECK: 'Off',
    });
  });
  it('requires an explicit local PowerShell 7 producer tool without PATH or legacy fallback', () => {
    expect(windowsVerifierPath({ ProgramFiles: 'C:\\Program Files' })).toBe(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    for (const ProgramFiles of [
      undefined,
      '',
      'relative',
      '\\\\remote\\tools',
      'C:\\Program Files\n',
    ])
      expect(() => windowsVerifierPath({ ProgramFiles })).toThrow(
        'requires PowerShell 7',
      );
  });
  it.each([
    { status: 'NotSigned' },
    { status: 'NotTrusted' },
    { status: 'HashMismatch' },
    { signature_type: 'Catalog' },
    { timestamped: false },
    { certificate_sha256: 'c'.repeat(64) },
    { certificate_sha256: null },
    { publisher: 'Another publisher' },
    { publisher: null },
  ])(
    'rejects signatures that do not satisfy the complete trust policy: %j',
    (change) => {
      expect(() =>
        assertSignature({ ...signature, ...change }, policy),
      ).toThrow('pinned certificate');
    },
  );
  it('validates the exact verifier protocol without reflecting unexpected output', () => {
    expect(assertSignature(signature, policy)).toEqual(signature);
    for (const value of [
      null,
      [],
      {},
      { ...signature, version: 2 },
      { ...signature, status: 'private-status' },
      { ...signature, certificate_sha256: 'A'.repeat(64) },
      { ...signature, certificate_sha256: `${policy.certificate_sha256}\n` },
      { ...signature, publisher: `${policy.publisher}\n` },
      { ...signature, timestamped: 1 },
      { ...signature, private: 'private-marker' },
    ]) {
      try {
        assertSignature(value, policy);
        throw new Error('Expected rejection.');
      } catch (error) {
        expect(error.message).toBe(
          'Windows signature inspection returned invalid metadata.',
        );
        expect(error.message).not.toContain('private-marker');
      }
    }
  });
  it('preserves installation identity and data policy while signing all first-party executable modules', async () => {
    const base = JSON.parse(await readFile(packageFile, 'utf8'));
    const before = structuredClone(base);
    const config = signedConfiguration(
      base,
      'fresh-output',
      'fresh-native',
      policy,
    );
    expect(base).toEqual(before);
    expect(config).toMatchObject({
      appId: base.appId,
      productName: base.productName,
      asar: true,
      forceCodeSigning: true,
      publish: null,
      artifactName: 'windows-ai-notes-${version}-${arch}-signed.${ext}',
      directories: { output: 'fresh-output' },
      nsis: { perMachine: false, deleteAppDataOnUninstall: false },
      win: {
        signExecutable: true,
        signAndEditExecutable: true,
        signExts: ['AudioHost.dll', 'AudioHost.Core.dll'],
        verifyUpdateCodeSignature: true,
        signtoolOptions: {
          signingHashAlgorithms: ['sha256'],
          publisherName: policy.publisher,
          rfc3161TimeStampServer: 'http://timestamp.digicert.com',
        },
      },
    });
    expect(
      config.extraResources.find((entry) => entry.to === 'audio-host'),
    ).toEqual({
      ...base.extraResources.find((entry) => entry.to === 'audio-host'),
      from: 'fresh-native',
    });
    expect(config.files).toEqual([
      'dist/main/main.js',
      'dist/preload.cjs',
      'dist/renderer/**/*',
      'package.json',
    ]);
    expect(JSON.stringify(config)).not.toContain(
      environment.WIN_CSC_KEY_PASSWORD,
    );
    expect(JSON.stringify(config)).not.toContain(policy.certificate);
    for (const extraResources of [
      undefined,
      null,
      {},
      [],
      [null],
      [
        ...base.extraResources,
        base.extraResources.find((entry) => entry.to === 'audio-host'),
      ],
    ])
      expect(() =>
        signedConfiguration(
          { ...base, extraResources },
          'output',
          'native',
          policy,
        ),
      ).toThrow('exactly one');
  });
  it('uses configuration and public build targets accepted by the pinned official builder', async () => {
    const local = createRequire(new URL('./package.json', import.meta.url));
    const linked = createRequire(
      local.resolve('electron-builder/package.json'),
    );
    const { validateConfiguration } = linked(
      'app-builder-lib/out/util/config/config.js',
    );
    const { Platform, Arch } = await import('electron-builder');
    const base = JSON.parse(await readFile(packageFile, 'utf8'));
    await validateConfiguration(
      signedConfiguration(
        base,
        'C:\\candidate\\output',
        'C:\\candidate\\native',
        policy,
      ),
      { isEnabled: false },
    );
    expect(
      Platform.WINDOWS.createTarget('nsis', Arch.x64)
        .get(Platform.WINDOWS)
        .get(Arch.x64),
    ).toEqual(['nsis']);
  });
  it('hashes the inspected bytes exactly and detects changes during inspection', async () => {
    const paths = await fixture(),
      file = join(paths.output, expectedFiles[0]);
    const bytes = await readFile(file);
    expect(await verifiedFile(file, policy, async () => signature)).toEqual({
      bytes: String(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sha512: createHash('sha512').update(bytes).digest('base64'),
      certificate_sha256: policy.certificate_sha256,
      publisher: policy.publisher,
      timestamped: true,
    });
    await expect(
      verifiedFile(file, policy, async () => {
        await writeFile(file, 'changed-after-inspection-started');
        return signature;
      }),
    ).rejects.toThrow('changed during');
  });
  it('rejects empty files, directories, symbolic links and absent artifacts rather than accepting signature metadata alone', async () => {
    const paths = await fixture(),
      file = join(paths.output, expectedFiles[0]);
    await writeFile(file, '');
    const inspect = vi.fn(async () => signature);
    await expect(verifiedFile(file, policy, inspect)).rejects.toThrow('empty');
    await expect(verifiedFile(paths.output, policy, inspect)).rejects.toThrow(
      'regular file',
    );
    await expect(
      verifiedFile(join(paths.output, 'absent'), policy, inspect),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(inspect).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')(
    'does not follow an artifact symlink',
    async () => {
      const paths = await fixture(),
        linked = join(paths.output, 'linked.exe');
      await symlink(join(paths.output, expectedFiles[0]), linked);
      await expect(
        verifiedFile(linked, policy, async () => signature),
      ).rejects.toThrow('regular file');
    },
  );
  it('publishes only after the installer, desktop and all bundled first-party helper modules pass verification', async () => {
    const paths = await fixture();
    const inspect = vi.fn(async () => signature);
    const receipt = await promoteCandidate(paths, inspect);
    expect(receipt).toMatchObject({
      version: 1,
      kind: 'signed_candidate',
      application_version: version,
      architecture: 'x64',
      source_commit: commit,
      production_accepted: false,
      installer: expectedFiles[0],
    });
    expect(Object.keys(receipt.artifacts)).toEqual(expectedFiles);
    expect(inspect).toHaveBeenCalledTimes(5);
    expect(
      JSON.parse(
        await readFile(
          join(paths.destination, 'signed-candidate.json'),
          'utf8',
        ),
      ),
    ).toEqual(receipt);
    await expect(readdir(paths.output)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const marker of [
      environment.WIN_CSC_KEY_PASSWORD,
      policy.certificate,
      paths.output,
    ])
      expect(JSON.stringify(receipt)).not.toContain(marker);
  });
  it('derives an optional feed only from the completely verified installer without claiming production acceptance', async () => {
    const paths = await fixture();
    const receipt = await promoteCandidate(
      { ...paths, updates: true },
      async () => signature,
    );
    const feed = JSON.parse(
      await readFile(join(paths.destination, 'windows-update.json'), 'utf8'),
    );
    const installer = receipt.artifacts[receipt.installer];
    expect(feed).toEqual({
      version: 1,
      kind: 'windows_update',
      application_version: version,
      architecture: 'x64',
      installer: receipt.installer,
      bytes: Number(installer.bytes),
      sha512: installer.sha512,
    });
    expect(receipt.production_accepted).toBe(false);
    const plain = await fixture();
    await promoteCandidate(plain, async () => signature);
    await expect(
      readFile(join(plain.destination, 'windows-update.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const failed = await fixture();
    await expect(
      promoteCandidate({ ...failed, updates: true }, async () => ({
        ...signature,
        status: 'NotSigned',
      })),
    ).rejects.toThrow('trusted, timestamped');
    await expect(
      readFile(join(failed.output, 'windows-update.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(expectedFiles)(
    'never publishes partial output when this required signature fails: %s',
    async (rejected) => {
      const paths = await fixture();
      await expect(
        promoteCandidate(paths, async (file) =>
          file === join(paths.output, rejected)
            ? { ...signature, status: 'NotSigned' }
            : signature,
        ),
      ).rejects.toThrow('trusted, timestamped');
      await expect(readdir(paths.destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(join(paths.output, 'signed-candidate.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('does not overwrite an existing verified candidate or claim a source commit for an invalid version', async () => {
    const paths = await fixture();
    await mkdir(paths.destination);
    await expect(
      promoteCandidate(paths, async () => signature),
    ).rejects.toMatchObject({ code: 'release_exists' });
    expect(await readdir(paths.destination)).toEqual([]);
    await writeFile(
      join(paths.destination, 'existing.json'),
      'preserve-existing-candidate',
    );
    await expect(
      promoteCandidate(paths, async () => signature),
    ).rejects.toThrow();
    expect(
      await readFile(join(paths.destination, 'existing.json'), 'utf8'),
    ).toBe('preserve-existing-candidate');
    for (const invalid of [
      { version: '../outside' },
      { version: `${version}\n` },
      { commit: 'not-a-commit' },
      { commit: `${commit}\n` },
    ]) {
      const source = await fixture();
      await expect(
        promoteCandidate({ ...source, ...invalid }, async () => signature),
      ).rejects.toThrow();
      await expect(readdir(source.destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });
  it('keeps command errors concise and secret-free without starting builds for unexpected arguments', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./release.mjs', import.meta.url)), '--unsigned'],
      {
        env: { ...process.env, ...environment },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('release_arguments');
    expect(result.stderr).not.toContain(environment.WIN_CSC_KEY_PASSWORD);
    expect(result.stderr).not.toContain(policy.certificate);
  });
});
