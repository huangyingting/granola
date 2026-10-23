import { afterEach, expect, it, vi } from 'vitest';
import { retryDelay } from './retry.js';

afterEach(() => vi.restoreAllMocks());

it.each([1000, 2000, 30_000, 60_000])(
  'samples within the equal-jitter window for a %ims ceiling',
  (ceiling) => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(retryDelay(ceiling)).toBe(Math.ceil(ceiling / 2));
    random.mockReturnValue(1 - Number.EPSILON);
    expect(retryDelay(ceiling)).toBe(ceiling);
  },
);

it('adds spread above a server minimum instead of collapsing every client onto that deadline', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  expect(retryDelay(2000, 9000)).toBe(9500);
});

it('rounds a fractional server minimum up rather than retrying early or persisting a fractional deadline', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  expect(retryDelay(2000, 1000.1)).toBe(1001);
});

it('keeps the maximum supported server floor while bounding the additional spread', () => {
  vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
  expect(retryDelay(60_000, 300_000)).toBe(330_000);
});

it('spreads independent clients across the retry window', () => {
  const random = vi.spyOn(Math, 'random');
  const delays = [0, 0.25, 0.5, 0.75, 1 - Number.EPSILON].map((sample) => {
    random.mockReturnValue(sample);
    return retryDelay(2000);
  });
  expect(delays).toEqual([1000, 1250, 1500, 1750, 2000]);
});

it.each([
  [0, 0],
  [-1, 0],
  [1.5, 0],
  [60_001, 0],
  [NaN, 0],
  [Infinity, 0],
  [2000, -1],
  [2000, NaN],
  [2000, Infinity],
  [2000, 300_001],
])('rejects unsupported retry bounds %s / %s', (ceiling, minimum) => {
  expect(() => retryDelay(ceiling, minimum)).toThrow(RangeError);
});
