import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { liveRecognitionEventSchema, liveSourceSchema } from './realtime.js';

const event = {
  schema_version: 1,
  provider_epoch: randomUUID(),
  source: {
    recording_id: randomUUID(),
    preview_id: randomUUID(),
    track_id: randomUUID(),
    capture_epoch: randomUUID(),
  },
  event_type: 'transcript.partial',
  segment_id: randomUUID(),
  version: 1,
  sample_start: 16_000,
  sample_end: 16_800,
  text: 'Orion',
  discard_reason: null,
  provider_result_id: 'synthetic-result',
};
describe('source-fenced live recognition contracts', () => {
  it('requires complete immutable source identity and explicit bounded provider revisions', () => {
    expect(liveRecognitionEventSchema.parse(event)).toEqual(event);
    for (const change of [
      { source: { ...event.source, capture_epoch: 'invalid' } },
      { provider_epoch: 'invalid' },
      { version: 0 },
      { version: 1_000_001 },
      { text: 'x'.repeat(4001) },
      { sample_end: 15_999 },
      { sample_end: 230_400_001 },
      { provider_result_id: 'x\r\nsecret' },
      { unknown: true },
    ])
      expect(
        liveRecognitionEventSchema.safeParse({ ...event, ...change }).success,
      ).toBe(false);
    expect(
      liveSourceSchema.safeParse({ ...event.source, document_id: randomUUID() })
        .success,
    ).toBe(false);
  });
  it('requires nonempty provisional/final text and never accepts a silent empty-text deletion', () => {
    for (const event_type of ['transcript.partial', 'transcript.final']) {
      expect(
        liveRecognitionEventSchema.safeParse({ ...event, event_type }).success,
      ).toBe(true);
      for (const text of ['', '   '])
        expect(
          liveRecognitionEventSchema.safeParse({ ...event, event_type, text })
            .success,
        ).toBe(false);
    }
  });
  it('uses an explicit versioned discard event, not final speech, for a rejected hypothesis', () => {
    const discarded = {
      ...event,
      event_type: 'transcript.discarded',
      text: '',
      discard_reason: 'no_match',
    };
    expect(liveRecognitionEventSchema.parse(discarded)).toEqual(discarded);
    for (const change of [
      { text: 'Orion' },
      { discard_reason: null },
      { discard_reason: 'unknown' },
    ])
      expect(
        liveRecognitionEventSchema.safeParse({ ...discarded, ...change })
          .success,
      ).toBe(false);
    expect(
      liveRecognitionEventSchema.safeParse({
        ...event,
        discard_reason: 'no_match',
      }).success,
    ).toBe(false);
  });
});
