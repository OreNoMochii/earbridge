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

/** A stretch of the conversation, in seconds on its clock. */
export interface Span {
  start: number;
  end: number;
}

/** How far some speech stood above the place's background, in dB. */
export interface Margin {
  db: number;
  /** Measured from its words, timed by the recognizer, not from the loudest of the last seconds. */
  timed: boolean;
}

/** 100 ms: the pieces of audio how loud the place is gets measured in. */
const PIECE = AUDIO_SAMPLE_RATE / 10;
const PIECES_PER_SECOND = AUDIO_SAMPLE_RATE / PIECE;
/** Quieter than any place: the phone muting its microphone while it speaks. */
const DIGITAL_SILENCE_DB = -90;
/** The last half minute tells how loud the place is, once 10 s of it were heard. */
const PLACE_PIECES = 300;
const MIN_PLACE_PIECES = 100;
const MIN_SPEECH_PIECES = 5;
/** Without word timings, the speech is the loudest of the last 8 s. */
const RECENT_PIECES = 80;
/**
 * How far above the place the two people's speech must stand for the noisy-place filters
 * to tell them from the others: with chatter closer to their voices than that, voice prints
 * miss more than a tenth of what they say. Measured from the loudest of the last seconds,
 * speech stands about 1 dB higher.
 */
const ENOUGH_DB = 8;
const ENOUGH_UNTIMED_DB = 9;
/** How many of the latest utterances count, of one side (or of both, without word timings). */
const JUDGED = 4;

/**
 * How loud the place is, against how loud the two people at the phone sound. Once their
 * speech barely stands out of the chatter around, no filter can tell them from the others,
 * and the recognizer gets their words wrong: holding a button to talk works better.
 */
export class NoisyPlace {
  /** How loud each 100 ms of the last half minute or so was, in dB below full scale. */
  private pieces: number[] = [];
  /** The number of the first piece kept. */
  private first = 0;
  /** The piece being filled: its sum of squares, and how many samples it has. */
  private sum = 0;
  private filled = 0;
  private samples = 0;
  /** How far above what they need the latest utterances stood, by side ('' without word timings). */
  private readonly latest = new Map<string, number[]>();

  /** Seconds of audio so far: the conversation's clock. */
  get now(): number {
    return this.samples / AUDIO_SAMPLE_RATE;
  }

  /** Some 16 kHz mono PCM16. */
  append(pcm: Uint8Array): void {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i + 2 <= pcm.byteLength; i += 2) {
      const sample = view.getInt16(i, true);
      this.sum += sample * sample;
      if (++this.filled === PIECE) {
        this.pieces.push(Math.max(SILENCE_DB, 10 * Math.log10(this.sum / PIECE / 32768 ** 2)));
        this.sum = 0;
        this.filled = 0;
      }
    }
    this.samples += pcm.byteLength >> 1;
    if (this.pieces.length >= 2 * PLACE_PIECES) {
      this.first += this.pieces.length - PLACE_PIECES;
      this.pieces = this.pieces.slice(-PLACE_PIECES);
    }
  }

  /**
   * How far above the place's background the speech in `span` stands: the level the
   * loudest 30% of its pieces reach. Without a span, the loudest of the last seconds
   * count. Undefined until there is enough to tell.
   */
  margin(span: Span | undefined): Margin | undefined {
    const background = this.background();
    if (background === undefined) return undefined;
    if (span) {
      const from = Math.max(0, Math.floor(span.start * PIECES_PER_SECOND) - this.first);
      const to = Math.floor(span.end * PIECES_PER_SECOND) + 1 - this.first;
      const speech = heard(this.pieces.slice(from, Math.max(from, to))).sort((a, b) => a - b);
      if (speech.length < MIN_SPEECH_PIECES) return undefined;
      return { db: speech[Math.floor(speech.length * 0.7)]! - background, timed: true };
    }
    const recent = heard(this.pieces.slice(-RECENT_PIECES)).sort((a, b) => b - a);
    if (recent.length < MIN_SPEECH_PIECES) return undefined;
    return { db: recent[Math.floor(recent.length * 0.15)]! - background, timed: false };
  }

  /** Remembers how far above the place something one side said stood. */
  hear(side: string, margin: Margin): void {
    const key = margin.timed ? side : '';
    const above = margin.db - (margin.timed ? ENOUGH_DB : ENOUGH_UNTIMED_DB);
    this.latest.set(key, [...(this.latest.get(key) ?? []), above].slice(-JUDGED));
  }

  /**
   * Whether the two people barely stand out of the place: the latest utterances of one of
   * them (of both, without word timings) stood, by their median, less far above it than
   * the filters need.
   */
  get tooLoud(): boolean {
    for (const above of this.latest.values()) {
      if (above.length === JUDGED && median(above) < 0) return true;
    }
    return false;
  }

  /** The level the quietest tenth of the last half minute stayed under, digital silence aside. */
  private background(): number | undefined {
    const place = heard(this.pieces.slice(-PLACE_PIECES)).sort((a, b) => a - b);
    return place.length < MIN_PLACE_PIECES ? undefined : place[Math.floor(place.length * 0.1)];
  }
}

/** Levels of pieces with something in them, not the microphone muted. */
function heard(levels: number[]): number[] {
  return levels.filter((level) => level > DIGITAL_SILENCE_DB);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
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
