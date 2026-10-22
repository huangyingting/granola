import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AudioHostClient } from '@windows-ai-notes/client/audio';
import { responseJson } from '@windows-ai-notes/client/http';
import {
  cachedUpdateSchema,
  compareUpdateVersions,
  packagedUpdatePolicySchema,
  updateFeedSchema,
  updateVersionSchema,
  type PackagedUpdatePolicy,
  type UpdateExpectation,
  type UpdateFeed,
} from '@windows-ai-notes/contracts/updates';
import { LocalError } from '@windows-ai-notes/local';
import { verifyInstallerUpdateArtifact } from './update-trust.js';

const maximumMetadataBytes = 16_384;
const maximumCacheEntries = 128;
const readyDirectory =
  /^ready-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const incomingDirectory = /^\.incoming-[A-Za-z0-9]{6}$/u;

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readMetadata(
  path: string,
  code: 'update_policy_invalid' | 'update_cache_invalid',
): Promise<unknown> {
  const information = await lstat(path);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > maximumMetadataBytes
  )
    throw new LocalError(
      code,
      'The update metadata must be a bounded regular file.',
    );
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== information.dev ||
      opened.ino !== information.ino
    )
      throw new LocalError(code, 'The update metadata changed while opening.');
    const buffer = Buffer.alloc(maximumMetadataBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumMetadataBytes || length !== information.size)
      throw new LocalError(
        code,
        'The update metadata changed or exceeded its size limit.',
      );
    try {
      return JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } catch {
      throw new LocalError(code, 'The update metadata is not valid JSON.');
    }
  } finally {
    await handle.close();
  }
}

