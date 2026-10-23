import pg from 'pg';
import { expect, it } from 'vitest';
import { isDatabaseUnavailable } from './connection-errors.js';

function databaseError(code: string, message = 'private-database-message') {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = code;
  return error;
}

it.each([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
])('recognizes PostgreSQL connection/shutdown/capacity SQLSTATE %s', (code) => {
  expect(isDatabaseUnavailable(databaseError(code))).toBe(true);
});

it.each([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
])('recognizes a transient transport failure %s', (code) => {
  expect(
    isDatabaseUnavailable(
      Object.assign(new Error('private-network-message'), { code }),
    ),
  ).toBe(true);
});

it.each([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
])('recognizes the pinned pg/pg-pool connection failure: %s', (message) => {
  expect(isDatabaseUnavailable(new Error(message))).toBe(true);
});

it.each(['08P01', '23505', '28P01', '42P01', '57014', 'P0001'])(
  'does not reclassify permanent/protocol/query failures %s by their message',
  (code) => {
    expect(
      isDatabaseUnavailable(
        databaseError(code, 'Connection terminated unexpectedly'),
      ),
    ).toBe(false);
  },
);
it.each([
  null,
  undefined,
  'Connection terminated unexpectedly',
  { code: 'ECONNREFUSED' },
  { message: 'Connection terminated unexpectedly' },
  new Error('private-programming-error'),
  Object.assign(new Error('Connection terminated unexpectedly'), {
    code: 'P0001',
  }),
  Object.assign(new Error('private-programming-error'), { code: '08006' }),
  Object.assign(new Error('private-configuration-error'), {
    code: 'ENOTFOUND',
  }),
])(
  'leaves unknown and non-Error values outside the availability classifier: %s',
  (error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  },
);
