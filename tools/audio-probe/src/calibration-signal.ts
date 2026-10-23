export const calibration = Object.freeze({
  fixture: 'dual-clock-fsk-v1',
  sampleRate: 16_000,
  durationSeconds: 3600,
  markerSeconds: Object.freeze([
    ...Array.from({ length: 12 }, (_, index) => 20 + index * 300),
    3580,
  ]),
  symbolSamples: 1600,
  binSamples: 320,
  detectionMarginMs: 40,
  targetMs: 200,
});

const prefix = [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];
const binsPerSymbol = calibration.symbolSamples / calibration.binSamples;
const markerBins = (prefix.length + 8) * binsPerSymbol;
const maximumSamples =
  (calibration.durationSeconds + 60) * calibration.sampleRate;
const coefficientA = 2 * Math.cos(Math.PI / 8);
const coefficientB = 2 * Math.cos(Math.PI / 4);

export function wavHeader(samples: number): Buffer {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > maximumSamples)
    throw new Error(
      'Calibration WAV sample count is outside its bounded range.',
    );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(samples * 2 + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(calibration.sampleRate, 24);
  header.writeUInt32LE(calibration.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 2, 40);
  return header;
}

export function markerPcm(index: number): Buffer {
  if (!Number.isInteger(index) || index < 0 || index > 15)
    throw new Error('The calibration marker index must fit four bits.');
  const bits = [
    ...prefix,
    ...Array.from({ length: 4 }, (_, bit) => (index >> (3 - bit)) & 1),
    ...Array.from({ length: 4 }, (_, bit) => ((index ^ 15) >> (3 - bit)) & 1),
  ];
  const pcm = Buffer.alloc(bits.length * calibration.symbolSamples * 2);
  for (const [symbol, bit] of bits.entries()) {
    for (let sample = 0; sample < calibration.symbolSamples; sample++) {
      const envelope = Math.min(1, (sample + 1) / 80, (1600 - sample) / 80);
      const tone =
        0.08 *
        envelope *
        Math.sin((2 * Math.PI * (bit ? 2000 : 1000) * sample) / 16_000);
      const carrier = 0.004 * Math.sin((2 * Math.PI * 250 * sample) / 16_000);
      pcm.writeInt16LE(
        Math.round(32767 * (tone + carrier)),
        (symbol * calibration.symbolSamples + sample) * 2,
      );
    }
  }
  return pcm;
}

export function* calibrationPcm(): Generator<Buffer, undefined, void> {
  const carrier = Buffer.alloc(calibration.sampleRate * 2);
  for (let sample = 0; sample < calibration.sampleRate; sample++)
    carrier.writeInt16LE(
      Math.round(
        32767 * 0.004 * Math.sin((2 * Math.PI * 250 * sample) / 16_000),
      ),
      sample * 2,
    );
  let marker = 0;
  const signals = calibration.markerSeconds.map((_, index) => markerPcm(index));
  for (let second = 0; second < calibration.durationSeconds; second++) {
    const pcm = Buffer.from(carrier);
    const start = calibration.markerSeconds[marker];
    if (start !== undefined && second >= start) {
      const signal = signals[marker]!;
      const offset = (second - start) * calibration.sampleRate * 2;
      signal.copy(pcm, 0, offset, offset + pcm.length);
      if (offset + pcm.length >= signal.length) marker++;
    }
    yield pcm;
  }
}

export type Landmark = { index: number; sample: number };

export class LandmarkDecoder {
  private readonly bins: number[] = [];
  private readonly markers = new Map<number, number>();
  private readonly duplicates = new Set<number>();
  private candidate: { index: number; first: number; last: number } | undefined;
  private lowByte: number | undefined;
  private sampleCount = 0;
  private inBin = 0;
  private energy = 0;
  private a1 = 0;
  private a2 = 0;
  private b1 = 0;
  private b2 = 0;
  private closed = false;

