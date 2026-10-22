import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  desktopUpdateStateSchema,
  type DesktopUpdateState,
  type UpdateFeed,
} from '@windows-ai-notes/contracts/updates';
import { LocalError } from '@windows-ai-notes/local';
import { DesktopUpdateController } from './update-controller.js';
import type {
  ReadyUpdate,
  RecoveredUpdates,
  UpdateDownloads,
} from './update-downloads.js';

function candidate(version = '0.1.1'): ReadyUpdate {
  const feed: UpdateFeed = {
    version: 1,
    kind: 'windows_update',
    application_version: version,
    architecture: 'x64',
    installer: `windows-ai-notes-${version}-x64-signed.exe`,
    bytes: 100,
    sha512: Buffer.alloc(64).toString('base64'),
  };
  return {
    directory: 'C:\\Synthetic\\private-update',
    installer: `C:\\Synthetic\\private-update\\${feed.installer}`,
    feed,
    expected: {
      current_version: '0.1.0',
      version,
      certificate_sha256: 'ab'.repeat(32),
      publisher: 'Synthetic publisher',
      product_name: 'Windows AI Notes',
      bytes: feed.bytes,
      sha512: feed.sha512,
    },
  };
}
const controllers: DesktopUpdateController[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(
    controllers.splice(0).map((controller) => controller.close()),
  );
  vi.restoreAllMocks();
});
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  releases.push(() => resolve(fallback));
  return { promise, resolve };
}
function fixture(recovered: Partial<RecoveredUpdates> = {}) {
  const ready = candidate();
  const downloads = {
    recover: vi.fn<UpdateDownloads['recover']>(async () => ({
      ready: null,
      removed: 0,
      rejected: 0,
      incomplete: 0,
      ...recovered,
    })),
    check: vi.fn<UpdateDownloads['check']>(async () => ready.feed),
    download: vi.fn<UpdateDownloads['download']>(async () => ready),
  };
  const load = vi.fn<
    () => Promise<Pick<
      UpdateDownloads,
      'check' | 'recover' | 'download'
    > | null>
  >(async () => downloads);
  const observe = vi.fn<(state: DesktopUpdateState) => void>();
  const controller = new DesktopUpdateController('0.1.0', load, observe);
  controllers.push(controller);
  return { controller, load, observe, downloads, ready };
}
async function phase(
  controller: DesktopUpdateController,
  expected: DesktopUpdateState['phase'],
) {
  await vi.waitFor(() => expect(controller.snapshot().phase).toBe(expected), {
    interval: 1,
  });
}
async function started(f: ReturnType<typeof fixture>) {
  f.controller.start();
  await phase(f.controller, 'idle');
}

