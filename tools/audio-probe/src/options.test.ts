import { describe, expect, it } from 'vitest';
import { parseOptions } from './options.js';

describe('audio probe options', () => {
  it('requires explicit opt-in to the experimental native packet clock without changing the default', () => {
    expect(parseOptions(['record'])).not.toHaveProperty(
      'captureClock',
      'wasapi_qpc_v1',
    );
    expect(
      parseOptions(['record', '--capture-clock', 'wasapi_qpc_v1']),
    ).toMatchObject({ captureClock: 'wasapi_qpc_v1' });
    for (const args of [
      ['devices', '--capture-clock', 'wasapi_qpc_v1'],
      [
        'inspect',
        '75048e79-2b45-440f-8609-b80a37635b4a',
        '--capture-clock',
        'wasapi_qpc_v1',
      ],
      ['record', '--capture-clock', 'callback_v1'],
      ['record', '--capture-clock', ''],
      ['record', '--capture-clock', 'unknown'],
    ])
      expect(() => parseOptions(args)).toThrow('capture-clock');
  });
  it('shows help without starting capture', () => {
    expect(parseOptions([])).toEqual({ help: true });
    expect(parseOptions(['--help'])).toEqual({ help: true });
  });

  it('requires an explicit command and bounded recording duration', () => {
    for (const args of [
      ['record', '--seconds', '0'],
      ['record', '--seconds', '3601'],
      ['record', '--seconds', 'NaN'],
      ['record', '--seconds', '1.5'],
      ['delete'],
      ['record', 'unexpected'],
      ['inspect', '../../outside'],
      ['record', '--pause-at', '59', '--pause-for', '5'],
    ])
      expect(() => parseOptions(args)).toThrow();
  });

  it('keeps default endpoint selection separate from capture scope', () => {
    expect(
      parseOptions(['record', '--seconds', '10', '--loopback', 'off']),
    ).toMatchObject({
      command: 'record',
      seconds: 10,
      microphone: 'default',
      loopback: 'off',
    });
  });
  it('requires explicit acceptance for recovery and rejects it on read-only commands', () => {
    const id = '75048e79-2b45-440f-8609-b80a37635b4a';
    expect(parseOptions(['recover', id, '--accept-incomplete'])).toMatchObject({
      command: 'recover',
      recordingId: id,
    });
    for (const args of [
      ['recover', id],
      ['recover', '../../outside', '--accept-incomplete'],
      ['recover', '--accept-incomplete'],
      ['inspect', id, '--accept-incomplete'],
      ['record', '--accept-incomplete'],
      ['devices', '--accept-incomplete'],
    ])
      expect(() => parseOptions(args)).toThrow();
  });
});
