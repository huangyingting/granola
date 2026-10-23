import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { isAbsolute, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const desktop = fileURLToPath(new URL('./', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const certificateHash = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]+$/);
const sourceCommit = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]+$/);
const publisherName = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const versionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  .refine((value) => value === value.trim());
const signatureSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum([
    'Valid',
    'UnknownError',
    'NotSigned',
    'HashMismatch',
    'NotTrusted',
    'NotSupportedFileFormat',
    'Incompatible',
  ]),
  signature_type: z.enum(['None', 'Authenticode', 'Catalog']),
  certificate_sha256: certificateHash.nullable(),
  publisher: publisherName.nullable(),
  timestamped: z.boolean(),
});
const helperFiles = ['AudioHost.exe', 'AudioHost.dll', 'AudioHost.Core.dll'];
const childVariables = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'SystemDrive',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'ALLUSERSPROFILE',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'DOTNET_ROOT',
  'DOTNET_ROOT_X64',
  'NUGET_PACKAGES',
  'PNPM_HOME',
];

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function signingPolicy(
  environment = process.env,
  platform = process.platform,
) {
  if (platform !== 'win32')
    throw new ReleaseError(
      'release_platform',
      'Signed candidates require Windows Authenticode verification.',
    );
  const certificate = environment.WIN_CSC_LINK;
  if (
    !certificate ||
    !/^[A-Za-z]:[\\/]/.test(certificate) ||
    !win32.isAbsolute(certificate) ||
    !/\.(pfx|p12)$/i.test(certificate) ||
    /[\u0000-\u001f\u007f]/.test(certificate)
  )
    throw new ReleaseError(
      'release_certificate',
      'Set WIN_CSC_LINK to an absolute local PFX/P12 file; certificate downloads and implicit certificate selection are not allowed.',
    );
  if (!environment.WIN_CSC_KEY_PASSWORD)
    throw new ReleaseError(
      'release_password',
      'WIN_CSC_KEY_PASSWORD is required.',
    );
  const hash = (environment.WINDOWS_SIGNING_CERT_SHA256 ?? '').toLowerCase();
  const publisher = environment.WINDOWS_PUBLISHER_NAME;
  if (
    !certificateHash.safeParse(hash).success ||
    !publisherName.safeParse(publisher).success
  )
    throw new ReleaseError(
      'release_identity',
      'Set the independently verified WINDOWS_SIGNING_CERT_SHA256 and exact WINDOWS_PUBLISHER_NAME.',
    );
  if (environment.ELECTRON_BUILDER_OFFLINE === 'true')
    throw new ReleaseError(
      'release_timestamp',
      'Timestamping is mandatory; offline signing is not supported.',
    );
  return { certificate, certificate_sha256: hash, publisher };
}
export function childEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(
      childVariables
        .filter((key) => environment[key])
        .map((key) => [key, environment[key]]),
    ),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
  };
}
export function windowsVerifierPath(environment = process.env) {
  const root = environment.ProgramFiles;
  if (
    !root ||
    !/^[A-Za-z]:[\\/]/.test(root) ||
    /[\u0000-\u001f\u007f]/.test(root)
  )
    throw new ReleaseError(
      'release_verifier',
      'The signed-candidate producer requires PowerShell 7 in the local Program Files directory.',
    );
  return win32.join(root, 'PowerShell', '7', 'pwsh.exe');
}
async function requireVerifier(environment) {
  const file = windowsVerifierPath(environment);
  let stat;
  try {
    stat = await lstat(file);
  } catch {
    throw new ReleaseError(
      'release_verifier',
      'The PowerShell 7 verifier is missing or unreadable.',
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ReleaseError(
      'release_verifier',
      'The PowerShell 7 verifier must be a regular local executable.',
    );
  return file;
}
export function assertSignature(value, policy) {
  const parsed = signatureSchema.safeParse(value);
  if (!parsed.success)
    throw new ReleaseError(
      'release_signature_protocol',
      'Windows signature inspection returned invalid metadata.',
    );
  const signature = parsed.data;
  if (
    signature.status !== 'Valid' ||
    signature.signature_type !== 'Authenticode' ||
    !signature.timestamped ||
    signature.certificate_sha256 !== policy.certificate_sha256 ||
    signature.publisher !== policy.publisher
  )
    throw new ReleaseError(
      'release_signature',
      'An artifact lacks a trusted, timestamped Authenticode signature from the pinned certificate and publisher.',
    );
  return signature;
}

const inspectScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
[Console]::Error.WriteLine('NOTES_SIGNATURE_LOOKUP')
$signature = Get-AuthenticodeSignature -LiteralPath $env:NOTES_RELEASE_FILE -ErrorAction Stop
[Console]::Error.WriteLine('NOTES_SIGNATURE_METADATA')
$hash = $null
$publisher = $null
if ($null -ne $signature.SignerCertificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
}
[ordered]@{
  version = 1
  status = $signature.Status.ToString()
  signature_type = $signature.SignatureType.ToString()
  certificate_sha256 = $hash
  publisher = $publisher
  timestamped = ($null -ne $signature.TimeStamperCertificate)
} | ConvertTo-Json -Compress
`;
export async function inspectWindowsSignature(file, environment = process.env) {
  if (process.platform !== 'win32')
    throw new ReleaseError(
      'release_platform',
      'Windows is required to inspect Authenticode signatures.',
    );
  const verifier = await requireVerifier(environment);
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(
      verifier,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspectScript],
      {
        env: { ...childEnvironment(environment), NOTES_RELEASE_FILE: file },
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16_384,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const timedOut =
      error?.killed === true &&
      error?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const phase = stderr.includes('NOTES_SIGNATURE_METADATA')
      ? 'metadata projection'
      : stderr.includes('NOTES_SIGNATURE_LOOKUP')
        ? 'signature lookup'
        : 'process initialization';
    throw new ReleaseError(
      timedOut ? 'release_verifier_timeout' : 'release_verifier',
      `Windows signature inspection ${timedOut ? 'timed out' : 'failed'} during ${phase}; no artifact was accepted.`,
    );
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ReleaseError(
      'release_signature_protocol',
      'Windows signature inspection did not return JSON.',
    );
  }
  const parsed = signatureSchema.safeParse(value);
  if (!parsed.success)
    throw new ReleaseError(
      'release_signature_protocol',
      'Windows signature inspection returned invalid metadata.',
    );
  return parsed.data;
}
export async function verifiedFile(
  file,
  policy,
  inspect = inspectWindowsSignature,
) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size === 0n)
    throw new ReleaseError(
      'release_artifact',
      'A required artifact is missing, empty or not a regular file.',
    );
  const signature = assertSignature(await inspect(file), policy);
  const sha256 = createHash('sha256'),
    sha512 = createHash('sha512');
  let bytes = 0n;
  for await (const chunk of createReadStream(file)) {
    bytes += BigInt(chunk.length);
    sha256.update(chunk);
    sha512.update(chunk);
  }
  const after = await lstat(file, { bigint: true });
  if (
    !after.isFile() ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    bytes !== after.size
  )
    throw new ReleaseError(
      'release_artifact_changed',
      'An artifact changed during signature and digest verification.',
    );
  return {
    bytes: bytes.toString(),
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('base64'),
    certificate_sha256: signature.certificate_sha256,
    publisher: signature.publisher,
    timestamped: true,
  };
}
export async function updatePolicy(environment, productName, policy) {
  const url = environment.WINDOWS_UPDATE_FEED_URL;
  if (url === undefined || url === '') return null;
  const { packagedUpdatePolicySchema } =
    await import('@windows-ai-notes/contracts/updates');
  const parsed = packagedUpdatePolicySchema.safeParse({
    version: 1,
    feed_url: url,
    certificate_sha256: policy.certificate_sha256,
    publisher: policy.publisher,
    product_name: productName,
  });
  if (!parsed.success)
    throw new ReleaseError(
      'release_update_policy',
      'WINDOWS_UPDATE_FEED_URL must be a canonical direct HTTPS JSON URL without credentials, query parameters or a fragment.',
    );
  return parsed.data;
}
export function signedConfiguration(
  base,
  output,
  native,
  policy,
  updatePolicyFile,
) {
  if (
    base.appId !== 'io.github.windowsainotes.desktop' ||
    base.nsis?.script ||
    (base.nsis?.guid !== undefined &&
      base.nsis.guid !== 'dbdb543e-07bd-5ef6-99a5-00d80b9bdfb6')
  )
    throw new ReleaseError(
      'release_installer_identity',
      'The signed installer requires the existing application identity and the first-party NSIS template.',
    );
  if (
    !Array.isArray(base.extraResources) ||
    base.extraResources.filter((entry) => entry?.to === 'audio-host').length !==
      1
  )
    throw new ReleaseError(
      'release_resources',
      'The preview package must declare exactly one bundled audio helper.',
    );
  if (base.extraResources.some((entry) => entry?.to === 'update-policy.json'))
    throw new ReleaseError(
      'release_update_resources',
      'The update policy must come only from the fresh signed-build staging directory.',
    );
  return {
    ...base,
    artifactName: 'windows-ai-notes-${version}-${arch}-signed.${ext}',
    directories: { ...base.directories, output },
    files: [
      'dist/main/main.js',
      'dist/preload.cjs',
      'dist/renderer/**/*',
      'package.json',
    ],
    extraResources: [
      ...base.extraResources.map((entry) =>
        entry?.to === 'audio-host' ? { ...entry, from: native } : entry,
      ),
      ...(updatePolicyFile
        ? [{ from: updatePolicyFile, to: 'update-policy.json' }]
        : []),
    ],
    forceCodeSigning: true,
    publish: null,
    ...(updatePolicyFile
      ? {
          afterSign: (context) =>
            finalizeNativeRuntime(context, {
              helper: join(native, 'AudioHost.exe'),
              version: context.packager.appInfo.version,
              policy,
            }),
        }
      : {}),
    nsis: {
      ...base.nsis,
      include: fileURLToPath(new URL('./build/installer.nsh', import.meta.url)),
      perMachine: false,
      deleteAppDataOnUninstall: false,
    },
    win: {
      ...base.win,
      target: ['nsis'],
      signAndEditExecutable: true,
      signExecutable: true,
      signExts: ['AudioHost.dll', 'AudioHost.Core.dll'],
      verifyUpdateCodeSignature: true,
      signtoolOptions: {
        signingHashAlgorithms: ['sha256'],
        publisherName: policy.publisher,
        rfc3161TimeStampServer: 'http://timestamp.digicert.com',
      },
    },
  };
}
export async function runtimeProvenanceOperation(
  helper,
  operation,
  directory,
  version,
  policy,
  environment = process.env,
) {
  if (
    process.platform !== 'win32' ||
    !['--seal-update-runtime', '--verify-update-runtime'].includes(operation)
  )
    throw new ReleaseError(
      'release_runtime_platform',
      'Runtime provenance requires Windows and a fixed build operation.',
    );
  const args = [operation, directory, version];
  if (operation === '--verify-update-runtime')
    args.push(policy.certificate_sha256, policy.publisher);
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(helper, args, {
      env: childEnvironment(environment),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16_384,
      windowsHide: true,
    }));
  } catch {
    throw new ReleaseError(
      'release_runtime_provenance',
      'Native runtime sealing or signed-payload verification failed; no candidate was accepted.',
    );
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ReleaseError(
      'release_runtime_protocol',
      'Native runtime provenance returned invalid metadata.',
    );
  }
  const result = z.strictObject({
    version: z.literal(1),
    operation: z.literal(operation),
    success: z.literal(true),
    code: z.literal(
      operation === '--seal-update-runtime'
        ? 'update_runtime_sealed'
        : 'update_runtime_verified',
    ),
  });
  if (!result.safeParse(value).success)
    throw new ReleaseError(
      'release_runtime_protocol',
      'Native runtime provenance returned invalid metadata.',
    );
}
export async function finalizeNativeRuntime(
  context,
  { helper, version, policy },
  {
    operate = runtimeProvenanceOperation,
    inspect = inspectWindowsSignature,
  } = {},
) {
  if (
    context.electronPlatformName !== 'win32' ||
    typeof context.packager?.signIf !== 'function'
  )
    throw new ReleaseError(
      'release_runtime_platform',
      'Runtime sealing requires the Windows signing phase.',
    );
  const directory = join(context.appOutDir, 'resources', 'audio-host');
  for (const file of helperFiles)
    await verifiedFile(join(directory, file), policy, inspect);
  await operate(helper, '--seal-update-runtime', directory, version, policy);
  const executable = join(directory, 'AudioHost.exe');
  if (!(await context.packager.signIf(executable)))
    throw new ReleaseError(
      'release_runtime_signing',
      'The sealed runtime executable was not re-signed.',
    );
  await verifiedFile(executable, policy, inspect);
  await operate(helper, '--verify-update-runtime', directory, version, policy);
}
export async function promoteCandidate(
  {
    output,
    destination,
    version,
    commit,
    productName,
    policy,
    updates = false,
  },
  inspect,
  verifyInstaller = verifyInstallerCandidate,
  verifyRuntime = verifyNativeRuntimeCandidate,
) {
  versionSchema.parse(version);
  if (!sourceCommit.safeParse(commit).success)
    throw new ReleaseError(
      'release_source',
      'The release requires an exact source commit.',
    );
  await destinationAvailable(destination);
  const installer = `windows-ai-notes-${version}-x64-signed.exe`;
  const files = [
    installer,
    `win-unpacked/${productName}.exe`,
    ...helperFiles.map((file) => `win-unpacked/resources/audio-host/${file}`),
  ];
  const artifacts = {};
  for (const file of files)
    artifacts[file] = await verifiedFile(join(output, file), policy, inspect);
  if (updates) {
    await verifyRuntime(
      join(output, 'win-unpacked/resources/audio-host'),
      version,
      policy,
    );
    const artifact = artifacts[installer];
    await verifyInstaller(
      join(output, 'win-unpacked/resources/audio-host/AudioHost.exe'),
      join(output, installer),
      {
        current_version: '0.0.0',
        version,
        certificate_sha256: policy.certificate_sha256,
        publisher: policy.publisher,
        product_name: productName,
        bytes: Number(artifact.bytes),
        sha512: artifact.sha512,
      },
    );
  }
  const receipt = {
    version: 1,
    kind: 'signed_candidate',
    application_version: version,
    architecture: 'x64',
    source_commit: commit,
    verified_at: new Date().toISOString(),
    production_accepted: false,
    installer_role_verified: updates,
    runtime_provenance_verified: updates,
    installer,
    artifacts,
  };
  await writeFile(
    join(output, 'signed-candidate.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx' },
  );
  if (updates) {
    const { updateFeedSchema } =
      await import('@windows-ai-notes/contracts/updates');
    const artifact = artifacts[installer];
    const feed = updateFeedSchema.parse({
      version: 1,
      kind: 'windows_update',
      application_version: version,
      architecture: 'x64',
      installer,
      bytes: Number(artifact.bytes),
      sha512: artifact.sha512,
    });
    await writeFile(
      join(output, 'windows-update.json'),
      `${JSON.stringify(feed, null, 2)}\n`,
      { flag: 'wx' },
    );
  }
  await rename(output, destination);
  return receipt;
}
async function verifyInstallerCandidate(helper, file, expected) {
  const { verifyInstallerUpdateArtifact } =
    await import('./dist/main/update-trust.js');
  await verifyInstallerUpdateArtifact(helper, file, expected);
}
async function verifyNativeRuntimeCandidate(directory, version, policy) {
  await runtimeProvenanceOperation(
    join(directory, 'AudioHost.exe'),
    '--verify-update-runtime',
    directory,
    version,
    policy,
  );
}
async function destinationAvailable(destination) {
  try {
    await lstat(destination);
    throw new ReleaseError(
      'release_exists',
      'A signed candidate already exists for this version; no previous candidate was overwritten.',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}
async function run(file, args, cwd, environment, capture = false) {
  if (capture)
    return (
      await promisify(execFile)(file, args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 65_536,
      })
    ).stdout.trim();
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
      timeout: 600_000,
    });
    child.once('error', () =>
      reject(
        new ReleaseError(
          'release_build',
          'A required build tool could not start.',
        ),
      ),
    );
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new ReleaseError('release_build', 'A required build step failed.'),
          ),
    );
  });
}
async function cleanSource(environment) {
  if (
    await run(
      'git',
      ['-c', 'core.fsmonitor=false', 'status', '--porcelain'],
      repository,
      environment,
      true,
    )
  )
    throw new ReleaseError(
      'release_source',
      'Signed candidates require a clean checkout, including staged and untracked files.',
    );
  const commit = await run(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    repository,
    environment,
    true,
  );
  if (!sourceCommit.safeParse(commit).success)
    throw new ReleaseError(
      'release_source',
      'The source commit could not be verified.',
    );
  return commit;
}
export async function acceptanceVersions(version) {
  const { updateVersionSchema } =
    await import('@windows-ai-notes/contracts/updates');
  const parts = String(version).split('.');
  const offered = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
  if (
    !updateVersionSchema.safeParse(version).success ||
    !updateVersionSchema.safeParse(offered).success
  )
    throw new ReleaseError(
      'release_acceptance_version',
      'Signed activation acceptance requires a stable Windows-compatible version with an available next patch.',
    );
  return [version, offered];
}
function packageManager(environment) {
  const manager = process.env.npm_execpath;
  if (!manager || !isAbsolute(manager))
    throw new ReleaseError(
      'release_package_manager',
      'Run this command through the pinned pnpm package manager.',
    );
  return (args) =>
    /\.[cm]?js$/i.test(manager)
      ? run(process.execPath, [manager, ...args], repository, environment)
      : run(manager, args, repository, environment);
}
async function buildCandidate(acceptanceVersion, expectedCommit) {
  const policy = signingPolicy();
  await requireVerifier(process.env);
  const certificate = await lstat(policy.certificate);
  if (
    !certificate.isFile() ||
    certificate.isSymbolicLink() ||
    certificate.size === 0 ||
    certificate.size > 1_048_576
  )
    throw new ReleaseError(
      'release_certificate',
      'The signing certificate must be a nonempty regular local file of at most one MiB.',
    );
  const environment = childEnvironment();
  const commit = await cleanSource(environment);
  if (expectedCommit !== undefined && commit !== expectedCommit)
    throw new ReleaseError(
      'release_source_changed',
      'The source changed after preparing the signed acceptance pair.',
    );
  const manifest = JSON.parse(
    await readFile(new URL('./package.json', import.meta.url), 'utf8'),
  );
  const version = versionSchema.parse(acceptanceVersion ?? manifest.version);
  const base = JSON.parse(
    await readFile(
      new URL('./electron-builder.unsigned.json', import.meta.url),
      'utf8',
    ),
  );
  const pnpm = packageManager(environment);
  const parent = join(repository, 'artifacts', 'desktop-signed');
  await mkdir(parent, { recursive: true });
  const destination = join(parent, version);
  await destinationAvailable(destination);
  const stage = await mkdtemp(join(parent, '.candidate-'));
  try {
    const native = join(stage, 'native'),
      output = join(stage, 'output');
    if (expectedCommit === undefined) await pnpm(['build', '--force']);
    const updates = await updatePolicy(process.env, base.productName, policy);
    if (acceptanceVersion !== undefined && !updates)
      throw new ReleaseError(
        'release_acceptance_policy',
        'Signed activation acceptance requires an explicitly configured update policy.',
      );
    let updatePolicyFile;
    if (updates) {
      const { updateVersionSchema } =
        await import('@windows-ai-notes/contracts/updates');
      if (!updateVersionSchema.safeParse(version).success)
        throw new ReleaseError(
          'release_update_version',
          'Update-enabled candidates require a stable three-part Windows-compatible version.',
        );
      updatePolicyFile = join(stage, 'update-policy.json');
      await writeFile(
        updatePolicyFile,
        `${JSON.stringify(updates, null, 2)}\n`,
        {
          flag: 'wx',
        },
      );
    }
    const project = 'native/audio-host/AudioHost/AudioHost.csproj';
    await run(
      'dotnet',
      ['restore', project, '--locked-mode'],
      repository,
      environment,
    );
    await run(
      'dotnet',
      [
        'build',
        project,
        '--configuration',
        'Release',
        '--runtime',
        'win-x64',
        '--self-contained',
        'true',
        '--no-restore',
        '--no-incremental',
      ],
      repository,
      environment,
    );
    await run(
      'dotnet',
      [
        'publish',
        project,
        '--configuration',
        'Release',
        '--runtime',
        'win-x64',
        '--self-contained',
        'true',
        '--no-restore',
        '--no-build',
        '--output',
        native,
      ],
      repository,
      environment,
    );
    await pnpm(['desktop:build']);
    const { build, Platform, Arch } = await import('electron-builder');
    await build({
      projectDir: desktop,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      publish: 'never',
      config: {
        ...signedConfiguration(base, output, native, policy, updatePolicyFile),
        extraMetadata: { ...base.extraMetadata, version },
      },
    });
    if ((await cleanSource(environment)) !== commit)
      throw new ReleaseError(
        'release_source_changed',
        'The checkout changed during the signed build; no candidate was published.',
      );
    const receipt = await promoteCandidate({
      output,
      destination,
      version,
      commit,
      productName: base.productName,
      policy,
      updates: updates !== null,
    });
    console.log(
      JSON.stringify({
        kind: receipt.kind,
        version,
        source_commit: commit,
        production_accepted: false,
      }),
    );
    return { receipt, updates };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await buildCandidate();
    return;
  }
  if (args.length !== 1 || args[0] !== '--acceptance-pair')
    throw new ReleaseError(
      'release_arguments',
      'The signed-candidate command accepts only the opt-in --acceptance-pair option.',
    );
  const policy = signingPolicy();
  const environment = childEnvironment();
  const commit = await cleanSource(environment);
  await packageManager(environment)(['build', '--force']);
  const manifest = JSON.parse(
    await readFile(new URL('./package.json', import.meta.url), 'utf8'),
  );
  const versions = await acceptanceVersions(manifest.version);
  const base = JSON.parse(
    await readFile(
      new URL('./electron-builder.unsigned.json', import.meta.url),
      'utf8',
    ),
  );
  const updates = await updatePolicy(process.env, base.productName, policy);
  if (!updates)
    throw new ReleaseError(
      'release_acceptance_policy',
      'Signed activation acceptance requires an explicitly configured update policy.',
    );
  const parent = join(repository, 'artifacts', 'desktop-signed');
  const pairFile = join(parent, 'activation-pair.json');
  await destinationAvailable(pairFile);
  for (const version of versions)
    await destinationAvailable(join(parent, version));
  const candidates = [];
  for (const version of versions)
    candidates.push(await buildCandidate(version, commit));
  if (
    candidates.some(
      (candidate) =>
        JSON.stringify(candidate.updates) !== JSON.stringify(updates),
    )
  )
    throw new ReleaseError(
      'release_acceptance_source',
      'Both signed acceptance candidates must use the same source and update policy.',
    );
  await promoteAcceptancePair(candidates, updates, pairFile);
}
export async function promoteAcceptancePair(candidates, updates, destination) {
  if (
    candidates.length !== 2 ||
    candidates.some(
      ({ receipt }) =>
        receipt.version !== 1 ||
        receipt.kind !== 'signed_candidate' ||
        receipt.production_accepted !== false ||
        receipt.installer_role_verified !== true ||
        receipt.runtime_provenance_verified !== true,
    )
  )
    throw new ReleaseError(
      'release_acceptance_candidates',
      'Acceptance bookkeeping requires exactly two update-enabled verified candidates.',
    );
  const { signedUpdateAcceptancePairSchema } =
    await import('@windows-ai-notes/contracts/updates');
  const current = candidates[0];
  const feed = ({ receipt }) => {
    const artifact = receipt.artifacts[receipt.installer];
    if (
      !artifact ||
      artifact.certificate_sha256 !== updates.certificate_sha256 ||
      artifact.publisher !== updates.publisher ||
      artifact.timestamped !== true
    )
      throw new ReleaseError(
        'release_acceptance_identity',
        'Acceptance candidates must retain their independently verified timestamped signer identity.',
      );
    return {
      version: 1,
      kind: 'windows_update',
      application_version: receipt.application_version,
      architecture: receipt.architecture,
      installer: receipt.installer,
      bytes: Number(artifact.bytes),
      sha512: artifact.sha512,
    };
  };
  const pair = signedUpdateAcceptancePairSchema.parse({
    version: 1,
    kind: 'signed_activation_pair',
    scope: 'same_source_compatible_patch',
    source_commit: current.receipt.source_commit,
    production_accepted: false,
    policy: updates,
    current: feed(current),
    offered: feed(candidates[1]),
  });
  if (candidates[1].receipt.source_commit !== pair.source_commit)
    throw new ReleaseError(
      'release_acceptance_source',
      'Acceptance candidates must retain the same exact source commit.',
    );
  await writeFile(destination, `${JSON.stringify(pair, null, 2)}\n`, {
    flag: 'wx',
  });
  return pair;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((error) => {
    console.error(
      error instanceof ReleaseError
        ? `${error.code}: ${error.message}`
        : 'release_failed: Signed-candidate build, verification or cleanup failed.',
    );
    process.exitCode = 1;
  });
