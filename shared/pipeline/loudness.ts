import { AUDIO_SAMPLE_RATE, SOLO_ME, SOLO_THEM } from '../protocol.ts';

/** The last stretch of microphone audio (16 kHz mono PCM16), to look back at what was said. */
export class AudioHistory {
  private readonly keep: number;
  private chunks: Int16Array[] = [];
  /** Sample number of the first sample kept. */
  private first = 0;
  private total = 0;

  constructor(seconds = 30) {
    this.keep = seconds * AUDIO_SAMPLE_RATE;
  }

  /** Seconds of audio so far: the history's clock. */
  get now(): number {
    return this.total / AUDIO_SAMPLE_RATE;
  }

  append(pcm: Uint8Array): void {
    const samples = new Int16Array(pcm.byteLength >> 1);
    new Uint8Array(samples.buffer).set(pcm.subarray(0, samples.byteLength));
    this.chunks.push(samples);
    this.total += samples.length;
    while (this.chunks.length > 1 && this.total - this.first - this.chunks[0]!.length >= this.keep) {
      this.first += this.chunks.shift()!.length;
    }
  }

  /** The audio between two times on the clock, as far as it is still kept. */
  slice(start: number, end: number): Int16Array {
    const from = Math.max(this.first, Math.floor(start * AUDIO_SAMPLE_RATE));
    const to = Math.min(this.total, Math.ceil(end * AUDIO_SAMPLE_RATE));
    if (to <= from) return new Int16Array(0);
    const out = new Int16Array(to - from);
    let at = this.first;
    for (const chunk of this.chunks) {
      const next = at + chunk.length;
      if (next > from) {
        const part = chunk.subarray(Math.max(from - at, 0), Math.min(to - at, chunk.length));
        out.set(part, Math.max(at - from, 0));
      }
      at = next;
      if (at >= to) break;
    }
    return out;
  }
}

const FRAME = AUDIO_SAMPLE_RATE / 50; // 20 ms
const MIN_FRAMES = 10;
const SILENCE_DB = -100;

/**
 * How loud the speech in some audio is, in dB below full scale: the level that the
 * loudest 30% of its 20 ms frames reach, so neither the pauses between words nor a
 * clatter count for much. Undefined when there is too little audio to tell.
 */
export function speechLevel(samples: Int16Array): number | undefined {
  const levels: number[] = [];
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    let sum = 0;
    for (let j = i; j < i + FRAME; j++) sum += samples[j]! * samples[j]!;
    levels.push(Math.max(SILENCE_DB, 10 * Math.log10(sum / FRAME / 32768 ** 2)));
  }
  if (levels.length < MIN_FRAMES) return undefined;
  levels.sort((a, b) => b - a);
  return levels[Math.floor(levels.length * 0.3)];
}

/** How much quieter than usual a side may sound, in dB: about four times as far from the phone. */
const MARGIN_DB = 12;
/** The same, compared with the other side, until this one has spoken a few times. */
const OTHER_SIDE_MARGIN_DB = 20;
const KEEP_LEVELS = 8;
const MIN_LEVELS = 3;
/** Seconds of listening after which a level no longer counts: people move. */
const FORGET_AFTER = 180;

/**
 * Learns how loud each side of a one-phone conversation usually sounds, to tell the two
 * people at the phone from others further away (or a radio), who sound much quieter.
 */
export class LoudnessGate {
  private readonly levels = new Map<string, Level[]>();
  /** Levels refused but then translated after all: that quiet was near enough. */
  private readonly allowed = new Map<string, Level[]>();

  /** Whether speech this loud could be from that side. `now` is in seconds of listening. */
  accepts(side: string, level: number, now: number): boolean {
    const own = this.reference(side, now);
    if (own !== undefined) return level >= own - MARGIN_DB;
    const other = this.reference(side === SOLO_ME ? SOLO_THEM : SOLO_ME, now);
    return other === undefined || level >= other - OTHER_SIDE_MARGIN_DB;
  }

  /** Remembers how loud something that side said was. */
  learn(side: string, level: number, now: number): void {
    remember(this.levels, side, level, now);
  }

  /** Something refused as too quiet was that side after all. */
  allow(side: string, level: number, now: number): void {
    remember(this.allowed, side, level, now);
    this.learn(side, level, now);
  }

  /**
   * How loud that side usually is: the upper quartile of its last few levels, so the odd
   * quieter voice let through does not lower it; but no louder than what was allowed.
   */
  private reference(side: string, now: number): number | undefined {
    const levels = recent(this.levels, side, now)
      .map((entry) => entry.level)
      .sort((a, b) => a - b);
    const usual = levels.length >= MIN_LEVELS ? levels[Math.floor((levels.length - 1) * 0.75)] : undefined;
    const allowed = recent(this.allowed, side, now).map((entry) => entry.level);
    return allowed.length > 0 ? Math.min(usual ?? Infinity, ...allowed) : usual;
  }
}

interface Level {
  level: number;
  /** When it was heard, in seconds of listening. */
  at: number;
}

function recent(levels: Map<string, Level[]>, side: string, now: number): Level[] {
  return (levels.get(side) ?? []).filter((entry) => now - entry.at <= FORGET_AFTER);
}

function remember(levels: Map<string, Level[]>, side: string, level: number, now: number): void {
  levels.set(side, [...recent(levels, side, now), { level, at: now }].slice(-KEEP_LEVELS));
}
