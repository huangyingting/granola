import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  AudioState,
  LocalRecording,
} from '@windows-ai-notes/contracts/recording';
import { CaptureMeters } from './Recording.js';

const microphone = randomUUID();
const loopback = randomUUID();
const active: LocalRecording = {
  id: randomUUID(),
  document_id: randomUUID(),
  created_at: '2026-01-01T00:00:00.000Z',
  state: 'recording',
  tracks: [
    {
      spec: {
        track_id: microphone,
        kind: 'microphone',
        capture_scope: 'endpoint',
        device_selection_policy: 'default',
        device_id: 'default',
      },
      actual_device_id: 'synthetic-microphone',
      saved_samples: 480_000,
    },
    {
      spec: {
        track_id: loopback,
        kind: 'loopback',
        capture_scope: 'endpoint',
        device_selection_policy: 'default',
        device_id: 'default',
      },
      actual_device_id: 'synthetic-system-output',
      saved_samples: 0,
    },
  ],
  error: null,
  inspection: null,
};
const levels: NonNullable<AudioState['levels']> = {
  received_at: 10_000,
  capture: {
    capture_epoch: randomUUID(),
    clock_ms: 2000,
    tracks: [
      {
        track_id: microphone,
        level: { samples: 4000, peak: 0.5, rms: 0.25, clock_ms: 2000 },
      },
      { track_id: loopback, level: null },
    ],
  },
};
function render(
  state = active,
  preview: AudioState['levels'] = levels,
  now = 10_500,
) {
  return renderToStaticMarkup(
    createElement(CaptureMeters, { active: state, levels: preview, now }),
  );
}
describe('capture level previews', () => {
  it('names sources, exposes peak/RMS and keeps acknowledged saved duration separate', () => {
    const html = render();
    expect(html).toContain('Microphone level preview');
    expect(html).toContain('-6 dBFS peak; -12 dBFS RMS');
    expect(html).toContain('System audio level preview');
    expect(html).toContain('Waiting for audio');
    expect(html).toContain('0:30 saved in sealed chunks');
    expect(html).toContain('0:00 saved in sealed chunks');
  });
  it('expires delayed previews, handles wall-clock changes and clears paused displays', () => {
    expect(render(active, levels, 11_001)).toContain('No recent audio');
    expect(render(active, levels, 9999)).toContain('No recent audio');
    expect(
      render(active, {
        ...levels,
        capture: { ...levels.capture, clock_ms: 3000 },
      }),
    ).toContain('No recent audio');
    const paused = render({ ...active, state: 'paused' });
    expect(paused).toContain('Paused');
    expect(paused).not.toContain('-6 dBFS');
    expect(render(active, null)).toContain('Waiting for audio');
  });
  it('distinguishes measured silence from missing frames and flags near-full-scale PCM', () => {
    const preview = (peak: number, rms: number) => ({
      ...levels,
      capture: {
        ...levels.capture,
        tracks: [
          {
            track_id: microphone,
            level: { samples: 800, peak, rms, clock_ms: 2000 },
          },
        ],
      },
    });
    expect(render(active, preview(0, 0))).toContain('Silence; RMS silence');
    expect(render(active, preview(1, 0.9))).toContain(
      'Near full scale; check the source volume.',
    );
    expect(render(active, preview(1, 0.9))).toContain('0 dBFS peak');
  });
});
