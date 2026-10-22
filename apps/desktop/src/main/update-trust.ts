import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';
import {
  compareUpdateVersions,
  updateExpectationSchema,
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

async function verifyArtifact(
  executable: string,
  file: string,
  expected: unknown,
  signal: AbortSignal | undefined,
  installer: boolean,
) {
  const policy = expectation(expected);
  for (const path of [executable, file])
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
  let stdout: string;
  let exitCode = 0;
  try {
    ({ stdout } = await promisify(execFile)(
      executable,
      [
        installer ? '--verify-installer-update' : '--verify-update',
        file,
        policy.certificate_sha256,
        policy.publisher,
        policy.product_name,
        policy.version,
      ],
      {
        cwd: win32.dirname(executable),
        env: audioHostEnvironment(process.env),
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16_384,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
    ));
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
  if (exitCode !== 0) {
    const rejected = rejectedSchema.safeParse(value);
    throw new LocalError(
      rejected.success ? rejected.data.code : 'update_verifier_protocol',
      'The native verifier rejected the update. No installer was accepted.',
    );
  }
  return assertVerifiedArtifact(value, policy, installer);
}
