import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';
import {
  compareUpdateVersions,
  updateExpectationSchema,
  updateInstallationSchema,
  verifiedUpdateArtifactSchema,
  type UpdateExpectation,
} from '@windows-ai-notes/contracts/updates';

export type { UpdateExpectation } from '@windows-ai-notes/contracts/updates';
const verifiedSchema = z.strictObject({
  version: z.literal(1),
  verified: z.literal(true),
  code: z.literal('update_verified'),
  artifact: verifiedUpdateArtifactSchema,
});
const verifiedInstallerSchema = verifiedSchema.extend({
  code: z.literal('update_installer_verified'),
});
const rejectedSchema = z.strictObject({
  version: z.literal(1),
  verified: z.literal(false),
  code: z.enum([
    'update_verification_arguments',
    'update_artifact_invalid',
    'update_signature_invalid',
    'update_signature_digest',
    'update_timestamp_missing',
    'update_timestamp_invalid',
    'update_identity_mismatch',
    'update_installer_mismatch',
    'update_artifact_unavailable',
  ]),
  artifact: z.null(),
});
const installationResultSchema = z.strictObject({
  version: z.literal(1),
  registered: z.literal(true),
  code: z.literal('update_installation_verified'),
  installation: updateInstallationSchema,
});
const installationRejectionSchema = z.strictObject({
  version: z.literal(1),
  registered: z.literal(false),
  code: z.enum([
    'update_installation_arguments',
    'update_installation_platform',
    'update_installation_location',
    'update_installation_helper',
    'update_installation_machine',
    'update_installation_missing',
    'update_installation_mismatch',
    'update_installation_identity',
    'update_installation_architecture',
    'update_installation_unavailable',
  ]),
  installation: z.null(),
});
function expectation(value: unknown): UpdateExpectation {
  const parsed = updateExpectationSchema.safeParse(value);
  if (!parsed.success)
    throw new LocalError(
      'update_policy_invalid',
      'The update version, signing policy or file metadata is invalid.',
    );
  if (
    compareUpdateVersions(parsed.data.version, parsed.data.current_version) <= 0
  )
    throw new LocalError(
      'update_not_newer',
      'An update must be newer than the running application. Downgrades were not permitted.',
    );
  return parsed.data;
}

export function assertVerifiedUpdate(value: unknown, expected: unknown) {
  return assertVerifiedArtifact(value, expected, false);
}

export function assertVerifiedInstaller(value: unknown, expected: unknown) {
  return assertVerifiedArtifact(value, expected, true);
}

function assertVerifiedArtifact(
  value: unknown,
  expected: unknown,
  installer: boolean,
) {
  const policy = expectation(expected);
  const parsed = (
    installer ? verifiedInstallerSchema : verifiedSchema
  ).safeParse(value);
  if (!parsed.success)
    throw new LocalError(
      'update_verifier_protocol',
      'The native update verifier returned invalid metadata.',
    );
  const artifact = parsed.data.artifact;
  if (
    artifact.certificate_sha256 !== policy.certificate_sha256 ||
    artifact.publisher !== policy.publisher ||
    artifact.product_name !== policy.product_name ||
    ![policy.version, `${policy.version}.0`].includes(
      artifact.product_version,
    ) ||
    artifact.bytes !== policy.bytes ||
    artifact.sha512 !== policy.sha512
  )
    throw new LocalError(
      'update_artifact_mismatch',
      'The installer does not match the pinned application identity, version, size and digest.',
    );
  return artifact;
}

export async function verifyUpdateArtifact(
  executable: string,
  file: string,
  expected: unknown,
  signal?: AbortSignal,
) {
  return verifyArtifact(executable, file, expected, signal, false);
}

export async function verifyInstallerUpdateArtifact(
  executable: string,
  file: string,
  expected: unknown,
  signal?: AbortSignal,
) {
  return verifyArtifact(executable, file, expected, signal, true);
}

export async function verifyUpdateInstallation(
  helper: string,
  executable: string,
  version: string,
  productName: string,
  signal?: AbortSignal,
) {
  assertExecutablePaths(helper, executable);
  const expected = updateInstallationSchema.safeParse({
    directory: win32.dirname(executable),
    executable,
    application_version: version,
    product_name: productName,
    architecture: 'x64',
  });
  if (!expected.success || win32.normalize(executable) !== executable)
    throw new LocalError(
      'update_installation_arguments',
      'A canonical installed executable, stable version and product identity are required.',
    );
  const { value, exitCode } = await invokeVerifier(
    helper,
    ['--verify-update-installation', executable, version, productName],
    signal,
  );
  if (exitCode !== 0) {
    const rejected = installationRejectionSchema.safeParse(value);
    throw new LocalError(
      rejected.success ? rejected.data.code : 'update_verifier_protocol',
      'This application is not a verified per-user installation. No installer was started.',
    );
  }
  const verified = installationResultSchema.safeParse(value);
  if (!verified.success)
    throw new LocalError(
      'update_verifier_protocol',
      'The native installation verifier returned invalid metadata.',
    );
  const installation = verified.data.installation;
  if (
    installation.executable.toLowerCase() !== executable.toLowerCase() ||
    installation.directory.toLowerCase() !==
      expected.data.directory.toLowerCase() ||
    installation.application_version !== version ||
    installation.product_name !== productName
  )
    throw new LocalError(
      'update_installation_mismatch',
      'The registered installation does not match the running application.',
    );
  return installation;
}

function assertExecutablePaths(...paths: string[]) {
  for (const path of paths)
    if (
      !/^[A-Za-z]:[\\/]/u.test(path) ||
      !win32.isAbsolute(path) ||
      !/\.exe$/iu.test(path) ||
      /[\u0000-\u001f\u007f]/u.test(path)
    )
      throw new LocalError(
        'update_path_invalid',
        'The update verifier and installer must be local absolute executable paths.',
      );
}

async function verifyArtifact(
  executable: string,
  file: string,
  expected: unknown,
  signal: AbortSignal | undefined,
  installer: boolean,
) {
  const policy = expectation(expected);
  assertExecutablePaths(executable, file);
  const { value, exitCode } = await invokeVerifier(
    executable,
    [
      installer ? '--verify-installer-update' : '--verify-update',
      file,
      policy.certificate_sha256,
      policy.publisher,
      policy.product_name,
      policy.version,
    ],
    signal,
  );
  if (exitCode !== 0) {
    const rejected = rejectedSchema.safeParse(value);
    throw new LocalError(
      rejected.success ? rejected.data.code : 'update_verifier_protocol',
      'The native verifier rejected the update. No installer was accepted.',
    );
  }
  return assertVerifiedArtifact(value, policy, installer);
}

async function invokeVerifier(
  executable: string,
  args: string[],
  signal?: AbortSignal,
) {
  let stdout: string;
  let exitCode = 0;
  try {
    ({ stdout } = await promisify(execFile)(executable, args, {
      cwd: win32.dirname(executable),
      env: audioHostEnvironment(process.env),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16_384,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    }));
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 2 &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    ) {
      stdout = error.stdout;
      exitCode = 2;
    } else
      throw new LocalError(
        'update_verifier_failed',
        'Native Windows update verification failed or timed out. No installer was accepted.',
      );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new LocalError(
      'update_verifier_protocol',
      'Native Windows update verification did not return valid JSON.',
    );
  }
  return { value, exitCode };
}
