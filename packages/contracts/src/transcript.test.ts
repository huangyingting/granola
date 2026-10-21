import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  makeTranscriptPage,
  segmentsSchema,
  storedSegmentsSchema,
  transcriptPageSchema,
  TRANSCRIPT_PAGE_TEXT_BYTES,
} from './server.js';

describe('bounded immutable transcript pages', () => {
  const segment = (text = 'Synthetic speech.') => ({
    id: randomUUID(),
    start_ms: 0,
    end_ms: 1000,
    text,
  });
  const header = (total_segments: number) => ({
    document_id: randomUUID(),
    revision: 1,
    source: 'manual' as const,
    total_segments,
  });
  it('supports stored meeting transcripts without expanding legacy short-context limits', () => {
    const segments = Array.from({ length: 1200 }, () => segment());
    expect(storedSegmentsSchema.parse(segments)).toHaveLength(1200);
    expect(segmentsSchema.safeParse(segments).success).toBe(false);
    expect(
      storedSegmentsSchema.safeParse([segments[0]!, segments[0]!]).success,
    ).toBe(false);
    expect(storedSegmentsSchema.safeParse([segment('NUL\0text')]).success).toBe(
      false,
    );
  });
  it('limits pages by both segment count and actual UTF-8 text bytes', () => {
    const entries = Array.from({ length: 100 }, () => segment());
    expect(makeTranscriptPage(header(100), 0, entries)).toMatchObject({
      offset: 0,
      has_more: true,
      segments: entries.slice(0, 50),
    });
    const unicode = Array.from({ length: 13 }, () =>
      segment('中'.repeat(9990)),
    );
    const page = makeTranscriptPage(header(13), 0, unicode);
    expect(page.segments).toHaveLength(4);
    expect(
      page.segments.reduce(
        (sum, entry) => sum + Buffer.byteLength(entry.text),
        0,
      ),
    ).toBeLessThanOrEqual(TRANSCRIPT_PAGE_TEXT_BYTES);
    expect(page.has_more).toBe(true);
  });
  it('rejects contradictory continuation, missing data, duplicate IDs and excess text', () => {
    const page = makeTranscriptPage(header(1), 0, [segment()]);
    for (const change of [
      { offset: 2 },
      { has_more: true },
      { total_segments: 2 },
      { segments: [], has_more: true },
      { source: 'none' },
      { revision: 0 },
      { total_segments: 2, segments: [page.segments[0], page.segments[0]] },
      {
        total_segments: 5,
        segments: Array.from({ length: 5 }, () => segment('中'.repeat(9990))),
      },
    ])
      expect(
        transcriptPageSchema.safeParse({ ...page, ...change }).success,
      ).toBe(false);
    expect(
      makeTranscriptPage({ ...header(0), revision: 0, source: 'none' }, 0, []),
    ).toMatchObject({ total_segments: 0, has_more: false });
  });
  it('rejects oversized stored text instead of truncating it', () => {
    expect(
      storedSegmentsSchema.safeParse(
        Array.from({ length: 801 }, () => segment('x'.repeat(10_000))),
      ).success,
    ).toBe(false);
  });
});
