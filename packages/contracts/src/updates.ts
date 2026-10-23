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
export const signedUpdateAcceptancePairSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('signed_activation_pair'),
    scope: z.literal('same_source_compatible_patch'),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    production_accepted: z.literal(false),
    policy: packagedUpdatePolicySchema,
    current: updateFeedSchema,
    offered: updateFeedSchema,
  })
  .refine((value) => {
    const parts = value.current.application_version.split('.');
    return (
      value.offered.application_version ===
      `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`
    );
  });
export const signedUpdateAcceptanceReceiptSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('signed_activation_acceptance'),
  pair: signedUpdateAcceptancePairSchema,
  verified_at: z.iso.datetime(),
  session_id: z.uuidv4(),
  storage_schema: z.number().int().min(1).max(65_535),
  delivery: z.literal('preseeded_cache'),
  production_accepted: z.literal(false),
});
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
export const stagedUpdateRuntimeSchema = z.strictObject({
  directory: localWindowsPath,
  executable: localWindowsPath,
  files: z.number().int().min(1).max(512),
  bytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 ** 2),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export const updateParentIdentitySchema = z.strictObject({
  pid: z
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1),
  creation_file_time: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/u)
    .refine((value) => value.length < 19 || value <= '9223372036854775807'),
});
export const heldUpdateRuntimeSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_runtime_held'),
  identity: updateParentIdentitySchema,
  runtime: stagedUpdateRuntimeSchema,
});
export const updateStartupAdmittedSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_startup_admitted'),
  identity: updateParentIdentitySchema,
});
export const updateStartupFailureSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_startup_failed'),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
export const updateCleanupReportSchema = z
  .strictObject({
    version: z.literal(1),
    event: z.literal('update_cleanup_report'),
    identity: updateParentIdentitySchema,
    status: z.enum(['complete', 'pending']),
    retired: z.number().int().min(0).max(4),
    removed: z.number().int().min(0).max(2),
    incomplete: z.number().int().min(0).max(128),
    rejected: z.number().int().min(0).max(128),
  })
  .refine((value) =>
    value.status === 'complete'
      ? value.incomplete === 0 && value.rejected === 0
      : value.incomplete > 0 || value.rejected > 0,
  );
export const updateCleanupFailureSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_cleanup_failed'),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
export const updateSessionInspectionSchema = z
  .strictObject({
    checked_at: z.iso.datetime(),
    status: z.enum(['complete', 'partial']),
    active: z.number().int().min(0).max(129),
    retired: z.number().int().min(0).max(129),
    unverifiable: z.number().int().min(0).max(256),
    limited: z.boolean(),
    omitted: z.number().int().min(0).max(258),
    sessions: z
      .array(
        z.strictObject({
          location: z.enum(['active', 'retired']),
          session_id: z.uuidv4().nullable(),
          status: z.enum([
            'healthy',
            'uncommitted',
            'recovery_required',
            'retired',
            'unverifiable',
          ]),
          current_version: updateVersionSchema.nullable(),
          offered_version: updateVersionSchema.nullable(),
          updated_at: z.iso.datetime().nullable(),
          code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
        }),
      )
      .max(32),
  })
  .refine(
    (value) =>
      value.sessions.length + value.omitted === value.active + value.retired &&
      value.sessions.length ===
        Math.min(
          32,
          value.active +
            value.retired -
            (value.active > 128 ? 1 : 0) -
            (value.retired > 128 ? 1 : 0),
        ) &&
      value.unverifiable <=
        value.active +
          value.retired -
          (value.active > 128 ? 1 : 0) -
          (value.retired > 128 ? 1 : 0) &&
      value.unverifiable >=
        value.sessions.filter((item) => item.status === 'unverifiable')
          .length &&
      value.status ===
        (value.limited || value.unverifiable > 0 ? 'partial' : 'complete') &&
      value.limited === (value.active > 128 || value.retired > 128) &&
      value.sessions.filter((item) => item.location === 'active').length <=
        value.active &&
      value.sessions.filter((item) => item.location === 'retired').length <=
        value.retired &&
      new Set(
        value.sessions
          .filter((item) => item.session_id !== null)
          .map((item) => `${item.location}:${item.session_id}`),
      ).size ===
        value.sessions.filter((item) => item.session_id !== null).length &&
      value.sessions.every((item) =>
        item.status === 'unverifiable'
          ? item.current_version === null &&
            item.offered_version === null &&
            item.updated_at === null
          : item.session_id !== null &&
            (item.location === 'retired'
              ? item.status === 'retired'
              : item.status !== 'retired') &&
            (item.current_version === null) ===
              (item.offered_version === null) &&
            (item.status !== 'healthy' ||
              (item.current_version !== null && item.updated_at !== null)),
      ),
  );