describe('Main-owned desktop update operations', () => {
  it('loads once, recovers locally and never checks or downloads automatically', async () => {
    const f = fixture();
    f.controller.start();
    f.controller.start();
    await phase(f.controller, 'idle');
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.downloads.recover).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(f.downloads.check).not.toHaveBeenCalled();
    expect(f.downloads.download).not.toHaveBeenCalled();
    expect(f.controller.execute({ operation: 'getState' })).toMatchObject({
      installed_version: '0.1.0',
      installation_enabled: false,
      can_check: true,
      can_download: false,
      can_cancel: false,
      cache: { rejected: 0, removed: 0, incomplete: 0 },
    });
    const revisions = f.observe.mock.calls.map(([state]) => state.revision);
    expect(revisions).toEqual([...new Set(revisions)].sort((a, b) => a - b));
    for (const [state] of f.observe.mock.calls)
      expect(desktopUpdateStateSchema.safeParse(state).success).toBe(true);
  });
  it('disables actions when this package has no policy without creating a service', async () => {
    const f = fixture();
    f.load.mockResolvedValue(null);
    f.controller.start();
    await phase(f.controller, 'disabled');
    expect(f.downloads.recover).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({
      can_check: false,
      can_download: false,
      can_cancel: false,
      error: null,
    });
    expect(() => f.controller.execute({ operation: 'check' })).toThrow(
      'does not have an enabled update policy',
    );
    expect(() => f.controller.execute({ operation: 'download' })).toThrow();
    expect(() => f.controller.execute({ operation: 'cancel' })).toThrow();
  });
  it('recovers a verified candidate with explicit cache warnings but no paths or trust pins', async () => {
    const f = fixture({
      ready: candidate(),
      rejected: 2,
      incomplete: 1,
      removed: 3,
    });
    f.controller.start();
    await phase(f.controller, 'ready');
    expect(f.controller.snapshot()).toMatchObject({
      available_version: '0.1.1',
      can_download: false,
      installation_enabled: false,
      cache: { rejected: 2, incomplete: 1, removed: 3 },
    });
    const exposed = JSON.stringify(f.controller.snapshot());
    for (const text of [
      f.ready.directory,
      f.ready.installer,
      f.ready.expected.certificate_sha256,
      f.ready.feed.sha512,
      'https:',
      'expected',
    ])
      expect(exposed).not.toContain(text);
    expect(() => f.controller.execute({ operation: 'download' })).toThrow();
    f.controller.snapshot().cache!.rejected = 90;
    expect(f.controller.snapshot().cache?.rejected).toBe(2);
  });
  it('checks and downloads only the Main-selected feed, publishing completion asynchronously', async () => {
    const f = fixture();
    await started(f);
    expect(() => f.controller.execute({ operation: 'download' })).toThrow(
      'Check for an available update',
    );
    expect(f.controller.execute({ operation: 'check' })).toMatchObject({
      phase: 'checking',
      can_check: false,
      can_cancel: true,
    });
    expect(() => f.controller.execute({ operation: 'download' })).toThrow(
      'current update operation',
    );
    await phase(f.controller, 'available');
    expect(f.controller.snapshot().can_download).toBe(true);
    expect(f.controller.execute({ operation: 'download' }).phase).toBe(
      'downloading',
    );
    await phase(f.controller, 'ready');
    expect(f.downloads.download).toHaveBeenCalledWith(
      f.ready.feed,
      expect.any(AbortSignal),
    );
    expect(f.controller.snapshot()).toMatchObject({
      can_download: false,
      can_check: true,
      installation_enabled: false,
    });
  });
  it('reports a current version when the feed has no newer release', async () => {
    const f = fixture();
    f.downloads.check.mockResolvedValue(null);
    await started(f);
    f.controller.execute({ operation: 'check' });
    await phase(f.controller, 'current');
    expect(f.controller.snapshot()).toMatchObject({
      available_version: null,
      download_bytes: null,
      can_download: false,
    });
  });
  it.each(['absent', 'older', 'same'] as const)(
    'preserves a verified newer cached candidate after an %s feed result',
    async (result) => {
      const ready = candidate('0.2.0');
      const f = fixture({ ready });
      f.downloads.check.mockResolvedValue(
        result === 'absent'
          ? null
          : result === 'same'
            ? ready.feed
            : f.ready.feed,
      );
      f.controller.start();
      await phase(f.controller, 'ready');
      f.controller.execute({ operation: 'check' });
      await phase(f.controller, 'ready');
      expect(f.controller.snapshot()).toMatchObject({
        available_version: '0.2.0',
        can_download: false,
      });
    },
  );
  it('does not reuse a cached installer for changed size or digest metadata', async () => {
    const f = fixture({ ready: candidate() });
    f.downloads.check.mockResolvedValue({ ...f.ready.feed, bytes: 101 });
    f.controller.start();
    await phase(f.controller, 'ready');
    f.controller.execute({ operation: 'check' });
    await phase(f.controller, 'available');
    expect(f.controller.snapshot().can_download).toBe(true);
  });
  it('keeps cancellation single-flight until the backend has drained and ignores late results', async () => {
    const f = fixture({ ready: candidate() });
    const pending = deferred<UpdateFeed | null>(candidate('0.2.0').feed);
    f.downloads.check.mockReturnValue(pending.promise);
    f.controller.start();
    await phase(f.controller, 'ready');
    f.controller.execute({ operation: 'check' });
    await vi.waitFor(() => expect(f.downloads.check).toHaveBeenCalled(), {
      interval: 1,
    });
    expect(f.controller.execute({ operation: 'cancel' })).toMatchObject({
      phase: 'cancelling',
      can_cancel: false,
      can_check: false,
    });
    expect(() => f.controller.execute({ operation: 'check' })).toThrow();
    pending.resolve(candidate('0.2.0').feed);
    await phase(f.controller, 'cancelled');
    expect(f.controller.snapshot()).toMatchObject({
      available_version: '0.1.1',
      can_download: false,
      can_check: true,
      error: null,
    });
  });
  it('awaits download cleanup on close and sends no post-close notifications', async () => {
    const f = fixture();
    const cleanup = deferred<void>(undefined);
    f.downloads.download.mockImplementation(async (_feed, signal) => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      await cleanup.promise;
      throw new LocalError('update_cancelled', 'Cancelled.');
    });
    await started(f);
    f.controller.execute({ operation: 'check' });
    await phase(f.controller, 'available');
    f.controller.execute({ operation: 'download' });
    await vi.waitFor(() => expect(f.downloads.download).toHaveBeenCalled(), {
      interval: 1,
    });
    const sent = f.observe.mock.calls.length;
    let closed = false;
    const closing = f.controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => f.controller.execute({ operation: 'getState' })).toThrow(
      'closing',
    );
    cleanup.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(f.observe).toHaveBeenCalledTimes(sent);
  });
  it('cancels initialization without starting recovery or accepting a late factory result', async () => {
    const f = fixture();
    const pending = deferred(f.downloads);
    f.load.mockReturnValue(pending.promise);
    f.controller.start();
    await vi.waitFor(() => expect(f.load).toHaveBeenCalled(), { interval: 1 });
    f.controller.execute({ operation: 'cancel' });
    pending.resolve(f.downloads);
    await phase(f.controller, 'cancelled');
    expect(f.downloads.recover).not.toHaveBeenCalled();
    f.controller.execute({ operation: 'check' });
    await phase(f.controller, 'available');
    expect(f.downloads.recover).toHaveBeenCalledOnce();
  });
  it('surfaces invalid policy errors and permits an explicit initialization retry', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.load.mockRejectedValueOnce(
      new LocalError(
        'update_policy_invalid',
        'The packaged policy is invalid.',
      ),
    );
    f.controller.start();
    await phase(f.controller, 'failed');
    expect(f.controller.snapshot()).toMatchObject({
      can_check: true,
      error: {
        code: 'update_policy_invalid',
        message: 'The packaged policy is invalid.',
      },
    });
    expect(log).toHaveBeenCalled();
    f.controller.execute({ operation: 'check' });
    await phase(f.controller, 'available');
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().error).toBeNull();
  });
  it('reports unknown recovery errors without exposing paths or exception text', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.downloads.recover.mockRejectedValue(
      new Error('C:\\Synthetic\\private-path?credential=not-a-secret'),
    );
    f.controller.start();
    await phase(f.controller, 'failed');
    expect(f.controller.snapshot()).toMatchObject({
      cache: null,
      can_check: true,
      error: { code: 'update_operation_failed' },
    });
    expect(
      JSON.stringify([f.controller.snapshot(), log.mock.calls]),
    ).not.toContain('private-path');
  });
  it('surfaces verification failures without losing a checked download or claiming readiness', async () => {
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f.downloads.download.mockRejectedValue(
      new LocalError(
        'update_signature_invalid',
        'The installer is not trusted.',
      ),
    );
    await started(f);
    f.controller.execute({ operation: 'check' });
    await phase(f.controller, 'available');
    f.controller.execute({ operation: 'download' });
    await phase(f.controller, 'failed');
    expect(f.controller.snapshot()).toMatchObject({
      can_download: true,
      available_version: '0.1.1',
      installation_enabled: false,
      error: { code: 'update_signature_invalid' },
    });
  });
  it('logs observer failure while keeping an independently readable snapshot', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.observe.mockImplementation(() => {
      throw new Error('synthetic disconnected renderer');
    });
    await started(f);
    expect(f.controller.snapshot().can_check).toBe(true);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        code: 'update_notification_failed',
        kind: 'Error',
      }),
    );
  });
  it('does not initialize after being closed', async () => {
    const f = fixture();
    await f.controller.close();
    f.controller.start();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.controller.snapshot().can_check).toBe(false);
  });
});
