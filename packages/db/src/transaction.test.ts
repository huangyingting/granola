import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { Database } from './index.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const db = new Database('postgres://unused@127.0.0.1:1/unused');
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(db.pool, 'connect').mockImplementation(async () => client);
  vi.spyOn(db.deletions, 'beforeCommit').mockResolvedValue(undefined);
  const query = vi.spyOn(client, 'query').mockImplementation(async () => ({
    command: 'SELECT',
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  }));
  return { db, client, query };
}

it.each(['BEGIN', 'SELECT 1', 'COMMIT'])(
  'discards a connection after a read timeout during %s without rollback or retry',
  async (phase) => {
    const { db, client, query } = fixture();
    const failure = new Error('Query read timeout');
    query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.startsWith(phase)) throw failure;
      return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };
    });
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.query('SELECT 1');
          return 'unused';
        }),
      ).rejects.toBe(failure);
      expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
      expect(
        query.mock.calls.filter(
          ([sql]) => typeof sql === 'string' && sql.startsWith(phase),
        ),
      ).toHaveLength(1);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      await db.close();
    }
  },
);

const cancelled = new pg.DatabaseError('Query read timeout', 0, 'error');
cancelled.code = '57014';
it.each([
  cancelled,
  new Error('private-programming-error'),
  new ServiceError('domain_conflict', 'Explicit domain failure.', 409),
])(
  'rolls back a non-connection error and preserves its original identity: %s',
  async (failure) => {
    const { db, client, query } = fixture();
    try {
      await expect(
        db.transaction(async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await db.close();
    }
  },
);

it('discards a failed rollback without replacing the original operation error or logging its body', async () => {
  const { db, client, query } = fixture();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new Error('private-original-error');
  query.mockImplementation(async (sql) => {
    if (sql === 'ROLLBACK') throw new Error('private-rollback-error');
    return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };
  });
  try {
    await expect(
      db.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ code: 'database_transaction_rollback_failed' }),
    );
  } finally {
    await db.close();
  }
});
