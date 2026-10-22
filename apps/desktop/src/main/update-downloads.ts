import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AudioHostClient } from '@windows-ai-notes/client/audio';
import { responseJson } from '@windows-ai-notes/client/http';
import {
  compareUpdateVersions,
  packagedUpdatePolicySchema,
  updateFeedSchema,
  updateVersionSchema,
  type PackagedUpdatePolicy,
  type UpdateExpectation,
  type UpdateFeed,
} from '@windows-ai-notes/contracts/updates';
import { LocalError } from '@windows-ai-notes/local';
import { verifyUpdateArtifact } from './update-trust.js';

const maximumMetadataBytes = 16_384;

export async function loadPackagedUpdatePolicy(
  resources: string,
  packaged: boolean,
  platform = process.platform,
): Promise<PackagedUpdatePolicy | null> {
  if (!packaged || platform !== 'win32') return null;
  const path = join(resources, 'update-policy.json');
  let information;
  try {
    information = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > maximumMetadataBytes
  )
    throw new LocalError(
      'update_policy_invalid',
      'The packaged update policy is not a supported regular file.',
    );
  const handle = await open(path, 'r');
  try {
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
        'update_policy_invalid',
        'The packaged update policy changed or exceeded its size limit.',
      );
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } catch {
      throw new LocalError(
        'update_policy_invalid',
        'The packaged update policy is not valid JSON.',
      );
    }
    const parsed = packagedUpdatePolicySchema.safeParse(value);
    if (!parsed.success)
      throw new LocalError(
        'update_policy_invalid',
        'The packaged update policy is invalid. No update source was used.',
      );
    return parsed.data;
  } finally {
    await handle.close();
  }
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
  verify: typeof verifyUpdateArtifact;
  capacity: typeof ensureUpdateDownloadCapacity;
}
export interface ReadyUpdate {
  directory: string;
  installer: string;
  feed: UpdateFeed;
  expected: UpdateExpectation;
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
      verify: verifyUpdateArtifact,
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
        const expected: UpdateExpectation = {
          current_version: this.currentVersion,
          version: feed.application_version,
          certificate_sha256: this.policy.certificate_sha256,
          publisher: this.policy.publisher,
          product_name: this.policy.product_name,
          bytes: feed.bytes,
          sha512: feed.sha512,
        };
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
