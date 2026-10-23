import { describe, expect, it } from 'vitest';
import {
  calibration,
  calibrationPcm,
  LandmarkDecoder,
  markerPcm,
  wavHeader,
} from './calibration-signal.js';

describe('fixed calibration signal', () => {
  it('generates a bounded canonical one-hour WAV header', () => {
    const header = wavHeader(3600 * 16_000);
    expect(header.length).toBe(44);
    expect(header.subarray(0, 4).toString()).toBe('RIFF');
    expect(header.readUInt32LE(4)).toBe(115_200_036);
    expect(header.subarray(8, 16).toString()).toBe('WAVEfmt ');
    expect(header.readUInt32LE(24)).toBe(16_000);
    expect(header.readUInt32LE(40)).toBe(115_200_000);
    for (const value of [0, -1, NaN, Infinity, 1.5, 3660 * 16_000 + 1])
      expect(() => wavHeader(value)).toThrow('bounded');
  });

  it.each([0, 1, 127, 319])(
    'finds all marker IDs with sample phase %i and arbitrary byte fragmentation',
    (phase) => {
      for (let index = 0; index < calibration.markerSeconds.length; index++) {
        const decoder = new LandmarkDecoder();
        const lead = 1600 + phase;
        const source = Buffer.concat([
          Buffer.alloc(lead * 2),
          markerPcm(index),
          Buffer.alloc(1600 * 2),
        ]);
        for (let offset = 0; offset < source.length; offset += 997)
          decoder.write(source.subarray(offset, offset + 997));
        const result = decoder.finish();
        expect(result.samples).toBe(source.length / 2);
        expect(result.markers).toHaveLength(1);
        expect(result.markers[0]!.index).toBe(index);
        expect(Math.abs(result.markers[0]!.sample - lead)).toBeLessThanOrEqual(
          320,
        );
        expect(result.duplicate_marker_ids).toEqual([]);
        expect(result.unexpected_marker_ids).toEqual([]);
      }
    },
  );

  it('matches quiet attenuated markers with deterministic additive noise', () => {
    const source = markerPcm(5);
    let noise = 1;
    for (let offset = 0; offset < source.length; offset += 2) {
      noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
      source.writeInt16LE(
        Math.round(source.readInt16LE(offset) * 0.25 + (noise % 101) - 50),
        offset,
      );
    }
    const decoder = new LandmarkDecoder();
    decoder.write(Buffer.alloc(3200));
    decoder.write(source);
    decoder.write(Buffer.alloc(3200));
    expect(decoder.finish().markers).toEqual([{ index: 5, sample: 1600 }]);
  });

  it('rejects invalid marker checksums, silence and unrelated single tones', () => {
    const invalid = markerPcm(0);
    const changed = markerPcm(8);
    changed.copy(invalid, 13 * 3200, 13 * 3200, 14 * 3200);
    const decoder = new LandmarkDecoder();
    decoder.write(Buffer.alloc(32000));
    decoder.write(invalid);
    const tone = Buffer.alloc(16_000 * 2 * 3);
    for (let sample = 0; sample < tone.length / 2; sample++)
      tone.writeInt16LE(
        Math.round(2000 * Math.sin((2 * Math.PI * sample) / 16)),
        sample * 2,
      );
    decoder.write(tone);
    expect(decoder.finish().markers).toEqual([]);
  });

  it('reports repeated and unexpected IDs rather than silently selecting one', () => {
    const decoder = new LandmarkDecoder();
    for (const index of [0, 0, 15]) {
      decoder.write(Buffer.alloc(3200));
      decoder.write(markerPcm(index));
      decoder.write(Buffer.alloc(3200));
    }
    const result = decoder.finish();
    expect(result.markers).toHaveLength(1);
    expect(result.duplicate_marker_ids).toEqual([0]);
    expect(result.unexpected_marker_ids).toEqual([15]);
  });

  it('rejects incomplete PCM and terminal decoder reuse', () => {
    const decoder = new LandmarkDecoder();
    decoder.write(Buffer.from([1]));
    expect(() => decoder.finish()).toThrow('incomplete');
    expect(() => decoder.write(Buffer.alloc(2))).toThrow('closed');
    expect(() => decoder.finish()).toThrow('closed');
  });

  it('keeps fixture chunks bounded and leaves a quiet nonzero carrier between markers', () => {
    const iterator = calibrationPcm();
    const first = iterator.next().value!;
    expect(first.length).toBe(32_000);
    expect(first.some((byte) => byte !== 0)).toBe(true);
    const decoder = new LandmarkDecoder();
    decoder.write(first);
    for (let second = 1; second < 24; second++)
      decoder.write(iterator.next().value!);
    expect(decoder.finish().markers).toEqual([
      { index: 0, sample: 20 * 16_000 },
    ]);
    iterator.return(undefined);
  });
});
