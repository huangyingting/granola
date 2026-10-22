import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalError } from '@windows-ai-notes/local';
import { updateExpectationSchema } from '@windows-ai-notes/contracts/updates';
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
  const verify = vi.fn(
    async (
      _helper: string,
      file: string,
      _expected: unknown,
      _signal?: AbortSignal,
    ) => {
      expect(await readFile(file)).toEqual(bytes);
      return {
        bytes: feed.bytes,
        sha512: feed.sha512,
        certificate_sha256: policy.certificate_sha256,
        publisher: policy.publisher,
        product_name: policy.product_name,
        product_version: feed.application_version,
      };
    },
  );
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
  const restart = (currentVersion = '0.1.0', packagedPolicy = policy) =>
    new UpdateDownloads(
      root,
      'C:\\Synthetic\\AudioHost.exe',
      packagedPolicy,
      currentVersion,
      { fetch: fetcher, capacity, verify },
    );
  return { root, capacity, verify, fetcher, downloads, restart };
}

async function cached(root: string, version = feed.application_version) {
  const metadata = {
    ...feed,
    application_version: version,
    installer: `windows-ai-notes-${version}-x64-signed.exe`,
  };
  const path = join(root, `ready-${version}-${randomUUID()}`);
  await mkdir(path);
  const expected = {
    current_version: '0.0.0',
    version,
    certificate_sha256: policy.certificate_sha256,
    publisher: policy.publisher,
    product_name: policy.product_name,
    bytes: metadata.bytes,
    sha512: metadata.sha512,
  };
  const receipt = {
    version: 1,
    feed: metadata,
    expected,
    verified_at: new Date().toISOString(),
  };
  const installer = join(path, metadata.installer);
  const receiptPath = join(path, 'verified-update.json');
  await writeFile(installer, bytes);
  await writeFile(receiptPath, JSON.stringify(receipt));
  return { path, installer, receiptPath, receipt, metadata };
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

describe('restart recovery of private update caches', () => {
  it('does not create an absent cache, request the network or launch a capacity probe', async () => {
    const { root, restart, verify, fetcher, capacity } = await fixture();
    await rm(root, { recursive: true });
    expect(await restart().recover()).toEqual({
      ready: null,
      removed: 0,
      rejected: 0,
      incomplete: 0,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an actual promoted download only after fresh native verification using the current packaged policy', async () => {
    const { downloads, restart, verify, fetcher, capacity } = await fixture();
    const original = await downloads.download(feed);
    const receiptPath = join(original.directory, 'verified-update.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.expected = {
      ...receipt.expected,
      certificate_sha256: 'ff'.repeat(32),
      publisher: 'Untrusted saved publisher',
      product_name: 'Untrusted saved product',
      version: '99.0.0',
      current_version: '0.0.0',
      sha512: Buffer.alloc(64).toString('base64'),
    };
    await writeFile(receiptPath, JSON.stringify(receipt));
    vi.clearAllMocks();
    const recovered = await restart('0.0.9').recover();
    expect(recovered).toMatchObject({
      ready: { directory: original.directory, installer: original.installer },
      removed: 0,
      rejected: 0,
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(
      'C:\\Synthetic\\AudioHost.exe',
      original.installer,
      { ...original.expected, current_version: '0.0.9' },
      expect.any(AbortSignal),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
  });

  it('removes already installed or older complete cache entries without touching notes, recordings or unknown directories', async () => {
    const { root, restart, verify } = await fixture();
    await cached(root, '0.1.0');
    await cached(root, '0.0.9');
    await writeFile(join(root, 'notes.sqlite'), 'Preserve synthetic notes.');
    await mkdir(join(root, 'recordings'));
    await mkdir(join(root, 'ready-not-owned'));
    const result = await restart().recover();
    expect(result).toEqual({
      ready: null,
      removed: 2,
      rejected: 0,
      incomplete: 0,
    });
    expect((await readdir(root)).sort()).toEqual([
      'notes.sqlite',
      'ready-not-owned',
      'recordings',
    ]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('keeps only the newest valid candidate after verification, not lexicographic version ordering', async () => {
    const { root, restart, verify } = await fixture();
    await cached(root, '0.9.99');
    const latest = await cached(root, '0.10.0');
    await cached(root, '0.2.0');
    expect(await restart().recover()).toMatchObject({
      ready: { installer: latest.installer },
      removed: 2,
      rejected: 0,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([latest.path.slice(root.length + 1)]);
  });

  it('preserves and reports rejected newer bytes and recovers an independently reverified older candidate', async () => {
    const { root, restart, verify } = await fixture();
    const rejected = await cached(root, '0.3.0');
    const accepted = await cached(root, '0.2.0');
    await cached(root, '0.1.1');
    verify.mockRejectedValueOnce(
      new LocalError('update_signature_invalid', 'Synthetic trust rejection.'),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await restart().recover()).toMatchObject({
      ready: { installer: accepted.installer },
      removed: 1,
      rejected: 1,
    });
    expect(verify.mock.calls.map((call) => call[1])).toEqual([
      rejected.installer,
      accepted.installer,
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        code: 'update_cache_rejected',
        reason: 'update_signature_invalid',
      }),
    );
    expect((await readdir(root)).sort()).toEqual(
      [rejected.path, accepted.path]
        .map((path) => path.slice(root.length + 1))
        .sort(),
    );
  });

  it('does not recover a cache under a different signer just because its receipt claims verification', async () => {
    const { root, restart, verify } = await fixture();
    const candidate = await cached(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    verify.mockImplementationOnce(async (_helper, _file, expected) => {
      expect(updateExpectationSchema.parse(expected).certificate_sha256).toBe(
        'cd'.repeat(32),
      );
      throw new LocalError(
        'update_identity_mismatch',
        'Synthetic pin rejection.',
      );
    });
    expect(
      await restart('0.1.0', {
        ...policy,
        certificate_sha256: 'cd'.repeat(32),
      }).recover(),
    ).toMatchObject({ ready: null, rejected: 1, removed: 0 });
    expect(await readFile(candidate.installer)).toEqual(bytes);
  });

  it.each([
    'malformed',
    'oversized',
    'extra verification claim',
    'directory version mismatch',
    'unsafe installer',
    'missing receipt',
    'missing installer',
    'changed size',
  ])(
    'reports an invalid cache without accepting or deleting its bytes: %s',
    async (change) => {
      const { root, restart, verify } = await fixture();
      const candidate = await cached(root);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (change === 'malformed')
        await writeFile(candidate.receiptPath, 'not JSON');
      else if (change === 'oversized')
        await writeFile(candidate.receiptPath, 'x'.repeat(16_385));
      else if (change === 'extra verification claim')
        await writeFile(
          candidate.receiptPath,
          JSON.stringify({ ...candidate.receipt, verified: true }),
        );
      else if (change === 'directory version mismatch')
        await writeFile(
          candidate.receiptPath,
          JSON.stringify({
            ...candidate.receipt,
            feed: {
              ...candidate.metadata,
              application_version: '0.2.0',
              installer: 'windows-ai-notes-0.2.0-x64-signed.exe',
            },
          }),
        );
      else if (change === 'unsafe installer')
        await writeFile(
          candidate.receiptPath,
          JSON.stringify({
            ...candidate.receipt,
            feed: { ...candidate.metadata, installer: '../outside.exe' },
          }),
        );
      else if (change === 'missing receipt') await rm(candidate.receiptPath);
      else if (change === 'missing installer') await rm(candidate.installer);
      else await writeFile(candidate.installer, 'truncated');
      expect(await restart().recover()).toMatchObject({
        ready: null,
        rejected: 1,
        removed: 0,
      });
      expect(verify).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([
        candidate.path.slice(root.length + 1),
      ]);
    },
  );

  it('cleans only expired known-layout incoming stages and never presents partial bytes as ready', async () => {
    const { root, restart, verify } = await fixture();
    const expired = join(root, '.incoming-old123');
    const recent = join(root, '.incoming-new123');
    const unknown = join(root, '.incoming-unk123');
    for (const path of [expired, recent, unknown]) await mkdir(path);
    await writeFile(join(expired, feed.installer), 'partial');
    await writeFile(join(recent, feed.installer), 'partial');
    await writeFile(join(unknown, 'notes.sqlite'), 'Preserve unknown content.');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(expired, old, old);
    await utimes(unknown, old, old);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await restart().recover()).toEqual({
      ready: null,
      removed: 1,
      rejected: 1,
      incomplete: 1,
    });
    expect(verify).not.toHaveBeenCalled();
    expect((await readdir(root)).sort()).toEqual([
      '.incoming-new123',
      '.incoming-unk123',
    ]);
    expect(await readFile(join(unknown, 'notes.sqlite'), 'utf8')).toBe(
      'Preserve unknown content.',
    );
  });

  it('preserves unexpected nested contents rather than recursively deleting an obsolete cache', async () => {
    const { root, restart } = await fixture();
    const candidate = await cached(root, '0.0.9');
    const nested = join(candidate.path, 'recordings');
    await mkdir(nested);
    await writeFile(
      join(nested, 'preserved.partial'),
      'Preserve nested bytes.',
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await restart().recover()).toMatchObject({
      ready: null,
      removed: 0,
      rejected: 1,
    });
    expect(await readFile(join(nested, 'preserved.partial'), 'utf8')).toBe(
      'Preserve nested bytes.',
    );
  });

  it('does not follow a linked cache directory or delete files outside the cache', async () => {
    const { root, restart, verify } = await fixture();
    const outside = await directory();
    await writeFile(join(outside, 'preserved'), 'Outside bytes.');
    const linked = join(root, `ready-0.1.1-${randomUUID()}`);
    await symlink(
      outside,
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await restart().recover()).toMatchObject({
      ready: null,
      removed: 0,
      rejected: 1,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(join(outside, 'preserved'), 'utf8')).toBe(
      'Outside bytes.',
    );
  });

  it('rejects hard-linked cached artifacts even for obsolete versions', async () => {
    const { root, restart, verify } = await fixture();
    const candidate = await cached(root, '0.0.9');
    const outside = join(await directory(), 'preserved.exe');
    await link(candidate.installer, outside);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await restart().recover()).toMatchObject({
      ready: null,
      removed: 0,
      rejected: 1,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(outside)).toEqual(bytes);
  });

  it('bounds directory enumeration before deleting or verifying anything', async () => {
    const { root, restart, verify } = await fixture();
    await cached(root, '0.0.9');
    for (let index = 0; index < 128; index++)
      await writeFile(join(root, `unknown-${index}`), '');
    await expect(restart().recover()).rejects.toMatchObject({
      code: 'update_cache_limit',
    });
    expect((await readdir(root)).length).toBe(129);
    expect(verify).not.toHaveBeenCalled();
  });

  it('shares the single-flight guard with downloads and propagates cancellation without accepting or pruning a candidate', async () => {
    const { root, restart, verify } = await fixture();
    const candidate = await cached(root);
    const cancellation = new AbortController();
    const recovered = restart();
    let started!: () => void;
    let release!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    verify.mockImplementationOnce(async () => {
      started();
      await gate;
      cancellation.abort();
      return {
        bytes: feed.bytes,
        sha512: feed.sha512,
        certificate_sha256: policy.certificate_sha256,
        publisher: policy.publisher,
        product_name: policy.product_name,
        product_version: feed.application_version,
      };
    });
    const pending = recovered.recover(cancellation.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'update_cancelled',
    });
    await start;
    await expect(recovered.download(feed)).rejects.toMatchObject({
      code: 'update_busy',
    });
    await expect(recovered.check()).rejects.toMatchObject({
      code: 'update_busy',
    });
    release();
    await rejected;
    expect(await readFile(candidate.installer)).toEqual(bytes);
    expect(await recovered.recover()).toMatchObject({
      ready: { installer: candidate.installer },
      removed: 0,
    });
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
