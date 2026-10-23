import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  request: vi.fn().mockRejectedValue(new Error('Capture must not start.')),
  close: vi.fn().mockResolvedValue(undefined),
  measure: vi.fn(),
  callbacks: [] as ((event: unknown) => void)[],
}));

vi.mock('./client.js', () => ({
  AudioHostClient: class {
    request = probe.request;
    close = probe.close;
    failure = new Promise<never>(() => {});
    constructor(
      _executable: string,
      _args: string[],
      onEvent: (event: unknown) => void,
    ) {
      probe.callbacks.push(onEvent);
    }
  },
}));
vi.mock('./calibration.js', () => ({
  measureCalibration: probe.measure,
  writeCalibrationFixture: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true,
}));

const argv = process.argv;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const exitCode = process.exitCode;

beforeEach(() => {
  probe.request
    .mockReset()
    .mockRejectedValue(new Error('Capture must not start.'));
  probe.close.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.argv = argv;
  Object.defineProperty(process, 'platform', platform);
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  probe.request.mockClear();
  probe.close.mockClear();
  probe.measure.mockReset();
  probe.callbacks.length = 0;
});

it.each([true, false])(
  'dispatches calibration as read-only and keeps raw range events off stdout (sampled target %s)',
  async (withinTarget) => {
    const id = '75048e79-2b45-440f-8609-b80a37635b4a';
    process.argv = [process.execPath, 'probe', 'calibrate', id];
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = {
      sampled_landmarks_within_target: withinTarget,
      continuous_alignment_evaluated: false,
      production_accepted: false,
    };
    probe.measure.mockResolvedValue(report);
    await import('./index.js');
    await vi.waitFor(() => expect(probe.close).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(probe.measure).toHaveBeenCalledOnce();
    expect(probe.measure).toHaveBeenCalledWith(
      expect.any(Object),
      id,
      expect.any(AbortSignal),
    );
    expect(probe.request).not.toHaveBeenCalled();
    probe.callbacks[0]!({
      event_type: 'recording.chunk_range',
      payload: { data_base64: 'PRIVATE_PCM_SENTINEL' },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(report));
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'PRIVATE_PCM_SENTINEL',
    );
    if (withinTarget) expect(error).not.toHaveBeenCalled();
    else {
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('No physical gate was accepted'),
      );
    }
  },
);
