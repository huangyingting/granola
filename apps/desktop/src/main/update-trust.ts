import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { LocalError } from '@windows-ai-notes/local';

const text = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  );
const certificateHash = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]+$/u);
const sha512 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{86}==$/u)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value);
const bytes = z
  .number()
  .int()
  .positive()
  .max(2 * 1024 ** 3);
const version = z
  .string()
  .max(32)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
  .refine((value) => value === value.trim())
  .refine((value) => value.split('.').every((part) => Number(part) <= 65_535));
const expectationSchema = z.strictObject({
  current_version: version,
  version,
  certificate_sha256: certificateHash,
  publisher: text,
  product_name: text,
  bytes,
  sha512,
});
const verifiedSchema = z.strictObject({
  version: z.literal(1),
  verified: z.literal(true),
  code: z.literal('update_verified'),
  artifact: z.strictObject({
    bytes,
    sha512,
    certificate_sha256: certificateHash,
    publisher: text,
    product_name: text,
    product_version: text,
  }),
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
    'update_artifact_unavailable',
  ]),
  artifact: z.null(),
});
export type UpdateExpectation = z.infer<typeof expectationSchema>;

function expectation(value: unknown): UpdateExpectation {
  const parsed = expectationSchema.safeParse(value);
  if (!parsed.success)
    throw new LocalError(
      'update_policy_invalid',
      'The update version, signing policy or file metadata is invalid.',
    );
  const current = parsed.data.current_version.split('.').map(Number);
  const difference = parsed.data.version
    .split('.')
    .map((part, index) => Number(part) - Number(current[index]))
    .find((part) => part !== 0);
  if (difference === undefined || difference <= 0)
    throw new LocalError(
      'update_not_newer',
      'An update must be newer than the running application. Downgrades were not permitted.',
    );
  return parsed.data;
}

export function assertVerifiedUpdate(value: unknown, expected: unknown) {
  const policy = expectation(expected);
  const parsed = verifiedSchema.safeParse(value);
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
        '--verify-update',
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
  return assertVerifiedUpdate(value, policy);
}
