import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StreamingResampler, rms } from '../src/audio/resampler.ts';

function sine(frequency: number, sampleRate: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return samples;
}

/** Feeds `input` to a new resampler in chunks of the given sizes (cycled) and joins the output. */
function resample(input: Float32Array, inputRate: number, outputRate: number, chunkSizes: number[]): Int16Array {
  const resampler = new StreamingResampler(inputRate, outputRate);
  const parts: Int16Array[] = [];
  for (let start = 0, i = 0; start < input.length; i++) {
    const size = chunkSizes[i % chunkSizes.length]!;
    parts.push(resampler.process(input.subarray(start, start + size)));
    start += size;
  }
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** RMS of the output (as -1..1) after skipping the filter's warm-up. */
function level(pcm: Int16Array): number {
  const tail = Float32Array.from(pcm.subarray(200), (sample) => sample / 32768);
  return rms(tail);
}

describe('StreamingResampler', () => {
  for (const inputRate of [48_000, 44_100]) {
    it(`converts ${inputRate} Hz to 16 kHz with the right number of samples`, () => {
      const out = resample(sine(440, inputRate, 1), inputRate, 16_000, [inputRate / 20]);
      assert.ok(Math.abs(out.length - 16_000) <= 1, `got ${out.length} samples`);
    });

    it(`keeps speech frequencies and removes what 16 kHz cannot hold (${inputRate} Hz)`, () => {
      const amplitude = 0.5;
      const expected = amplitude / Math.SQRT2;
      const speech = level(resample(sine(1_000, inputRate, 0.5, amplitude), inputRate, 16_000, [2_048]));
      assert.ok(Math.abs(speech - expected) / expected < 0.05, `1 kHz came out at ${speech}`);
      // Without the low-pass filter 12 kHz would fold back to 4 kHz at full strength.
      const aliased = level(resample(sine(12_000, inputRate, 0.5, amplitude), inputRate, 16_000, [2_048]));
      assert.ok(aliased < expected * 0.01, `12 kHz leaked through at ${aliased}`);
    });

    it(`gives the same output however the input is chunked (${inputRate} Hz)`, () => {
      const input = sine(700, inputRate, 0.3);
      const whole = resample(input, inputRate, 16_000, [input.length]);
      const chunked = resample(input, inputRate, 16_000, [128, 1, 2_048, 333, 7]);
      assert.deepEqual(chunked, whole);
    });
  }

  it('passes audio through at the same rate, one sample late', () => {
    const resampler = new StreamingResampler(16_000, 16_000);
    assert.deepEqual([...resampler.process(new Float32Array([0, 0.5, -0.5]))], [0, 16_384]);
    assert.deepEqual([...resampler.process(new Float32Array([0.25]))], [-16_384]);
  });

  it('upsamples low-rate Bluetooth audio by interpolating', () => {
    const resampler = new StreamingResampler(8_000, 16_000);
    assert.deepEqual([...resampler.process(new Float32Array([0, 0.5, 1]))], [0, 8_192, 16_384, 24_575]);
  });

  it('clips out-of-range samples instead of wrapping around', () => {
    const resampler = new StreamingResampler(16_000, 16_000);
    assert.deepEqual([...resampler.process(new Float32Array([1.5, -1.5, 0]))], [32_767, -32_768]);
  });

  it('handles empty chunks and rejects nonsense rates', () => {
    assert.equal(new StreamingResampler(48_000, 16_000).process(new Float32Array(0)).length, 0);
    assert.throws(() => new StreamingResampler(0, 16_000), RangeError);
  });
});

describe('rms', () => {
  it('measures loudness', () => {
    assert.equal(rms(new Float32Array(0)), 0);
    assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5);
  });
});
