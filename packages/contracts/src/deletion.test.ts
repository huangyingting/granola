import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  deletionIntentSchema,
  deletionOriginSchema,
  deletionBatchSchema,
  deletionArchiveHeadSchema,
  deletionArchiveLinkSchema,
} from './deletion.js';

const origin = {
  deployment_id: randomUUID(),
  initialized_at: new Date().toISOString(),
};
const base = () => ({
  id: randomUUID(),
  transaction_id: '18446744073709551615',
  recorded_at: new Date().toISOString(),
  resource_id: randomUUID(),
  workspace_id: null,
  expires_at: null,
  retention_days: null,
  processing_days: null,
  reason: null,
});
const events = [
  'document_erased',
  'recording_erased',
  'recording_expiry_bound',
  'chat_thread_erased',
  'chat_turn_erased',
  'account_revoked',
  'membership_revoked',
  'workspace_erased',
  'workspace_retention_bound',
  'job_erased',
  'job_audio_erased',
  'staging_object_erased',
  'verified_object_erased',
] as const;
it.each(events)('preserves exact, body-free %s journal metadata', (event) => {
  const value = {
    ...base(),
    event,
    ...(event === 'recording_erased' ? { reason: 'retention' } : {}),
    ...(event === 'recording_expiry_bound'
      ? { expires_at: new Date().toISOString() }
      : {}),
    ...(event === 'membership_revoked' ? { workspace_id: randomUUID() } : {}),
    ...(event === 'workspace_retention_bound'
      ? { retention_days: 0, processing_days: 1 }
      : {}),
  };
  expect(deletionIntentSchema.parse(value)).toEqual(value);
  expect(
    deletionIntentSchema.safeParse({ ...value, notes: 'private-body' }).success,
  ).toBe(false);
});
it('rejects ambiguous fields, absent restrictions and noncanonical provenance without throwing on malformed counters', () => {
  const valid = { ...base(), event: 'document_erased' };
  for (const value of [
    '0',
    '-1',
    '00',
    '1\n',
    '1\r',
    '1\u2028',
    '18446744073709551616',
    '999999999999999999999',
    'private-invalid',
  ]) {
    expect(
      deletionIntentSchema.safeParse({ ...valid, transaction_id: value })
        .success,
    ).toBe(false);
  }
  for (const extra of [
    { event: 'membership_revoked' },
    { event: 'recording_expiry_bound' },
    { event: 'workspace_retention_bound', retention_days: 0 },
    {
      event: 'workspace_retention_bound',
      retention_days: 8,
      processing_days: 1,
    },
    {
      event: 'workspace_retention_bound',
      retention_days: 0,
      processing_days: 31,
    },
    { workspace_id: randomUUID() },
    { expires_at: new Date().toISOString() },
    { reason: 'user' },
    { resource_id: `${valid.resource_id}\n` },
    { recorded_at: `${valid.recorded_at}\n` },
    { recorded_at: '2026-10-22T09:00:00+01:00' },
    { recorded_at: '2026-10-22T09:00:00.123456Z' },
  ])
    expect(deletionIntentSchema.safeParse({ ...valid, ...extra }).success).toBe(
      false,
    );
  expect(
    deletionOriginSchema.safeParse({
      ...origin,
      deployment_id: origin.deployment_id.toUpperCase(),
    }).success,
  ).toBe(false);
});
it('requires a nonempty bounded batch with unique IDs and exact lineage', () => {
  const entry = { ...base(), event: 'document_erased' };
  const batch = { version: 1, id: randomUUID(), origin, entries: [entry] };
  expect(deletionBatchSchema.parse(batch)).toEqual(batch);
  for (const entries of [
    [],
    [entry, entry],
    Array.from({ length: 101 }, () => ({ ...entry, id: randomUUID() })),
  ])
    expect(deletionBatchSchema.safeParse({ ...batch, entries }).success).toBe(
      false,
    );
  expect(
    deletionBatchSchema.safeParse({
      ...batch,
      origin: { ...origin, subject: 'private-identity' },
    }).success,
  ).toBe(false);
});
it('distinguishes verified genesis from absent history and rejects unsafe or ambiguous head/link counters', () => {
  const genesis = {
    version: 1,
    kind: 'genesis',
    origin,
    generation: '0',
    entry_references: '0',
    previous: null,
  };
  const head = {
    version: 1,
    origin,
    generation: '0',
    entry_references: '0',
    tip: 'a'.repeat(64),
  };
  expect(deletionArchiveLinkSchema.parse(genesis)).toEqual(genesis);
  expect(deletionArchiveHeadSchema.parse(head)).toEqual(head);
  expect(
    deletionArchiveLinkSchema.safeParse({ ...genesis, entry_references: '1' })
      .success,
  ).toBe(false);
  expect(
    deletionArchiveHeadSchema.safeParse({ ...head, tip: null }).success,
  ).toBe(false);
  expect(
    deletionArchiveHeadSchema.safeParse({ ...head, tip: `${head.tip}\n` })
      .success,
  ).toBe(false);
  expect(
    deletionArchiveHeadSchema.safeParse({
      ...head,
      generation: '9007199254740993',
    }).success,
  ).toBe(true);
  expect(
    deletionArchiveHeadSchema.safeParse({ ...head, generation: '1\n' }).success,
  ).toBe(false);
  expect(
    deletionArchiveLinkSchema.safeParse({
      version: 1,
      kind: 'batch',
      origin,
      generation: '0',
      entry_references: '1',
      previous: head.tip,
      batch_id: randomUUID(),
      batch_sha256: head.tip,
      batch_entries: 1,
    }).success,
  ).toBe(false);
});
