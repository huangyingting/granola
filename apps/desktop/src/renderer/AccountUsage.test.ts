import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountUsageSchema } from '@windows-ai-notes/contracts/server';
import { UsageCards } from './AccountUsage.js';

const usage = accountUsageSchema.parse({
  period_start: '2026-10-01',
  period_end: '2026-11-01',
  limits: {
    input_tokens: '2000000',
    output_tokens: '500000',
    audio_ms: '28800000',
  },
  settled: { input_tokens: '12', output_tokens: '8', audio_ms: '90000' },
  uncertain: { input_tokens: '64000', output_tokens: '4096', audio_ms: '1' },
  settled_requests: '1',
  uncertain_requests: '2',
  over_limit: false,
});
describe('account AI allowance cards', () => {
  it('distinguishes known usage, uncertain holds, UTC scope and invoice limitations', () => {
    const html = renderToStaticMarkup(createElement(UsageCards, { usage }));
    expect(html).toContain('2026-10-01');
    expect(html).toContain('across all workspaces');
    expect(html).toContain('1.5 min');
    expect(html).toContain('&lt;0.1 min held');
    expect(html).toContain('64,000 held');
    expect(html).toContain('not an Azure invoice');
    expect(html).not.toContain('role="alert"');
  });
  it('preserves large decimal totals without floating conversion and reports over-limit states', () => {
    const html = renderToStaticMarkup(
      createElement(UsageCards, {
        usage: {
          ...usage,
          settled: { ...usage.settled, input_tokens: '18014398509481982' },
          over_limit: true,
        },
      }),
    );
    expect(html).toContain('18,014,398,509,481,982');
    expect(html).toContain('Additional AI requests');
    expect(html).toContain('role="alert"');
    expect(
      accountUsageSchema.safeParse({
        ...usage,
        settled: { ...usage.settled, input_tokens: 12 },
      }).success,
    ).toBe(false);
  });
});
