import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  makeTranscriptPage,
  segmentSchema,
  ServiceError,
  type Segment,
  type TranscriptPage,
} from '@windows-ai-notes/contracts/server';
import {
  SUMMARY_CHUNK_BYTES,
  summaryEvidenceChunkSchema,
  type FrozenMeeting,
  type SummaryEvidenceChunk,
} from '@windows-ai-notes/contracts/evidence';
import { chunkFrozenMeeting } from './chunks.js';

const meeting = (notes = 'Original frozen human notes.'): FrozenMeeting => ({
  document_id: randomUUID(),
  note_revision: 7,
  transcript_revision: 3,
  notes,
  language: 'zh',
  template_id: 'decisions-actions-v1',
});
const segment = (text: string, start = 100): Segment =>
  segmentSchema.parse({
    id: randomUUID(),
    start_ms: start,
    end_ms: start + 500,
    text,
  });
function header(snapshot: FrozenMeeting, total_segments: number) {
  return {
    document_id: snapshot.document_id,
    revision: snapshot.transcript_revision,
    source:
      snapshot.transcript_revision === 0
        ? ('none' as const)
        : ('manual' as const),
    total_segments,
  };
}
async function* pages(snapshot: FrozenMeeting, segments: Segment[]) {
  const metadata = header(snapshot, segments.length);
  let offset = 0;
  while (offset < segments.length) {
    const page = makeTranscriptPage(metadata, offset, segments.slice(offset));
    yield page;
    offset += page.segments.length;
  }
}
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
async function* supplied(values: TranscriptPage[]) {
  yield* values;
}
function assertCoverage(
  chunks: SummaryEvidenceChunk[],
  snapshot: FrozenMeeting,
  segments: Segment[],
) {
  const originals = new Map<string, string>();
  if (snapshot.notes.trim())
    originals.set(snapshot.document_id, snapshot.notes);
  for (const source of segments) originals.set(source.id, source.text);
  const recovered = new Map<string, string>();
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.index).toBe(index);
    expect(chunk.document_id).toBe(snapshot.document_id);
    expect(chunk.template_id).toBe(snapshot.template_id);
    expect(chunk.language).toBe(snapshot.language);
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(
      SUMMARY_CHUNK_BYTES,
    );
    expect(summaryEvidenceChunkSchema.safeParse(chunk).success).toBe(true);
    expect(chunk).not.toHaveProperty('notes');
    if (index > 0) {
      const overlap = chunk.units[0]!;
      const previous = chunks[index - 1]!.units.at(-1)!;
      expect(overlap.overlap).toBe(true);
      expect(overlap.citation).toEqual(previous.citation);
      expect(previous.text.endsWith(overlap.text)).toBe(true);
      expect(overlap.text_end).toBe(previous.text_end);
    }
    for (const unit of chunk.units) {
      const original = originals.get(unit.citation.id)!;
      expect(unit.text).toBe(original.slice(unit.text_start, unit.text_end));
      if (unit.citation.source === 'note') {
        expect(unit.citation.revision).toBe(snapshot.note_revision);
        expect([unit.start_ms, unit.end_ms]).toEqual([null, null]);
      } else {
        const source = segments.find((item) => item.id === unit.citation.id)!;
        expect(unit.citation.revision).toBe(snapshot.transcript_revision);
        expect([unit.start_ms, unit.end_ms]).toEqual([
          source.start_ms,
          source.end_ms,
        ]);
      }
      if (unit.overlap) continue;
      const before = recovered.get(unit.citation.id) ?? '';
      expect(unit.text_start).toBe(before.length);
      recovered.set(unit.citation.id, before + unit.text);
    }
  }
  expect(recovered).toEqual(originals);
}

