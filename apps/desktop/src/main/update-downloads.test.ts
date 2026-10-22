import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalError } from '@windows-ai-notes/local';
import {
  assertUpdateDiskSpace,
  loadPackagedUpdatePolicy,
  UpdateDownloads,
} from './update-downloads.js';

const bytes = Buffer.from(
  'Synthetic update bytes; verification is an injected boundary in portable tests.',
);
const policy = {
  version: 1,
  feed_url: 'https://updates.example/windows/stable.json',
  certificate_sha256: 'ab'.repeat(32),
  publisher: 'Synthetic publisher',
  product_name: 'Windows AI Notes Preview',
};
const feed = {
  version: 1,
  kind: 'windows_update',
  application_version: '0.1.1',
  architecture: 'x64',
  installer: 'windows-ai-notes-0.1.1-x64-signed.exe',
  bytes: bytes.length,
  sha512: createHash('sha512').update(bytes).digest('base64'),
};
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'notes-update-downloads-'));
  directories.push(path);
  return path;
}
function response(
  url: string,
  body: BodyInit | null,
  options: ResponseInit = {},
) {
  const result = new Response(body, options);
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
async function fixture() {
  const root = await directory();
  const capacity = vi.fn(async () => {});
  const verify = vi.fn(async (_helper: string, file: string) => {
    expect(await readFile(file)).toEqual(bytes);
    return {
      bytes: feed.bytes,
      sha512: feed.sha512,
      certificate_sha256: policy.certificate_sha256,
      publisher: policy.publisher,
      product_name: policy.product_name,
      product_version: feed.application_version,
    };
  });
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    return url === policy.feed_url
      ? response(url, JSON.stringify(feed))
      : response(url, new Uint8Array(bytes));
  });
  const downloads = new UpdateDownloads(
    root,
    'C:\\Synthetic\\AudioHost.exe',
    policy,
    '0.1.0',
    {
      fetch: fetcher,
      capacity,
      verify,
    },
  );
  return { root, capacity, verify, fetcher, downloads };
}

