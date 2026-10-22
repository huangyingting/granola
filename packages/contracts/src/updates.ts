import { z } from 'zod';

const label = z
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
export const updateVersionSchema = z
  .string()
  .max(32)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
  .refine((value) => value === value.trim())
  .refine((value) => value.split('.').every((part) => Number(part) <= 65_535));
const httpsFeed = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.href === value &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes('?') &&
        !value.includes('#') &&
        url.pathname.endsWith('.json')
      );
    } catch {
      return false;
    }
  });
const identity = {
  certificate_sha256: certificateHash,
  publisher: label,
  product_name: label,
};
export const packagedUpdatePolicySchema = z.strictObject({
  version: z.literal(1),
  feed_url: httpsFeed,
  ...identity,
});
export const updateFeedSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('windows_update'),
    application_version: updateVersionSchema,
    architecture: z.literal('x64'),
    installer: z.string().max(150),
    bytes,
    sha512,
  })
  .refine(
    (value) =>
      value.installer ===
      `windows-ai-notes-${value.application_version}-x64-signed.exe`,
  );
export const updateExpectationSchema = z.strictObject({
  current_version: updateVersionSchema,
  version: updateVersionSchema,
  ...identity,
  bytes,
  sha512,
});
export const verifiedUpdateArtifactSchema = z.strictObject({
  bytes,
  sha512,
  ...identity,
  product_version: label,
});
const localWindowsPath = z
  .string()
  .min(4)
  .max(2048)
  .regex(/^[A-Za-z]:\\/u)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
export const updateInstallationSchema = z.strictObject({
  directory: localWindowsPath,
  executable: localWindowsPath,
  application_version: updateVersionSchema,
  product_name: label,
  architecture: z.literal('x64'),
});
export const cachedUpdateSchema = z.strictObject({
  version: z.literal(1),
  feed: updateFeedSchema,
  expected: updateExpectationSchema,
  verified_at: z.iso.datetime(),
});
export const desktopUpdateCommandSchema = z.strictObject({
  operation: z.enum(['getState', 'check', 'download', 'cancel']),
});
const updateError = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
  message: z.string().min(1).max(600),
});
export const desktopUpdateStateSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  installed_version: label,
  phase: z.enum([
    'initializing',
    'disabled',
    'recovering',
    'idle',
    'checking',
    'current',
    'available',
    'downloading',
    'ready',
    'cancelling',
    'cancelled',
    'failed',
  ]),
  available_version: updateVersionSchema.nullable(),
  download_bytes: bytes.nullable(),
  can_check: z.boolean(),
  can_download: z.boolean(),
  can_cancel: z.boolean(),
  installation_enabled: z.literal(false),
  cache: z
    .strictObject({
      removed: z.number().int().min(0).max(128),
      rejected: z.number().int().min(0).max(128),
      incomplete: z.number().int().min(0).max(128),
    })
    .nullable(),
  error: updateError.nullable(),
});
export const desktopUpdateResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), state: desktopUpdateStateSchema }),
  z.strictObject({ ok: z.literal(false), error: updateError }),
]);
export type DesktopUpdateCommand = z.infer<typeof desktopUpdateCommandSchema>;
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;
export type DesktopUpdateResponse = z.infer<typeof desktopUpdateResponseSchema>;
export type PackagedUpdatePolicy = z.infer<typeof packagedUpdatePolicySchema>;
export type UpdateFeed = z.infer<typeof updateFeedSchema>;
export type UpdateExpectation = z.infer<typeof updateExpectationSchema>;
export type VerifiedUpdateArtifact = z.infer<
  typeof verifiedUpdateArtifactSchema
>;

export function compareUpdateVersions(candidate: string, installed: string) {
  const current = updateVersionSchema.parse(installed).split('.').map(Number);
  return Math.sign(
    updateVersionSchema
      .parse(candidate)
      .split('.')
      .map((part, index) => Number(part) - Number(current[index]))
      .find((part) => part !== 0) ?? 0,
  );
}
