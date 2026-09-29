// Kept free of DOM APIs so it can be unit-tested in Node.

const TAP_COUNT = 63;

/**
 * Converts microphone audio (Float32 at the AudioContext's rate, usually 44.1 or 48 kHz)
 * into 16-bit PCM at the speech recognizer's rate, one chunk at a time.
 *
 * A windowed-sinc low-pass filter first removes what the lower rate cannot represent
 * (otherwise it would fold back as noise), then samples are linearly interpolated.
 * Output positions are computed with integer arithmetic, so the result does not depend
 * on how the input is split into chunks and never drifts.
 */
export class StreamingResampler {
  private readonly inputRate: number;
  private readonly outputRate: number;
  private readonly taps: Float32Array;
  private history: Float32Array;
  private lastFiltered = 0;
  private consumed = 0; // input samples before the current chunk
  private produced = 0; // output samples so far

  constructor(inputRate: number, outputRate: number) {
    this.inputRate = Math.round(inputRate);
    this.outputRate = Math.round(outputRate);
    if (!(this.inputRate > 0 && this.outputRate > 0)) throw new RangeError('Sample rates must be positive.');
    this.taps =
      this.inputRate > this.outputRate
        ? lowPassTaps((0.4375 * this.outputRate) / this.inputRate, TAP_COUNT) // 7 kHz for 16 kHz output
        : new Float32Array([1]);
    this.history = new Float32Array(this.taps.length - 1);
  }

  process(input: Float32Array): Int16Array<ArrayBuffer> {
    const length = input.length;
    if (length === 0) return new Int16Array(0);
    const filtered = this.filter(input);

    const out = new Int16Array(Math.ceil(((length + 1) * this.outputRate) / this.inputRate) + 1);
    let count = 0;
    for (;;) {
      // Position of the next output sample, in input samples from the start of this chunk.
      const position = (this.produced * this.inputRate - this.consumed * this.outputRate) / this.outputRate;
      if (position >= length - 1) break;
      const index = Math.floor(position);
      const before = index < 0 ? this.lastFiltered : filtered[index]!;
      const after = filtered[index + 1]!;
      out[count++] = toInt16(before + (after - before) * (position - index));
      this.produced += 1;
    }

    this.consumed += length;
    this.lastFiltered = filtered[length - 1]!;
    return out.slice(0, count);
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.taps;
    const tapCount = taps.length;
    if (tapCount === 1) return input;
    const buffer = new Float32Array(tapCount - 1 + input.length);
    buffer.set(this.history);
    buffer.set(input, tapCount - 1);
    const filtered = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let sum = 0;
      for (let k = 0; k < tapCount; k++) sum += taps[k]! * buffer[i + tapCount - 1 - k]!;
      filtered[i] = sum;
    }
    this.history = buffer.slice(input.length);
    return filtered;
  }
}

/** Blackman-windowed sinc low-pass; `cutoff` is a fraction of the sample rate. */
function lowPassTaps(cutoff: number, count: number): Float32Array {
  const taps = new Float32Array(count);
  const middle = (count - 1) / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1));
    taps[i] = sinc * window;
    sum += sinc * window;
  }
  for (let i = 0; i < count; i++) taps[i] = taps[i]! / sum; // unity gain for speech frequencies
  return taps;
}

function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

/** Root-mean-square level of a chunk, 0..1. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}
