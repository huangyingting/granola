import { createHash } from 'node:crypto';
import type { AudioEvent } from '@windows-ai-notes/contracts';

const roles = [
  'audio_host',
  'audio_core',
  'naudio_core',
  'naudio_wasapi',
] as const;
type Timeline = Extract<
  AudioEvent,
  { event_type: 'recording.manifest' }
>['payload']['events'];

export function readCaptureBuild(events: Timeline, startedMs: number) {
  if (events.length === 0) return null;
  const invalid = () =>
    new Error('Capture build provenance is incomplete or inconsistent.');
  if (events.length !== roles.length + 1) throw invalid();
  let clock = 0;
  for (const event of events) {
    if (
      !Number.isFinite(event.clock_ms) ||
      event.clock_ms < clock ||
      event.clock_ms > startedMs ||
      event.capture_epoch !== null ||
      typeof event.code !== 'string' ||
      event.code.length !== 64 ||
      !/^[a-f0-9]{64}$/u.test(event.code)
    )
      throw invalid();
    clock = event.clock_ms;
  }
  const components = roles.map((role, index) => {
    const event = events[index]!;
    if (event.event_type !== `capture.component.${role}`) throw invalid();
    return { role, sha256: event.code! };
  });
  const fingerprint = createHash('sha256')
    .update('windows-ai-notes.capture-components.v1\n')
    .update(
      components.map(({ role, sha256 }) => `${role}:${sha256}\n`).join(''),
    )
    .digest('hex');
  const aggregate = events.at(-1)!;
  if (
    aggregate.event_type !== 'capture.build' ||
    aggregate.code !== fingerprint
  )
    throw invalid();
  return {
    version: 1,
    components,
    sha256: fingerprint,
    publisher_trust_evaluated: false,
    source_commit_evaluated: false,
    loaded_process_attestation_evaluated: false,
  } as const;
}