  write(bytes: Buffer): void {
    if (this.closed) throw new Error('The calibration decoder is closed.');
    if (this.sampleCount + Math.ceil(bytes.length / 2) > maximumSamples)
      throw new Error('Calibration audio exceeds one hour plus 60 seconds.');
    let offset = 0;
    if (this.lowByte !== undefined && bytes.length > 0) {
      this.sample((((bytes[0]! << 8) | this.lowByte) << 16) >> 16);
      this.lowByte = undefined;
      offset++;
    }
    for (; offset + 1 < bytes.length; offset += 2)
      this.sample(bytes.readInt16LE(offset));
    if (offset < bytes.length) this.lowByte = bytes[offset];
  }

  finish(): {
    samples: number;
    markers: Landmark[];
    duplicate_marker_ids: number[];
    unexpected_marker_ids: number[];
  } {
    if (this.closed) throw new Error('The calibration decoder is closed.');
    this.closed = true;
    if (this.lowByte !== undefined)
      throw new Error('Calibration PCM ends with an incomplete sample.');
    this.commitCandidate();
    return {
      samples: this.sampleCount,
      markers: [...this.markers]
        .filter(([index]) => index < calibration.markerSeconds.length)
        .map(([index, sample]) => ({ index, sample }))
        .sort((left, right) => left.index - right.index),
      duplicate_marker_ids: [...this.duplicates].sort((a, b) => a - b),
      unexpected_marker_ids: [...this.markers.keys()]
        .filter((index) => index >= calibration.markerSeconds.length)
        .sort((a, b) => a - b),
    };
  }

  private sample(value: number): void {
    const a = value + coefficientA * this.a1 - this.a2;
    this.a2 = this.a1;
    this.a1 = a;
    const b = value + coefficientB * this.b1 - this.b2;
    this.b2 = this.b1;
    this.b1 = b;
    this.energy += value * value;
    this.sampleCount++;
    if (++this.inBin !== calibration.binSamples) return;
    const powerA =
      this.a1 ** 2 + this.a2 ** 2 - coefficientA * this.a1 * this.a2;
    const powerB =
      this.b1 ** 2 + this.b2 ** 2 - coefficientB * this.b1 * this.b2;
    const strongest = Math.max(powerA, powerB);
    const tone =
      this.energy / calibration.binSamples >= 16 ** 2 &&
      strongest >= 0.3 * calibration.binSamples * this.energy &&
      strongest >= 4 * Math.min(powerA, powerB)
        ? powerB > powerA
          ? 1
          : 0
        : -1;
    this.a1 = this.a2 = this.b1 = this.b2 = this.energy = this.inBin = 0;
    this.bins.push(tone);
    if (this.bins.length > markerBins) this.bins.shift();
    const index = this.decode();
    if (index !== undefined) {
      const sample = this.sampleCount - markerBins * calibration.binSamples;
      if (this.candidate?.index === index) this.candidate.last = sample;
      else {
        this.commitCandidate();
        this.candidate = { index, first: sample, last: sample };
      }
    } else this.commitCandidate();
  }

  private decode(): number | undefined {
    if (this.bins.length !== markerBins) return undefined;
    const bit = (symbol: number) => {
      const start = symbol * binsPerSymbol + 1;
      const value = this.bins[start]!;
      return value !== -1 &&
        value === this.bins[start + 1] &&
        value === this.bins[start + 2]
        ? value
        : undefined;
    };
    if (prefix.some((value, index) => bit(index) !== value)) return undefined;
    let index = 0;
    for (let position = 0; position < 4; position++) {
      const value = bit(prefix.length + position);
      if (
        value === undefined ||
        bit(prefix.length + 4 + position) !== (value ^ 1)
      )
        return undefined;
      index = index * 2 + value;
    }
    return index;
  }

  private commitCandidate(): void {
    if (!this.candidate) return;
    const { index, first, last } = this.candidate;
    if (this.markers.has(index)) this.duplicates.add(index);
    else this.markers.set(index, (first + last) / 2);
    this.candidate = undefined;
  }
}
