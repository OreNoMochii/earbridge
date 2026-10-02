import { AUDIO_SAMPLE_RATE, SOLO_THEM } from '../protocol.ts';

/** Turns speech into voice prints: vectors that point the same way for the same voice. */
export interface VoicePrinter {
  /** The phone owner's voice print, from a recording made in the settings. */
  mine: Float32Array;
  /** A voice print of some 16 kHz mono speech; undefined when it cannot make one. */
  print(samples: Int16Array): Promise<Float32Array | undefined>;
}

/** Shorter speech is let through unchecked: its voice print would be unreliable. */
const MIN_CHECK_SECONDS = 1;
/** The other person's voice is learned from something at least this long. */
const MIN_LEARN_SECONDS = 1.5;
/** Long speech is printed from its middle part, which is plenty and keeps the phone quick. */
const MAX_PRINT_SECONDS = 10;
/**
 * How alike two voice prints must be (cosine similarity) to be the same voice. With the
 * phone's speaker model (CAM++), someone else's voice gets there about 1 time in 100;
 * 2 seconds of the same voice in loud chatter fall short about 4 times in 100.
 */
const SAME_VOICE = 0.4;
/** Only speech this unlike my voice teaches the other person's. */
const NOT_MINE = 0.2;
/** The other person's print follows the last few things they said, as their voice and place vary. */
const PARTNER_MEMORY = 10;

/**
 * Tells the voices of the two people at the phone from everyone else's. Mine is known
 * from a recording; the other person's is learned from the first thing they say (or
 * again after a tap on "Them", or on something skipped that was them after all).
 */
export class VoiceFilter {
  private readonly printer: VoicePrinter;
  private readonly mine: Float32Array;
  /** The sum of the other person's recent voice prints, when known. */
  private partner: Float32Array | undefined;
  private partnerPrints = 0;

  constructor(printer: VoicePrinter) {
    this.printer = printer;
    this.mine = normalized(printer.mine);
  }

  /** A voice print of some speech, unless it is too short to tell whose voice it is. */
  async printOf(samples: Int16Array): Promise<Float32Array | undefined> {
    const seconds = samples.length / AUDIO_SAMPLE_RATE;
    if (seconds < MIN_CHECK_SECONDS) return undefined;
    const keep = MAX_PRINT_SECONDS * AUDIO_SAMPLE_RATE;
    const start = Math.max(0, Math.floor((samples.length - keep) / 2));
    const print = await this.printer.print(samples.subarray(start, start + keep));
    return print && print.length === this.mine.length ? normalized(print) : undefined;
  }

  /**
   * Whether a voice is one of the conversation's two, for speech attributed to `side`
   * (by its language, or by the "Me" / "Them" choice). The first voice that is not mine
   * and speaks for them becomes their voice.
   */
  admits(side: string, print: Float32Array, seconds: number): boolean {
    const mine = similarity(print, this.mine);
    const learns = seconds >= MIN_LEARN_SECONDS && mine <= NOT_MINE;
    if (this.partner && similarity(print, normalized(this.partner)) >= SAME_VOICE) {
      if (learns) this.addToPartner(print);
      return true;
    }
    if (mine >= SAME_VOICE) return true;
    if (side !== SOLO_THEM || this.partner) return false;
    if (learns) this.addToPartner(print);
    return true;
  }

  /** Someone else is the other person now: learn their voice from this. */
  learnPartner(print: Float32Array): void {
    this.forgetPartner();
    this.addToPartner(print);
  }

  /** The next thing said for them teaches their voice afresh. */
  forgetPartner(): void {
    this.partner = undefined;
    this.partnerPrints = 0;
  }

  private addToPartner(print: Float32Array): void {
    if (!this.partner) {
      this.partner = new Float32Array(print);
      this.partnerPrints = 1;
      return;
    }
    // A running mean at first, then one that slowly forgets the oldest prints.
    const keep = this.partnerPrints >= PARTNER_MEMORY ? (PARTNER_MEMORY - 1) / PARTNER_MEMORY : 1;
    for (let i = 0; i < print.length; i++) this.partner[i] = this.partner[i]! * keep + print[i]!;
    this.partnerPrints = Math.min(this.partnerPrints + 1, PARTNER_MEMORY);
  }
}

/** Seconds of speech a recording of someone's voice needs for a reliable voice print. */
export const RECORDING_SECONDS = 10;
/** Moments louder than the background by this much are speech, in dB. */
const SPEECH_ABOVE_NOISE_DB = 12;
/** Anything quieter is not speech, in dB below full scale. */
const QUIETEST_SPEECH_DB = -50;
/** The background is as loud as the quietest 10% of a recording's moments. */
const NOISE_PERCENTILE = 0.1;

/**
 * A recording of the phone owner's voice, for their voice print: keeps the moments clearly
 * louder than the background, which are them talking, and leaves out the pauses.
 */
export class VoiceRecording {
  private readonly chunks: Int16Array[] = [];
  /** How loud each chunk is, in dB below full scale. */
  private readonly levels: number[] = [];

  /** Adds some 16 kHz mono audio, such as 100 ms from the microphone. */
  add(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk.slice());
    let sum = 0;
    for (const sample of chunk) sum += sample * sample;
    this.levels.push(Math.max(-100, 10 * Math.log10(sum / chunk.length / 32768 ** 2)));
  }

  /** Seconds of speech so far. */
  get speechSeconds(): number {
    return this.speechChunks().reduce((total, chunk) => total + chunk.length, 0) / AUDIO_SAMPLE_RATE;
  }

  /** The speech so far, without the pauses. */
  speech(): Int16Array {
    const chunks = this.speechChunks();
    const speech = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      speech.set(chunk, offset);
      offset += chunk.length;
    }
    return speech;
  }

  private speechChunks(): Int16Array[] {
    const sorted = [...this.levels].sort((a, b) => a - b);
    const noise = sorted[Math.floor(sorted.length * NOISE_PERCENTILE)] ?? 0;
    const threshold = Math.max(QUIETEST_SPEECH_DB, noise + SPEECH_ABOVE_NOISE_DB);
    return this.chunks.filter((_, i) => this.levels[i]! >= threshold);
  }
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}
