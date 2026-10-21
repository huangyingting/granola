import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { desktopCommandSchema } from './desktop.js';
import { summarySchema } from './server.js';
import {
  summaryCitations,
  summaryReferences,
  summaryReviewSchema,
  summarySourceSchema,
  summarySubmissionSchema,
  summaryText,
} from './generation.js';

describe('reviewed summary contracts', () => {
  const note = { source: 'note' as const, id: randomUUID(), revision: 2 };
  const segment = {
    source: 'transcript' as const,
    id: randomUUID(),
    revision: 3,
  };
  const fact = {
    text: 'Verify the synthetic decision.',
    citations: [note, segment],
  };
  const summary = summarySchema.parse({
    overview: fact,
    topics: [fact],
    decisions: [fact],
    open_questions: [],
    action_items: [{ ...fact, owner: null, due_date: null }],
  });
  it('uses stable unique numbered versioned references without inventing owners or dates', () => {
    expect(summaryCitations(summary)).toEqual([note, segment]);
    expect(summaryText(summary)).toContain(
      'Verify the synthetic decision. [1] [2]',
    );
    expect(summaryText(summary)).toContain(
      'Owner: Not specified; Due: Not specified',
    );
    expect(summaryReferences(summary)).toBe(
      `[1] Note ${note.id}, revision 2\n[2] Transcript segment ${segment.id}, revision 3`,
    );
  });
  it('does not expose the private submission body or idempotency key', () => {
    const submission = {
      language: 'en',
      consent_id: randomUUID(),
      job_id: null,
      rejected: false,
    };
    expect(summarySubmissionSchema.parse(submission)).toEqual(submission);
    expect(
      summarySubmissionSchema.safeParse({
        ...submission,
        key: 'private-request-key',
      }).success,
    ).toBe(false);
    expect(
      summarySubmissionSchema.safeParse({ ...submission, body: {} }).success,
    ).toBe(false);
  });
  it('requires scoped separate consent and bounded editable text', () => {
    const command = {
      operation: 'startSummary',
      scope: 1,
      id: note.id,
      language: 'en',
      consent_id: randomUUID(),
      confirmed: true,
      new_attempt: true,
    };
    expect(desktopCommandSchema.safeParse(command).success).toBe(true);
    expect(
      desktopCommandSchema.safeParse({ ...command, confirmed: false }).success,
    ).toBe(false);
    expect(
      desktopCommandSchema.safeParse({ ...command, confirmed: undefined })
        .success,
    ).toBe(false);
    expect(
      desktopCommandSchema.safeParse({ ...command, scope: 0 }).success,
    ).toBe(false);
    for (const text of ['', 'x'.repeat(40_001), 'not\0supported'])
      expect(summaryReviewSchema.shape.text.safeParse(text).success).toBe(
        false,
      );
    expect(
      summaryReviewSchema.shape.text.safeParse('x'.repeat(40_000)).success,
    ).toBe(true);
  });
  it('represents an empty frozen note explicitly rather than failing source parsing', () => {
    expect(
      summarySourceSchema.parse({
        document_id: note.id,
        job_id: randomUUID(),
        citation: note,
        text: '',
        start_ms: null,
        end_ms: null,
      }).text,
    ).toBe('');
  });
});
