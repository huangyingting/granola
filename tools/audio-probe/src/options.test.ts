import { describe, expect, it } from 'vitest';
import { parseOptions } from './options.js';

describe('audio probe options', () => {
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
});