export async function loadPackagedUpdatePolicy(
  resources: string,
  packaged: boolean,
  platform = process.platform,
): Promise<PackagedUpdatePolicy | null> {
  if (!packaged || platform !== 'win32') return null;
  const path = join(resources, 'update-policy.json');
  let value: unknown;
  try {
    value = await readMetadata(path, 'update_policy_invalid');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const parsed = packagedUpdatePolicySchema.safeParse(value);
  if (!parsed.success)
    throw new LocalError(
      'update_policy_invalid',
      'The packaged update policy is invalid. No update source was used.',
    );
  return parsed.data;
}

export async function ensureUpdateDownloadCapacity(
  helper: string,
  directory: string,
  bytes: number,
) {
  const client = new AudioHostClient(
    helper,
    ['--data-dir', directory],
    () => {},
  );
  try {
    const event = await client.request({
      command: 'check_storage',
      storage_quota_bytes: 5 * 1024 ** 3,
    });
    if (event.event_type !== 'storage.status')
      throw new LocalError(
        'update_capacity_invalid',
        'The helper did not report update storage capacity.',
      );
    assertUpdateDiskSpace(event.payload.free_bytes, bytes);
  } finally {
    await client.close();
  }
}

export function assertUpdateDiskSpace(available: number, bytes: number) {
  if (
    !Number.isSafeInteger(available) ||
    available < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > 2 * 1024 ** 3
  )
    throw new LocalError(
      'update_capacity_invalid',
      'The update storage capacity values are invalid.',
    );
  if (available < bytes * 2 + 512 * 1024 ** 2)
    throw new LocalError(
      'update_disk_space',
      'Free more disk space before downloading the update. Existing notes and recordings were preserved.',
    );
}

interface DownloadDependencies {
  fetch: typeof fetch;
  verify: typeof verifyInstallerUpdateArtifact;
  capacity: typeof ensureUpdateDownloadCapacity;
}
export interface ReadyUpdate {
  directory: string;
  installer: string;
  feed: UpdateFeed;
  expected: UpdateExpectation;
}
export interface RecoveredUpdates {
  ready: ReadyUpdate | null;
  removed: number;
  rejected: number;
  incomplete: number;
}

export class UpdateDownloads {
  private readonly policy: PackagedUpdatePolicy;
  private readonly currentVersion: string;
  private readonly dependencies: DownloadDependencies;
  private busy = false;

  constructor(
    private readonly directory: string,
    private readonly helper: string,
    policy: unknown,
    currentVersion: string,
    dependencies: Partial<DownloadDependencies> = {},
  ) {
    const parsed = packagedUpdatePolicySchema.safeParse(policy);
    if (
      !parsed.success ||
      !updateVersionSchema.safeParse(currentVersion).success ||
      !isAbsolute(directory)
    )
      throw new LocalError(
        'update_policy_invalid',
        'A valid packaged policy, installed version and absolute update cache are required.',
      );
    this.policy = parsed.data;
    this.currentVersion = currentVersion;
    this.dependencies = {
      fetch,
      verify: verifyInstallerUpdateArtifact,
      capacity: ensureUpdateDownloadCapacity,
      ...dependencies,
    };
  }

  async check(signal?: AbortSignal): Promise<UpdateFeed | null> {
    return this.exclusive(async () => {
      const bounded = AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(signal ? [signal] : []),
      ]);
      bounded.throwIfAborted();
      const response = await this.request(this.policy.feed_url, bounded, true);
      const feed = await responseJson(
        response,
        updateFeedSchema,
        maximumMetadataBytes,
      );
      bounded.throwIfAborted();
      return compareUpdateVersions(
        feed.application_version,
        this.currentVersion,
      ) > 0
        ? feed
        : null;
    }, signal);
  }

  async download(input: unknown, signal?: AbortSignal): Promise<ReadyUpdate> {
    return this.exclusive(async () => {
      const parsed = updateFeedSchema.safeParse(input);
      if (!parsed.success)
        throw new LocalError(
          'update_feed_invalid',
          'The update metadata is invalid.',
        );
      const feed = parsed.data;
      if (
        compareUpdateVersions(feed.application_version, this.currentVersion) <=
        0
      )
        throw new LocalError(
          'update_not_newer',
          'The update is not newer than the installed application.',
        );
      const bounded = AbortSignal.any([
        AbortSignal.timeout(300_000),
        ...(signal ? [signal] : []),
      ]);
      bounded.throwIfAborted();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await lstat(this.directory);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new LocalError(
          'update_cache_invalid',
          'The update cache must be a regular private directory.',
        );
      await this.dependencies.capacity(this.helper, this.directory, feed.bytes);
      bounded.throwIfAborted();
      let stage: string | null = await mkdtemp(
        join(this.directory, '.incoming-'),
      );
      try {
        const file = join(stage, feed.installer);
        const url = new URL(feed.installer, this.policy.feed_url).href;
        const handle = await open(file, 'wx', 0o600);
        let response: Response | undefined;
        try {
          response = await this.request(url, bounded, false, feed.bytes);
          await handle.writeFile(
            this.downloadBody(response, feed.bytes, bounded),
            { signal: bounded },
          );
          await handle.sync();
        } finally {
          try {
            await response?.body?.cancel();
          } finally {
            await handle.close();
          }
        }
        const expected = this.expectation(feed);
        await this.dependencies.verify(this.helper, file, expected, bounded);
        bounded.throwIfAborted();
        await writeFile(
          join(stage, 'verified-update.json'),
          `${JSON.stringify(
            {
              version: 1,
              feed,
              expected,
              verified_at: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          { flag: 'wx', mode: 0o600, flush: true },
        );
        const ready = join(
          this.directory,
          `ready-${feed.application_version}-${randomUUID()}`,
        );
        bounded.throwIfAborted();
        await rename(stage, ready);
        stage = ready;
        bounded.throwIfAborted();
        stage = null;
        return {
          directory: ready,
          installer: join(ready, feed.installer),
          feed,
          expected,
        };
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true });
      }
    }, signal);
  }

  async recover(signal?: AbortSignal): Promise<RecoveredUpdates> {
    return this.exclusive(async () => {
      const bounded = AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(signal ? [signal] : []),
      ]);
      bounded.throwIfAborted();
      const result: RecoveredUpdates = {
        ready: null,
        removed: 0,
        rejected: 0,
        incomplete: 0,
      };
      let root;
      try {
        root = await lstat(this.directory);
      } catch (error) {
        if (missing(error)) return result;
        throw error;
      }
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new LocalError(
          'update_cache_invalid',
          'The update cache must be a regular private directory.',
        );
      const entries: string[] = [];
      for await (const entry of await opendir(this.directory)) {
        bounded.throwIfAborted();
        if (entries.length === maximumCacheEntries)
          throw new LocalError(
            'update_cache_limit',
            'The update cache contains too many entries. No automatic cleanup was performed.',
          );
        entries.push(entry.name);
      }
      const candidates: ReadyUpdate[] = [];
      for (const name of entries) {
        bounded.throwIfAborted();
        const match = readyDirectory.exec(name);
        if (!match && !incomingDirectory.test(name)) continue;
        const directory = join(this.directory, name);
        try {
          const information = await lstat(directory);
          if (!information.isDirectory() || information.isSymbolicLink())
            throw new LocalError(
              'update_cache_invalid',
              'A cached update is not a regular directory.',
            );
          if (
            !match &&
            Date.now() - information.mtimeMs < 24 * 60 * 60 * 1000
          ) {
            result.incomplete++;
            continue;
          }
          await this.assertCacheContents(directory, bounded);
          if (!match) {
            await this.removeCacheDirectory(directory, bounded);
            result.removed++;
            continue;
          }
          const parsed = cachedUpdateSchema.safeParse(
            await readMetadata(
              join(directory, 'verified-update.json'),
              'update_cache_invalid',
            ),
          );
          if (
            !parsed.success ||
            parsed.data.feed.application_version !== match[1]
          )
            throw new LocalError(
              'update_cache_invalid',
              'The cached update receipt is invalid or names a different version.',
            );
          const feed = parsed.data.feed;
          const installer = join(directory, feed.installer);
          const artifact = await lstat(installer);
          if (artifact.size !== feed.bytes)
            throw new LocalError(
              'update_artifact_mismatch',
              'The cached installer size does not match its receipt.',
            );
          if (
            compareUpdateVersions(
              feed.application_version,
              this.currentVersion,
            ) <= 0
          ) {
            await this.removeCacheDirectory(directory, bounded);
            result.removed++;
          } else {
            candidates.push({
              directory,
              installer,
              feed,
              // Saved expectations and verification claims are untrusted.
              expected: this.expectation(feed),
            });
          }
        } catch (error) {
          bounded.throwIfAborted();
          if (!(error instanceof LocalError) && !missing(error)) throw error;
          result.rejected++;
          console.warn(
            JSON.stringify({
              code: 'update_cache_rejected',
              reason:
                error instanceof LocalError
                  ? error.code
                  : 'update_cache_incomplete',
            }),
          );
        }
      }
      candidates.sort(
        (a, b) =>
          compareUpdateVersions(
            b.feed.application_version,
            a.feed.application_version,
          ) || a.directory.localeCompare(b.directory),
      );
      for (const candidate of candidates) {
        bounded.throwIfAborted();
        if (result.ready) {
          await this.removeCacheDirectory(candidate.directory, bounded);
          result.removed++;
          continue;
        }
        try {
          await this.dependencies.verify(
            this.helper,
            candidate.installer,
            candidate.expected,
            bounded,
          );
          bounded.throwIfAborted();
          result.ready = candidate;
        } catch (error) {
          bounded.throwIfAborted();
          if (!(error instanceof LocalError)) throw error;
          result.rejected++;
          console.warn(
            JSON.stringify({
              code: 'update_cache_rejected',
              reason: error.code,
            }),
          );
        }
      }
      bounded.throwIfAborted();
      return result;
    }, signal);
  }

  private expectation(feed: UpdateFeed): UpdateExpectation {
    return {
      current_version: this.currentVersion,
      version: feed.application_version,
      certificate_sha256: this.policy.certificate_sha256,
      publisher: this.policy.publisher,
      product_name: this.policy.product_name,
      bytes: feed.bytes,
      sha512: feed.sha512,
    };
  }

  private async assertCacheContents(directory: string, signal: AbortSignal) {
    let installers = 0;
    let receipts = 0;
    const files: string[] = [];
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if (entry.name === 'verified-update.json') receipts++;
      else if (
        /^windows-ai-notes-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-x64-signed\.exe$/u.test(
          entry.name,
        )
      )
        installers++;
      else
        throw new LocalError(
          'update_cache_invalid',
          'Unknown files in a cached update were preserved.',
        );
      const information = await lstat(join(directory, entry.name));
      if (
        installers > 1 ||
        receipts > 1 ||
        !information.isFile() ||
        information.isSymbolicLink() ||
        information.nlink !== 1
      )
        throw new LocalError(
          'update_cache_invalid',
          'Unexpected files or links in a cached update were preserved.',
        );
      files.push(entry.name);
    }
    return files;
  }

  private async removeCacheDirectory(directory: string, signal: AbortSignal) {
    const files = await this.assertCacheContents(directory, signal);
    for (const file of files) {
      signal.throwIfAborted();
      await unlink(join(directory, file));
    }
    signal.throwIfAborted();
    await rmdir(directory);
  }

  private async request(
    url: string,
    signal: AbortSignal,
    metadata: boolean,
    expectedBytes?: number,
  ) {
    const response = await this.dependencies.fetch(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Accept: metadata ? 'application/json' : 'application/octet-stream',
        'Accept-Encoding': 'identity',
      },
      signal,
    });
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (
      response.status !== 200 ||
      response.redirected ||
      response.url !== url ||
      !response.body ||
      (length !== null &&
        (!/^(0|[1-9]\d*)$/u.test(length) ||
          (metadata
            ? Number(length) > maximumMetadataBytes
            : Number(length) !== expectedBytes))) ||
      (!metadata && encoding !== null && encoding.toLowerCase() !== 'identity')
    ) {
      await response.body?.cancel();
      throw new LocalError(
        'update_response_invalid',
        'The update source returned an unsupported, redirected or inconsistent response.',
      );
    }
    return response;
  }

  private async *downloadBody(
    response: Response,
    maximum: number,
    signal: AbortSignal,
  ) {
    if (!response.body)
      throw new LocalError(
        'update_response_invalid',
        'The update response is empty.',
      );
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.length;
        if (received > maximum)
          throw new LocalError(
            'update_size_mismatch',
            'The update download exceeded its declared size.',
          );
        yield chunk.value;
      }
      if (received !== maximum)
        throw new LocalError(
          'update_size_mismatch',
          'The update download ended before its declared size.',
        );
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  private async exclusive<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.busy)
      throw new LocalError(
        'update_busy',
        'An update check or download is already in progress.',
      );
    this.busy = true;
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted)
        throw new LocalError(
          'update_cancelled',
          'The update operation was cancelled. No installer was accepted.',
        );
      if (error instanceof LocalError) throw error;
      console.error(
        JSON.stringify({
          code: 'update_download_failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
      throw new LocalError(
        'update_download_failed',
        'The update operation failed. Existing notes, recordings and verified updates were preserved.',
      );
    } finally {
      this.busy = false;
    }
  }
}
