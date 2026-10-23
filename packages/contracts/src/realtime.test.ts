import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  liveRecognitionEventSchema,
  liveSourceSchema,
  liveClientMessageSchema,
  liveServerMessageSchema,
  SEGMENTED_LIVE_PROFILE,
  liveTranscriptionCapabilitiesSchema,
} from './realtime.js';

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
  it('requires explicit negotiation for the fixed long-phrase budget and keeps legacy readiness unchanged', () => {
    const ready = {
      schema_version: 1,
      event_type: 'live.ready',
      source: event.source,
      provider_epoch: event.provider_epoch,
      canonical: false,
      continuity: 'unverified',
      max_media_ms: 60_000,
      max_unfinalized_ms: 5000,
    };
    expect(liveServerMessageSchema.parse(ready)).toEqual(ready);
    const segmented = {
      ...ready,
      profile: SEGMENTED_LIVE_PROFILE,
      max_unfinalized_ms: 25_000,
    };
    expect(liveServerMessageSchema.parse(segmented)).toEqual(segmented);
    for (const change of [
      { max_unfinalized_ms: 25_000 },
      { profile: SEGMENTED_LIVE_PROFILE },
      { profile: 'unbounded', max_unfinalized_ms: 25_000 },
      { profile: SEGMENTED_LIVE_PROFILE, max_unfinalized_ms: 30_000 },
      {
        profile: SEGMENTED_LIVE_PROFILE,
        max_unfinalized_ms: 25_000,
        canonical: true,
      },
    ])
      expect(
        liveServerMessageSchema.safeParse({ ...ready, ...change }).success,
      ).toBe(false);
    const capabilities = {
      configured: true,
      max_media_seconds: 60,
      max_unfinalized_seconds: 5,
      canonical: false,
      automatic_reconnect: false,
    };
    expect(liveTranscriptionCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
    expect(
      liveTranscriptionCapabilitiesSchema.safeParse({
        ...capabilities,
        profiles: [SEGMENTED_LIVE_PROFILE],
      }).success,
    ).toBe(true);
    for (const profiles of [
      ['unbounded'],
      [SEGMENTED_LIVE_PROFILE, SEGMENTED_LIVE_PROFILE],
    ])
      expect(
        liveTranscriptionCapabilitiesSchema.safeParse({
          ...capabilities,
          profiles,
        }).success,
      ).toBe(false);
  });
  it('bounds live wire batches and separates authorization cursors from finalization-only flow credit', () => {
    const pcm = {
      ...event.source,
      format_version: 1,
      sequence: 0,
      sample_start: 0,
      sample_count: 800,
      sample_rate: 16_000,
      channels: 1,
      bits_per_sample: 16,
      clock_start_ms: 0,
      clock_end_ms: 50,
      data_base64: Buffer.alloc(1600).toString('base64'),
    };
    const start = {
      schema_version: 1,
      event_type: 'live.start',
      request_id: randomUUID(),
      source: event.source,
      locale: 'en-US',
      consent: true,
    };
    expect(liveClientMessageSchema.parse(start)).toEqual(start);
    for (const change of [
      { consent: false },
      { provider: 'azure' },
      { budget: 1 },
      { access_expires_at: 123 },
    ])
      expect(
        liveClientMessageSchema.safeParse({ ...start, ...change }).success,
      ).toBe(false);
    const audio = {
      schema_version: 1,
      event_type: 'live.audio',
      frames: [pcm],
    };
    expect(liveClientMessageSchema.parse(audio)).toEqual(audio);
    for (const frames of [
      [],
      Array(11).fill(pcm),
      [pcm, pcm],
      [pcm, { ...pcm, sequence: 1, sample_start: 800, track_id: randomUUID() }],
    ])
      expect(
        liveClientMessageSchema.safeParse({ ...audio, frames }).success,
      ).toBe(false);
    const accepted = {
      schema_version: 1,
      event_type: 'live.accepted',
      source: event.source,
      provider_epoch: event.provider_epoch,
      acknowledgment: 'authorization_only',
      next_sequence: 1,
      next_sample: 800,
      accepted_samples: 800,
      finalized_samples: 0,
      gap: null,
    };
    expect(liveServerMessageSchema.parse(accepted)).toEqual(accepted);
    expect(
      liveServerMessageSchema.safeParse({
        ...accepted,
        finalized_samples: 1600,
      }).success,
    ).toBe(false);
    expect(
      liveServerMessageSchema.safeParse({
        ...accepted,
        acknowledgment: 'persisted',
      }).success,
    ).toBe(false);
    const progress = {
      schema_version: 1,
      event_type: 'live.progress',
      source: event.source,
      provider_epoch: event.provider_epoch,
      acknowledgment: 'provider_finalization_only',
      finalized_samples: 1600,
    };
    expect(liveServerMessageSchema.parse(progress)).toEqual(progress);
    for (const finalized_samples of [0, 800, 1601, 960_001])
      expect(
        liveServerMessageSchema.safeParse({ ...progress, finalized_samples })
          .success,
      ).toBe(false);
    expect(
      liveServerMessageSchema.safeParse({
        schema_version: 1,
        event_type: 'live.closed',
        reason: 'finished',
        usage_status: 'settled',
        canonical: true,
        continuity: 'complete',
      }).success,
    ).toBe(false);
  });
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
    expect(
      liveRecognitionEventSchema.parse({
        ...discarded,
        discard_reason: 'empty_final',
      }),
    ).toMatchObject({
      event_type: 'transcript.discarded',
      discard_reason: 'empty_final',
    });
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
