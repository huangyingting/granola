import { expect, it } from 'vitest';
import { JobHistoryReceipts } from './job-history.js';

it('keeps only immutable source and full-representation receipts', () => {
  const receipts = new JobHistoryReceipts();
  receipts.remember('actor:document:20:0', 'source', '"full-body-tag"');
  const receipt = receipts.get('actor:document:20:0');
  expect(receipt).toEqual({ source: 'source', etag: '"full-body-tag"' });
  expect(Object.isFrozen(receipt)).toBe(true);
});

it('does not mutate a captured receipt when another request replaces it', () => {
  const receipts = new JobHistoryReceipts();
  receipts.remember('page', 'old-source', '"old-tag"');
  const captured = receipts.get('page');
  receipts.remember('page', 'new-source', '"new-tag"');
  expect(captured).toEqual({ source: 'old-source', etag: '"old-tag"' });
  expect(receipts.get('page')).toEqual({
    source: 'new-source',
    etag: '"new-tag"',
  });
});

it('keeps actor, document and page keys separate', () => {
  const receipts = new JobHistoryReceipts();
  const keys = ['a:d:20:0', 'b:d:20:0', 'a:e:20:0', 'a:d:10:0', 'a:d:20:1'];
  for (const key of keys) receipts.remember(key, key, `"${key}"`);
  for (const key of keys)
    expect(receipts.get(key)).toEqual({ source: key, etag: `"${key}"` });
  expect(receipts.get('missing')).toBeUndefined();
});

it('evicts the least recently read receipt at its fixed 256-entry bound', () => {
  const receipts = new JobHistoryReceipts();
  for (let index = 0; index < 256; index++)
    receipts.remember(String(index), 'source', '"tag"');
  expect(receipts.get('0')).toBeDefined();
  receipts.remember('256', 'source', '"tag"');
  expect(receipts.get('0')).toBeDefined();
  expect(receipts.get('1')).toBeUndefined();
  expect(receipts.get('2')).toBeDefined();
  expect(receipts.get('256')).toBeDefined();
});

it('replaces a full-cache entry without evicting another key', () => {
  const receipts = new JobHistoryReceipts();
  for (let index = 0; index < 256; index++)
    receipts.remember(String(index), 'source', '"tag"');
  receipts.remember('0', 'replacement', '"new-tag"');
  for (let index = 1; index < 256; index++)
    expect(receipts.get(String(index))).toBeDefined();
  expect(receipts.get('0')).toEqual({
    source: 'replacement',
    etag: '"new-tag"',
  });
});

it('clears every receipt at server shutdown', () => {
  const receipts = new JobHistoryReceipts();
  receipts.remember('page', 'source', '"tag"');
  receipts.clear();
  expect(receipts.get('page')).toBeUndefined();
  receipts.remember('page', 'new-source', '"new-tag"');
  expect(receipts.get('page')?.source).toBe('new-source');
});
