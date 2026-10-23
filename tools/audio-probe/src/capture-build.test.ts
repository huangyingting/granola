import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCaptureBuild } from './capture-build.js';

type Vector = {
  name: string;
  components: { role: string; sha256: string }[];
  expected_sha256: string;
};
const vectors: Vector[] = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/contracts/fixtures/capture-build.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
function timeline(
  vector = vectors[0]!,
): Parameters<typeof readCaptureBuild>[0] {
  return [
    ...vector.components.map(({ role, sha256 }) => ({
      event_type: `capture.component.${role}`,
      clock_ms: 10,
      capture_epoch: null,
      code: sha256,
    })),
    {
      event_type: 'capture.build',
      clock_ms: 10,
      capture_epoch: null,
      code: vector.expected_sha256,
    },
  ];
}

describe('authenticated capture component provenance', () => {
  it.each(vectors)(
    'matches the shared $name canonical fingerprint without claiming trust',
    (vector) => {
      expect(readCaptureBuild(timeline(vector), 20)).toEqual({
        version: 1,
        components: vector.components,
        sha256: vector.expected_sha256,
        publisher_trust_evaluated: false,
        source_commit_evaluated: false,
        loaded_process_attestation_evaluated: false,
      });
    },
  );

  it('explicitly preserves legacy missing provenance instead of inventing a build', () => {
    expect(readCaptureBuild([], 20)).toBeNull();
  });

  it.each(['\n', '\r\n'])(
    'rejects a noncanonical trailing newline even when the aggregate binds its bytes (%j)',
    (suffix) => {
      const vector = structuredClone(vectors[0]!);
      vector.components[0]!.sha256 += suffix;
      vector.expected_sha256 = createHash('sha256')
        .update('windows-ai-notes.capture-components.v1\n')
        .update(
          vector.components
            .map(({ role, sha256 }) => `${role}:${sha256}\n`)
            .join(''),
        )
        .digest('hex');
      expect(() => readCaptureBuild(timeline(vector), 20)).toThrow(
        'provenance',
      );
    },
  );

  it.each([
    'partial',
    'aggregate-only',
    'wrong-role',
    'duplicate',
    'reordered',
    'wrong-hash',
    'upper-case',
    'null',
    'future',
    'regressing',
    'wrong-type',
    'wrong-epoch',
  ])('rejects %s provenance rather than downgrading to legacy', (scenario) => {
    let events = timeline();
    if (scenario === 'partial') events.pop();
    if (scenario === 'aggregate-only') events = events.slice(-1);
    if (scenario === 'wrong-role')
      events[0]!.event_type = 'capture.component.other';
    if (scenario === 'duplicate') events[1]!.event_type = events[0]!.event_type;
    if (scenario === 'reordered')
      [events[0], events[1]] = [events[1]!, events[0]!];
    if (scenario === 'wrong-hash') events.at(-1)!.code = '0'.repeat(64);
    if (scenario === 'upper-case') events[0]!.code = 'A'.repeat(64);
    if (scenario === 'null') events[0]!.code = null;
    if (scenario === 'future') events[0]!.clock_ms = 21;
    if (scenario === 'regressing') events[1]!.clock_ms = 9;
    if (scenario === 'wrong-type')
      events.at(-1)!.event_type = 'capture.started';
    if (scenario === 'wrong-epoch')
      events[0]!.capture_epoch = '75048e79-2b45-440f-8609-b80a37635b4a';
    expect(() => readCaptureBuild(events, 20)).toThrow('provenance');
  });
});