export const updateInspectionReportSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_inspection_report'),
  identity: updateParentIdentitySchema,
  report: updateSessionInspectionSchema,
});
export const updateInspectionFailureSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_inspection_failed'),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
export const updateRuntimeFailureSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_runtime_failed'),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
const handoffChallenge = z.string().regex(/^[0-9a-f]{64}$/u);
const restartIdentity = {
  version: z.literal(1),
  session_id: z.uuidv4(),
  challenge: handoffChallenge,
  identity: updateParentIdentitySchema,
  application_version: updateVersionSchema,
};
export const updateRestartChallengeSchema = z.strictObject({
  ...restartIdentity,
  event: z.literal('update_restart_challenge'),
});
export const updateRestartReadySchema = z.strictObject({
  ...restartIdentity,
  event: z.literal('update_restart_ready'),
  storage_schema: z.number().int().min(1).max(65_535),
});
export const updateRestartConfirmedSchema = z.strictObject({
  ...restartIdentity,
  event: z.literal('update_restart_confirmed'),
});
export const updateRestartAdmittedSchema = z.strictObject({
  ...restartIdentity,
  event: z.literal('update_restart_admitted'),
});
export const updateRestartFailureSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_restart_failed'),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
export const updateRestartProofSchema = z.strictObject({
  session_id: z.uuidv4(),
  identity: updateParentIdentitySchema,
  application_version: updateVersionSchema,
  storage_schema: z.number().int().min(1).max(65_535),
});
export const updateParentReadySchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_parent_ready'),
  challenge: handoffChallenge,
  parent: updateParentIdentitySchema,
});
export const updateHandoffDecisionSchema = z.strictObject({
  version: z.literal(1),
  operation: z.enum(['commit', 'cancel']),
  challenge: handoffChallenge,
});
export const updateParentCommittedSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_parent_committed'),
  parent: updateParentIdentitySchema,
});
export const updateWorkerRequestSchema = z.strictObject({
  parent_pid: updateParentIdentitySchema.shape.pid,
  application: localWindowsPath,
  current_version: updateVersionSchema,
  offered_version: updateVersionSchema,
  installer: localWindowsPath,
  bytes,
  sha512,
  runtime_sha256: handoffChallenge,
  user_data: localWindowsPath,
});
export const updateWorkerFailureSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal('update_worker_failed'),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
export const updateWorkerOutcomeSchema = z
  .strictObject({
    version: z.literal(1),
    session_id: z.uuidv4(),
    current_version: updateVersionSchema,
    offered_version: updateVersionSchema,
    phase: z.enum([
      'preparing',
      'prepared',
      'committed',
      'installing',
      'installed',
      'healthy',
      'failed',
    ]),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    installer_started: z.boolean(),
    installer_process: updateParentIdentitySchema.nullable(),
    installer_exit_code: z
      .number()
      .int()
      .min(-(2 ** 31))
      .max(2 ** 31 - 1)
      .nullable(),
    updated_at: z.iso.datetime(),
    restart: updateRestartProofSchema.nullable().optional(),
  })
  .refine((value) =>
    value.phase === 'installed' || value.phase === 'healthy'
      ? value.installer_started &&
        value.installer_exit_code === 0 &&
        value.installer_process !== null
      : ['preparing', 'prepared', 'committed'].includes(value.phase)
        ? !value.installer_started &&
          value.installer_exit_code === null &&
          value.installer_process === null
        : value.phase === 'installing'
          ? value.installer_exit_code === null &&
            (value.installer_started || value.installer_process === null)
          : value.installer_started ||
            (value.installer_exit_code === null &&
              value.installer_process === null),
  )
  .refine((value) =>
    value.phase === 'healthy'
      ? value.restart != null &&
        value.restart.session_id === value.session_id &&
        value.restart.application_version === value.offered_version
      : value.restart == null,
  );
export const cachedUpdateSchema = z.strictObject({
  version: z.literal(1),
  feed: updateFeedSchema,
  expected: updateExpectationSchema,
  verified_at: z.iso.datetime(),
});
export const desktopUpdateCommandSchema = z.strictObject({
  operation: z.enum(['getState', 'check', 'download', 'cancel', 'inspect']),
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
    'inspecting',
    'current',
    'available',
    'downloading',
    'ready',
    'preparing',
    'cancelling',
    'cancelled',
    'failed',
  ]),
  available_version: updateVersionSchema.nullable(),
  download_bytes: bytes.nullable(),
  can_check: z.boolean(),
  can_download: z.boolean(),
  can_cancel: z.boolean(),
  can_inspect: z.boolean(),
  inspection: updateSessionInspectionSchema.nullable(),
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
