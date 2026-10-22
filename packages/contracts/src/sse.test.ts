import { describe, expect, it } from 'vitest';
import { SseDecoder } from './sse.js';

describe('bounded incremental event framing', () => {
  it('preserves split UTF-8, CRLF, comments and multiline data at every byte boundary', () => {
    const raw = new TextEncoder().encode(
      ': heartbeat\r\n\r\nid: 4\r\nevent: update\r\ndata: 中文 😀\r\ndata: second\r\n\r\n',
    );
    for (let split = 0; split <= raw.length; split++) {
      const decoder = new SseDecoder();
      expect([
        ...decoder.push(raw.slice(0, split)),
        ...decoder.push(raw.slice(split)),
        ...decoder.finish(),
      ]).toEqual([{ id: '4', event: 'update', data: '中文 😀\nsecond' }]);
    }
  });
  it('bounds complete and incomplete frames, including comments', () => {
    for (const value of [
      'data: ' + 'x'.repeat(30) + '\n\n',
      ':' + 'x'.repeat(30),
      'data: ' + 'x'.repeat(30),
    ]) {
      expect(() =>
        new SseDecoder(20).push(new TextEncoder().encode(value)),
      ).toThrow(/budget/u);
    }
  });
  it('rejects truncated data, invalid UTF-8 and invalid IDs without exposing the frame', () => {
    const decoder = new SseDecoder();
    decoder.push(new TextEncoder().encode('data: private incomplete data'));
    expect(() => decoder.finish()).toThrow(/incomplete/u);
    expect(() => new SseDecoder().push(new Uint8Array([255]))).toThrow();
    expect(() =>
      new SseDecoder().push(new TextEncoder().encode('id: a\0b\n\n')),
    ).toThrow(/identifier/u);
  });
});