describe('bounded immutable meeting evidence chunks', () => {
  it.each([
    'x'.repeat(40_000),
    '\u0001'.repeat(40_000),
    '🙂'.repeat(20_000),
    '\\"'.repeat(20_000),
  ])(
    'has deterministic bounded coverage for a maximum-length frozen note %#',
    async (notes) => {
      const snapshot = { ...meeting(notes), transcript_revision: 0 };
      const first = await collect(
        chunkFrozenMeeting(snapshot, header(snapshot, 0), supplied([])),
      );
      const second = await collect(
        chunkFrozenMeeting(snapshot, header(snapshot, 0), supplied([])),
      );
      expect(first).toEqual(second);
      assertCoverage(first, snapshot, []);
    },
  );
  it('preserves exact multilingual notes and transcript ranges, escapes and original segment times with small explicit overlaps', async () => {
    const snapshot = meeting('Frozen notes:\n' + '中🙂"\\\n'.repeat(1800));
    const segments = [
      segment('Cited transcript:\n' + '引文🙂"\\\t'.repeat(1000), 900),
      segment('A separate overlapping track.', 100),
    ];
    const chunks = await collect(
      chunkFrozenMeeting(
        snapshot,
        header(snapshot, segments.length),
        pages(snapshot, segments),
      ),
    );
    expect(chunks.length).toBeGreaterThan(5);
    assertCoverage(chunks, snapshot, segments);
  });
  it('reads every segment beyond the legacy 1,000-segment snapshot without materializing all transcript text', async () => {
    const snapshot = meeting('');
    const segments = Array.from({ length: 1051 }, (_, index) =>
      segment(`Canonical source ${index}.`),
    );
    const chunks = await collect(
      chunkFrozenMeeting(
        snapshot,
        header(snapshot, segments.length),
        pages(snapshot, segments),
      ),
    );
    assertCoverage(chunks, snapshot, segments);
    expect(chunks.at(-1)!.units.at(-1)!.citation.id).toBe(segments.at(-1)!.id);
  });
  it('advances by the returned page length when the UTF-8 page limit is reached before fifty segments', async () => {
    const snapshot = meeting('');
    const segments = Array.from({ length: 10 }, () =>
      segment('中'.repeat(10_000)),
    );
    const streamed = await collect(pages(snapshot, segments));
    expect(streamed).toHaveLength(3);
    expect(streamed[0]!.segments).toHaveLength(4);
    const chunks = await collect(
      chunkFrozenMeeting(
        snapshot,
        header(snapshot, segments.length),
        supplied(streamed),
      ),
    );
    assertCoverage(chunks, snapshot, segments);
  });
  it('is lazy, and aborts between chunks without reading another source page', async () => {
    const snapshot = meeting('x'.repeat(20_000));
    const controller = new AbortController();
    let reads = 0;
    async function* source() {
      reads++;
      yield makeTranscriptPage(header(snapshot, 1), 0, [
        segment('Unread transcript.'),
      ]);
    }
    const iterator = chunkFrozenMeeting(
      snapshot,
      header(snapshot, 1),
      source(),
      controller.signal,
    );
    expect((await iterator.next()).done).toBe(false);
    expect(reads).toBe(0);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(0);
  });
  it.each([
    'document',
    'revision',
    'source',
    'offset',
    'total',
    'normalized-text',
    'time-range',
    'missing-page',
    'extra-page',
    'duplicate-id',
  ] as const)(
    'fails explicitly on %s evidence instead of silently skipping or rewriting it',
    async (change) => {
      const snapshot = meeting('');
      const first = segment('Frozen source one.'),
        second = segment('Frozen source two.');
      const metadata = header(snapshot, 2);
      const valid = makeTranscriptPage(metadata, 0, [first, second]);
      let values: TranscriptPage[] = [valid];
      switch (change) {
        case 'document':
          values = [{ ...valid, document_id: randomUUID() }];
          break;
        case 'revision':
          values = [{ ...valid, revision: valid.revision + 1 }];
          break;
        case 'source':
          values = [{ ...valid, source: 'azure_speech_fast' }];
          break;
        case 'offset':
          values = [{ ...valid, offset: 1 }];
          break;
        case 'total':
          values = [{ ...valid, total_segments: 3 }];
          break;
        case 'normalized-text':
          values = [
            {
              ...valid,
              segments: [{ ...first, text: ` ${first.text} ` }, second],
            },
          ];
          break;
        case 'time-range':
          values = [{ ...valid, segments: [{ ...first, end_ms: 0 }, second] }];
          break;
        case 'missing-page':
          values = [];
          break;
        case 'extra-page':
          values = [valid, makeTranscriptPage(metadata, 2, [])];
          break;
        case 'duplicate-id':
          values = [
            makeTranscriptPage(metadata, 0, [first]),
            makeTranscriptPage(metadata, 1, [first]),
          ];
          break;
      }
      await expect(
        collect(chunkFrozenMeeting(snapshot, metadata, supplied(values))),
      ).rejects.toMatchObject({ code: 'transcript_integrity_error' });
    },
  );
  it('refuses candidate or mismatched frozen headers before pulling any source', async () => {
    const snapshot = meeting();
    let reads = 0;
    async function* source() {
      reads++;
      yield makeTranscriptPage(header(snapshot, 0), 0, []);
    }
    for (const metadata of [
      { ...header(snapshot, 0), document_id: randomUUID() },
      { ...header(snapshot, 0), revision: 4 },
      { ...header(snapshot, 0), source: 'none' as const },
      { ...header(snapshot, 0), is_candidate: true },
    ])
      await expect(
        collect(chunkFrozenMeeting(snapshot, metadata, source())),
      ).rejects.toMatchObject({ code: 'transcript_integrity_error' });
    expect(reads).toBe(0);
  });
  it('propagates source revocation without converting it into successful partial evidence', async () => {
    const snapshot = meeting();
    async function* source(): AsyncGenerator<TranscriptPage> {
      throw new ServiceError(
        'workspace_access_revoked',
        'Synthetic revoked source.',
        403,
      );
    }
    await expect(
      collect(chunkFrozenMeeting(snapshot, header(snapshot, 1), source())),
    ).rejects.toMatchObject({ code: 'workspace_access_revoked' });
  });
  it('allows notes without a transcript but rejects empty context and already aborted work', async () => {
    const snapshot = { ...meeting('Notes only.'), transcript_revision: 0 };
    const chunks = await collect(
      chunkFrozenMeeting(snapshot, header(snapshot, 0), supplied([])),
    );
    assertCoverage(chunks, snapshot, []);
    await expect(
      collect(
        chunkFrozenMeeting(
          { ...snapshot, notes: ' \n ' },
          header(snapshot, 0),
          supplied([]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'empty_context' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        chunkFrozenMeeting(
          snapshot,
          header(snapshot, 0),
          supplied([]),
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects corrupted cached ranges, fabricated revisions and oversized complete JSON inputs', async () => {
    const snapshot = meeting();
    const [valid] = await collect(
      chunkFrozenMeeting(snapshot, header(snapshot, 0), supplied([])),
    );
    const unit = valid!.units[0]!;
    for (const changed of [
      { ...unit, text_start: 1 },
      { ...unit, start_ms: 1 },
      { ...unit, citation: { ...unit.citation, revision: 8 } },
      { ...unit, text: 'x'.repeat(6000), text_start: 0, text_end: 6000 },
    ])
      expect(
        summaryEvidenceChunkSchema.safeParse({ ...valid, units: [changed] })
          .success,
      ).toBe(false);
  });
});