describe('private staged HTTPS update downloads', () => {
  it('requires space for two installer-sized allocations plus a fixed reserve without using the audio quota as disk space', () => {
    const required = bytes.length * 2 + 512 * 1024 ** 2;
    expect(() => assertUpdateDiskSpace(required, bytes.length)).not.toThrow();
    expect(() => assertUpdateDiskSpace(required - 1, bytes.length)).toThrow(
      'Free more disk space',
    );
    const invalid: [number, number][] = [
      [-1, bytes.length],
      [Infinity, bytes.length],
      [required, 0],
      [required, 2 * 1024 ** 3 + 1],
    ];
    for (const [available, size] of invalid)
      expect(() => assertUpdateDiskSpace(available, size)).toThrow(
        'values are invalid',
      );
  });
  it('checks a bounded direct feed and atomically promotes only native-verified bytes and metadata', async () => {
    const { root, downloads, fetcher, capacity, verify } = await fixture();
    await writeFile(join(root, 'preserved-existing-file'), 'preserve');
    expect(await downloads.check()).toEqual(feed);
    const ready = await downloads.download(feed);
    expect(await readFile(ready.installer)).toEqual(bytes);
    expect(
      JSON.parse(
        await readFile(join(ready.directory, 'verified-update.json'), 'utf8'),
      ),
    ).toMatchObject({
      version: 1,
      feed,
      expected: ready.expected,
    });
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        'preserved-existing-file',
        ready.directory.slice(root.length + 1),
      ]),
    );
    expect(
      (await readdir(root)).some((name) => name.startsWith('.incoming-')),
    ).toBe(false);
    expect(capacity).toHaveBeenCalledWith(
      'C:\\Synthetic\\AudioHost.exe',
      root,
      bytes.length,
    );
    expect(verify).toHaveBeenCalledExactlyOnceWith(
      'C:\\Synthetic\\AudioHost.exe',
      expect.stringContaining('.incoming-'),
      expect.objectContaining({
        certificate_sha256: policy.certificate_sha256,
        sha512: feed.sha512,
      }),
      expect.any(AbortSignal),
    );
    for (const call of fetcher.mock.calls)
      expect(call[1]).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Accept-Encoding': 'identity' },
      });
  });

  it.each(['0.1.0', '0.0.9'])(
    'does not offer or download a non-newer version: %s',
    async (version) => {
      const { downloads, fetcher, capacity } = await fixture();
      const older = {
        ...feed,
        application_version: version,
        installer: `windows-ai-notes-${version}-x64-signed.exe`,
      };
      fetcher.mockImplementation(async () =>
        response(policy.feed_url, JSON.stringify(older)),
      );
      expect(await downloads.check()).toBeNull();
      await expect(downloads.download(older)).rejects.toMatchObject({
        code: 'update_not_newer',
      });
      expect(capacity).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 206 },
    { status: 302 },
    { headers: { 'content-length': String(bytes.length + 1) } },
    { headers: { 'content-length': '1e2' } },
    { headers: { 'content-encoding': 'gzip' } },
  ])(
    'rejects an inconsistent installer response and removes only its owned stage: %j',
    async (options) => {
      const { root, downloads, fetcher, verify } = await fixture();
      await writeFile(join(root, 'preserved'), 'preserve');
      fetcher.mockImplementation(async (input) =>
        response(String(input), new Uint8Array(bytes), options),
      );
      await expect(downloads.download(feed)).rejects.toMatchObject({
        code: 'update_response_invalid',
      });
      expect(await readdir(root)).toEqual(['preserved']);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Buffer.from('extra')]),
  ])('rejects a truncated or oversized chunked download', async (body) => {
    const { root, downloads, fetcher, verify } = await fixture();
    fetcher.mockImplementation(async (input) =>
      response(
        String(input),
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(body.subarray(0, 5)));
            controller.enqueue(new Uint8Array(body.subarray(5)));
            controller.close();
          },
        }),
      ),
    );
    await expect(downloads.download(feed)).rejects.toMatchObject({
      code: 'update_size_mismatch',
    });
    expect(await readdir(root)).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not promote a signature rejection or overwrite previously preserved files', async () => {
    const { root, downloads, verify } = await fixture();
    await writeFile(join(root, 'existing-verified-update'), 'preserve');
    verify.mockRejectedValue(
      new LocalError(
        'update_signature_invalid',
        'Synthetic signature rejection.',
      ),
    );
    await expect(downloads.download(feed)).rejects.toMatchObject({
      code: 'update_signature_invalid',
    });
    expect(await readdir(root)).toEqual(['existing-verified-update']);
  });

  it('checks physical capacity before making a binary request', async () => {
    const { root, downloads, capacity, fetcher } = await fixture();
    capacity.mockRejectedValue(
      new LocalError('update_disk_space', 'Synthetic low-space result.'),
    );
    await expect(downloads.download(feed)).rejects.toMatchObject({
      code: 'update_disk_space',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('bounds metadata before any binary download or native invocation', async () => {
    const { downloads, fetcher, verify, capacity } = await fixture();
    fetcher.mockImplementation(async () =>
      response(policy.feed_url, ' '.repeat(16_385)),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(downloads.check()).rejects.toMatchObject({
      code: 'update_download_failed',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
  });

  it('cancels after native verification without publishing and releases the single-flight guard', async () => {
    const { root, downloads, verify } = await fixture();
    const controller = new AbortController();
    verify.mockImplementationOnce(async () => {
      controller.abort();
      return {
        bytes: feed.bytes,
        sha512: feed.sha512,
        certificate_sha256: policy.certificate_sha256,
        publisher: policy.publisher,
        product_name: policy.product_name,
        product_version: feed.application_version,
      };
    });
    await expect(
      downloads.download(feed, controller.signal),
    ).rejects.toMatchObject({ code: 'update_cancelled' });
    expect(await readdir(root)).toEqual([]);
    expect(await downloads.download(feed)).toMatchObject({ feed });
  });

  it('rejects concurrent operations instead of starting a second download', async () => {
    const { downloads, fetcher } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetcher.mockImplementationOnce(async () => {
      await gate;
      return response(policy.feed_url, JSON.stringify(feed));
    });
    const checking = downloads.check();
    await expect(downloads.download(feed)).rejects.toMatchObject({
      code: 'update_busy',
    });
    release();
    await expect(checking).resolves.toEqual(feed);
  });
});

describe('packaged-only update policy', () => {
  it('leaves absent policy and development/non-Windows builds disabled', async () => {
    const root = await directory();
    expect(await loadPackagedUpdatePolicy(root, true, 'win32')).toBeNull();
    await writeFile(join(root, 'update-policy.json'), JSON.stringify(policy));
    expect(await loadPackagedUpdatePolicy(root, false, 'win32')).toBeNull();
    expect(await loadPackagedUpdatePolicy(root, true, 'linux')).toBeNull();
    expect(await loadPackagedUpdatePolicy(root, true, 'win32')).toEqual(policy);
  });
  it.each([
    'not JSON',
    JSON.stringify({
      ...policy,
      feed_url: 'http://insecure.example/feed.json',
    }),
    'x'.repeat(16_385),
  ])(
    'fails closed rather than defaulting to an unconfigured or different update source',
    async (content) => {
      const root = await directory();
      await writeFile(join(root, 'update-policy.json'), content);
      await expect(
        loadPackagedUpdatePolicy(root, true, 'win32'),
      ).rejects.toMatchObject({ code: 'update_policy_invalid' });
    },
  );
  it.skipIf(process.platform === 'win32')(
    'does not follow a policy symlink',
    async () => {
      const root = await directory();
      const target = join(root, 'target.json');
      await writeFile(target, JSON.stringify(policy));
      await symlink(target, join(root, 'update-policy.json'));
      await expect(
        loadPackagedUpdatePolicy(root, true, 'win32'),
      ).rejects.toMatchObject({ code: 'update_policy_invalid' });
    },
  );
});
