import { describe, expect, it } from 'vitest';
import { summaryRequestSchema, summarySnapshotSchema } from './server.js';
import {
  DEFAULT_SUMMARY_TEMPLATE,
  SUMMARY_TEMPLATES,
  summaryTemplateCatalogSchema,
  summaryTemplateIdSchema,
} from './templates.js';

describe('immutable server-owned summary template versions', () => {
  it('advertises bounded unique versioned metadata without accepting arbitrary prompt or provider configuration', () => {
    expect(
      summaryTemplateCatalogSchema.parse({ templates: SUMMARY_TEMPLATES })
        .templates,
    ).toHaveLength(2);
    expect(
      summaryTemplateCatalogSchema.safeParse({
        templates: [SUMMARY_TEMPLATES[0], SUMMARY_TEMPLATES[0]],
      }).success,
    ).toBe(false);
    expect(
      summaryTemplateIdSchema.safeParse('custom-client-prompt').success,
    ).toBe(false);
    expect(
      summaryTemplateIdSchema.safeParse('https://example.invalid/provider')
        .success,
    ).toBe(false);
    expect(summaryTemplateIdSchema.parse(DEFAULT_SUMMARY_TEMPLATE)).toBe(
      'meeting-summary-v1',
    );
  });
  it('preserves legacy request serialization for durable idempotency hashes', () => {
    const legacy = { note_revision: 1, transcript_revision: 0, language: 'en' };
    expect(summaryRequestSchema.parse(legacy)).toEqual(legacy);
    expect(JSON.stringify(summaryRequestSchema.parse(legacy))).toBe(
      JSON.stringify(legacy),
    );
    expect(
      summaryRequestSchema.parse({
        ...legacy,
        template_id: 'decisions-actions-v1',
      }),
    ).toMatchObject({ template_id: 'decisions-actions-v1' });
    expect(
      summaryRequestSchema.safeParse({
        ...legacy,
        template_id: 'arbitrary-prompt',
      }).success,
    ).toBe(false);
    expect(
      summarySnapshotSchema.shape.template_id.safeParse(undefined).data,
    ).toBeUndefined();
  });
  it('can read a newer catalog without treating unknown versions as usable templates', () => {
    const future = { id: 'future-summary-v2', name: 'Newer server capability' };
    expect(
      summaryTemplateCatalogSchema.parse({ templates: [future] }).templates,
    ).toEqual([future]);
    expect(summaryTemplateIdSchema.safeParse(future.id).success).toBe(false);
  });
});
