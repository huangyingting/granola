import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  packagedUpdatePolicySchema,
  signedUpdateAcceptancePairSchema,
  updateWorkerOutcomeSchema,
} from '@windows-ai-notes/contracts/updates';
import { z } from 'zod';

export type AcceptancePair = z.infer<typeof signedUpdateAcceptancePairSchema>;

export function acceptancePair(
  value: unknown,
  environment: NodeJS.ProcessEnv,
  productName: string,
  currentVersion: string,
): AcceptancePair {
  for (const key of [
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'WINDOWS_SIGNING_PFX_BASE64',
    'WINDOWS_SIGNING_PFX_PASSWORD',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
  ])
    if (environment[key] !== undefined)
      throw new Error(
        'Signing material must be removed before installed acceptance.',
      );
  const pair = signedUpdateAcceptancePairSchema.parse(value);
  const policy = packagedUpdatePolicySchema.parse({
    version: 1,
    feed_url: environment.WINDOWS_UPDATE_FEED_URL,
    certificate_sha256: environment.WINDOWS_SIGNING_CERT_SHA256?.toLowerCase(),
    publisher: environment.WINDOWS_PUBLISHER_NAME,
    product_name: productName,
  });
  if (
    pair.source_commit !== environment.GITHUB_SHA ||
    pair.current.application_version !== currentVersion ||
    JSON.stringify(pair.policy) !== JSON.stringify(policy)
  )
    throw new Error(
      'The signed pair must match this exact checkout and independently configured public identity.',
    );
  return pair;
}

export async function readAcceptanceMetadata(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Acceptance metadata must be a bounded regular file.');
  const handle = await open(file, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size === 0 || current.size > 16_384)
      throw new Error('Acceptance metadata must be a bounded regular file.');
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== current.size || bytesRead > 16_384)
      throw new Error('Acceptance metadata changed or exceeded its bound.');
    return JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown;
  } finally {
    await handle.close();
  }
}

export async function workerDirectories(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
  if (entries.length > 128)
    throw new Error('The acceptance worker root exceeds its inspection bound.');
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith('worker-') &&
        z.uuidv4().safeParse(entry.name.slice(7)).success,
    )
    .map((entry) => entry.name);
}

export async function newWorkerOutcome(
  root: string,
  previous: ReadonlySet<string>,
  pair: AcceptancePair,
) {
  const entries = (await workerDirectories(root)).filter(
    (name) => !previous.has(name),
  );
  if (entries.length > 1)
    throw new Error(
      'More than one new worker appeared during single activation.',
    );
  const name = entries[0];
  if (!name) return null;
  const file = join(root, name, 'update-outcome.json');
  let value;
  try {
    value = await readAcceptanceMetadata(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  const outcome = updateWorkerOutcomeSchema.parse(value);
  if (
    outcome.session_id !== name.slice(7) ||
    outcome.current_version !== pair.current.application_version ||
    outcome.offered_version !== pair.offered.application_version
  )
    throw new Error('The new worker outcome does not match the signed pair.');
  if (outcome.phase === 'failed')
    throw new Error(`Signed activation failed: ${outcome.code}.`);
  return outcome;
}
