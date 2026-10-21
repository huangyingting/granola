import {
  MAX_TRANSCRIPT_TEXT_BYTES,
  ServiceError,
  transcriptHeaderSchema,
  transcriptPageSchema,
  type TranscriptPage,
} from '@windows-ai-notes/contracts/server';
import type { z } from 'zod';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  frozenMeetingSchema,
  summaryEvidenceChunkSchema,
  SUMMARY_EVIDENCE_VERSION,
  SUMMARY_CHUNK_BYTES,
  MAX_SUMMARY_CHUNKS,
  type FrozenMeeting,
  type SummaryEvidenceUnit,
  type SummaryEvidenceChunk,
} from '@windows-ai-notes/contracts/evidence';

const PIECE_BYTES = 3072;
const OVERLAP_BYTES = 128;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const characterBytes = (value: string) => bytes(value) - 2;
const integrity = () =>
  new ServiceError(
    'transcript_integrity_error',
    'The frozen meeting evidence is inconsistent or incomplete.',
    500,
  );

function* pieces(
  text: string,
  source: Pick<SummaryEvidenceUnit, 'citation' | 'start_ms' | 'end_ms'>,
): Generator<SummaryEvidenceUnit> {
  let part = '',
    size = 0,
    start = 0;
  for (const character of text) {
    const cost = characterBytes(character);
    if (size + cost > PIECE_BYTES && part) {
      yield {
        ...source,
        text: part,
        text_start: start,
        text_end: start + part.length,
        overlap: false,
      };
      start += part.length;
      part = '';
      size = 0;
    }
    part += character;
    size += cost;
  }
  if (part)
    yield {
      ...source,
      text: part,
      text_start: start,
      text_end: start + part.length,
      overlap: false,
    };
}

function tail(unit: SummaryEvidenceUnit): SummaryEvidenceUnit {
  const characters = [...unit.text];
  let start = characters.length,
    size = 0;
  while (start > 0) {
    const cost = characterBytes(characters[start - 1]!);
    if (size + cost > OVERLAP_BYTES) break;
    size += cost;
    start--;
  }
  const text = characters.slice(start).join('');
  return {
    ...unit,
    text,
    text_start: unit.text_end - text.length,
    overlap: true,
  };
}

// Callers authorize each page read; this checks frozen provenance, not ACLs.
export async function* chunkFrozenMeeting(
  snapshot: FrozenMeeting,
  header: z.infer<typeof transcriptHeaderSchema>,
  pages: AsyncIterable<TranscriptPage>,
  signal?: AbortSignal,
): AsyncGenerator<SummaryEvidenceChunk> {
  signal?.throwIfAborted();
  const meeting = frozenMeetingSchema.safeParse(snapshot);
  const transcript = transcriptHeaderSchema.safeParse(header);
  if (
    !meeting.success ||
    !transcript.success ||
    transcript.data.document_id !== meeting.data.document_id ||
    transcript.data.revision !== meeting.data.transcript_revision ||
    transcript.data.is_candidate === true ||
    (transcript.data.source === 'none') !== (transcript.data.revision === 0) ||
    (transcript.data.revision === 0 && transcript.data.total_segments !== 0)
  )
    throw integrity();
  const { notes, ...context } = meeting.data;
  const selected = transcript.data;

  async function* sources(): AsyncGenerator<SummaryEvidenceUnit> {
    if (notes.trim())
      yield* pieces(notes, {
        citation: {
          source: 'note',
          id: context.document_id,
          revision: context.note_revision,
        },
        start_ms: null,
        end_ms: null,
      });
    let offset = 0,
      pageCount = 0,
      textBytes = 0;
    const ids = new Set<string>();
    for await (const page of pages) {
      signal?.throwIfAborted();
      const parsed = transcriptPageSchema.safeParse(page);
      if (!parsed.success) throw integrity();
      const { segments, offset: position, has_more, ...metadata } = parsed.data;
      const more = offset + segments.length < selected.total_segments;
      if (
        canonicalJson(metadata) !== canonicalJson(selected) ||
        position !== offset ||
        (pageCount > 0 && offset >= selected.total_segments) ||
        (segments.length === 0 && offset < selected.total_segments) ||
        has_more !== more ||
        segments.some(
          (segment, index) => segment.text !== page.segments[index]?.text,
        )
      )
        throw integrity();
      pageCount++;
      for (const segment of segments) {
        if (ids.has(segment.id)) throw integrity();
        ids.add(segment.id);
        textBytes += Buffer.byteLength(segment.text);
        if (textBytes > MAX_TRANSCRIPT_TEXT_BYTES) throw integrity();
        yield* pieces(segment.text, {
          citation: {
            source: 'transcript',
            id: segment.id,
            revision: context.transcript_revision,
          },
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
        });
      }
      offset += segments.length;
    }
    if (offset !== selected.total_segments) throw integrity();
  }

  let index = 0;
  let units: SummaryEvidenceUnit[] = [];
  function chunk(items: SummaryEvidenceUnit[]): SummaryEvidenceChunk {
    if (index >= MAX_SUMMARY_CHUNKS)
      throw new ServiceError(
        'context_too_large',
        'The meeting needs more extraction chunks than this version supports.',
        413,
      );
    return {
      ...context,
      version: SUMMARY_EVIDENCE_VERSION,
      index,
      units: items,
    };
  }
  for await (const unit of sources()) {
    signal?.throwIfAborted();
    if (bytes(chunk([...units, unit])) > SUMMARY_CHUNK_BYTES) {
      yield summaryEvidenceChunkSchema.parse(chunk(units));
      signal?.throwIfAborted();
      index++;
      units = [tail(units[units.length - 1]!)];
    }
    if (bytes(chunk([...units, unit])) > SUMMARY_CHUNK_BYTES) throw integrity();
    units.push(unit);
  }
  signal?.throwIfAborted();
  if (!units.length)
    throw new ServiceError(
      'empty_context',
      'Add meeting notes or a canonical transcript before generating.',
      400,
    );
  yield summaryEvidenceChunkSchema.parse(chunk(units));
}
