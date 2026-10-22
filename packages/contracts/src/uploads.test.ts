import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  audioRetentionPolicySchema,
  recordingRetentionSchema,
} from './uploads.js';

describe('bounded raw-audio retention contracts', () => {
  it.each([
    { retention_days: -1, processing_days: 30 },
    { retention_days: 8, processing_days: 30 },
    { retention_days: 1.5, processing_days: 30 },
    { retention_days: 7, processing_days: 0 },
    { retention_days: 7, processing_days: 31 },
    { retention_days: 7, processing_days: Infinity },
    { retention_days: 7, processing_days: 30, keep_forever: true },
  ])('rejects invalid or unbounded policy %j', (policy) => {
    expect(audioRetentionPolicySchema.safeParse(policy).success).toBe(false);
  });
  it('supports a stricter zero-day post-canonical policy without unbounded processing', () => {
    expect(
      audioRetentionPolicySchema.parse({
        retention_days: 0,
        processing_days: 1,
      }),
    ).toEqual({ retention_days: 0, processing_days: 1 });
  });
  it('keeps status body-free and requires observable cleanup for deleted input', () => {
    const value = {
      id: randomUUID(),
      document_id: randomUUID(),
      state: 'retained',
      canonical_at: null,
      expires_at: new Date().toISOString(),
      retention_days: 7,
      deletion: null,
    };
    expect(recordingRetentionSchema.parse(value)).toEqual(value);
    expect(
      recordingRetentionSchema.safeParse({ ...value, notes: 'private' })
        .success,
    ).toBe(false);
    expect(
      recordingRetentionSchema.safeParse({ ...value, state: 'deleted' })
        .success,
    ).toBe(false);
    const deletion = {
      state: 'cleanup_confirmed',
      pending_objects: 0,
      cleanup_errors: 0,
      repeated_cleanup: true,
    };
    expect(
      recordingRetentionSchema.safeParse({
        ...value,
        state: 'expired',
        deletion,
      }).success,
    ).toBe(true);
    expect(
      recordingRetentionSchema.safeParse({ ...value, deletion }).success,
    ).toBe(false);
    expect(
      recordingRetentionSchema.safeParse({
        ...value,
        state: 'expired',
        deletion: { ...deletion, pending_objects: 1 },
      }).success,
    ).toBe(false);
  });
});
