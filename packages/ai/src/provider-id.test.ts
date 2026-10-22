import { expect, it } from 'vitest';
import { normalizeProviderId } from './provider-id.js';
import {
  speechSessionIdentity,
  speechWorkerEventSchema,
} from './realtime-protocol.js';

it('admits only bounded opaque GUID formats and normalizes them identically for HTTP and SDK identities', () => {
  const id = 'ABCDEF12-1234-5678-ABCD-123456789ABC';
  expect(normalizeProviderId(id)).toBe('abcdef1212345678abcd123456789abc');
  expect(normalizeProviderId(id.replaceAll('-', ''))).toBe(
    normalizeProviderId(id),
  );
  expect(speechSessionIdentity(id)).toEqual({
    kind: 'session',
    status: 'accepted',
    session_id: normalizeProviderId(id),
  });
});
it.each([
  undefined,
  null,
  3,
  {},
  'private-sdk-payload',
  'a'.repeat(1000),
  'a'.repeat(32) + '\n',
  'ABCDEF12-1234-5678-ABCD-123456789ABC\n',
])(
  'reports a rejected unsupported SDK identifier without copying its value: %j',
  (value) => {
    const result = speechSessionIdentity(value);
    expect(result).toEqual({
      kind: 'session',
      status: 'rejected',
      session_id: null,
    });
    expect(speechWorkerEventSchema.safeParse(result).success).toBe(true);
  },
);
