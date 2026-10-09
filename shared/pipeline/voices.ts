import { AUDIO_SAMPLE_RATE, SOLO_ME, SOLO_THEM } from '../protocol.ts';
import type { PartnerVoice, RecordingProblem } from '../protocol.ts';
import type { Logger } from './log.ts';

/** Turns speech into voice prints: vectors that point the same way for the same voice. */
export interface VoicePrinter {
  /** The phone owner's voice print, from a recording made in the settings. */
  mine: Float32Array;
  /** A voice print of some 16 kHz mono speech; undefined when it cannot make one. */
  print(samples: Int16Array): Promise<Float32Array | undefined>;
}

/** How alike a voice is to each of the two (see `similarity`); -1 where that voice is unknown. */
export interface VoiceLikeness {
  /** To mine as recorded, and as heard here. */
  mine: number;
  mineHere: number;
  /** To theirs as recorded or saved, and as heard here. */
  partner: number;
  partnerHere: number;
}

/**
 * Shorter speech is too short to tell whose voice it is. Short speech has less reliable
 * voice prints, but is checked all the same: someone else's "OK" is not translated.
 */
const MIN_CHECK_SECONDS = 0.5;
/** How a voice sounds here is learned from something at least this long. */
const MIN_LEARN_SECONDS = 1.5;
/** Long speech is printed from its middle part, which is plenty and keeps the phone quick. */
const MAX_PRINT_SECONDS = 10;
/**
 * How alike two voice prints must be (cosine similarity) to be the same voice. With the
 * phone's speaker model (CAM++), someone else's voice gets there about 1 time in 100;
 * 2 seconds of the same voice in loud chatter fall short about 4 times in 100.
 */
const SAME_VOICE = 0.4;
/**
 * Voice prints less alike than this are of different voices; at least this alike, maybe of
 * the same voice sounding different here. Only speech somewhat like a recording teaches
 * how that voice sounds here, and only speech unlike mine teaches theirs.
 */
const ALIKE = 0.2;
/** A learned voice follows the last few things said in it, as the voice and the place vary. */
const REMEMBERED_PRINTS = 10;

/**
 * Tells the voices of the two people at the phone from everyone else's, by recordings
 * only: mine is recorded in the settings, the other person's for the conversation (see
 * PartnerRecording) or saved from an earlier one. Until theirs is, only mine is let
 * through: no voice is ever taken for theirs from what it says. Each is also learned as
 * the phone hears it here, from what its recording itself tells is that voice.
 */
export class VoiceFilter {
  private readonly printer: VoicePrinter;
  private readonly mine: Float32Array;
  /** My voice as the phone hears it here, which a noisy place or a cold changes. */
  private readonly mineHere = new LearnedVoice();
  /** The other person's voice, as recorded for this conversation or saved from an earlier one. */
  private partnerRecorded: Float32Array | undefined;
  /** Their voice as the phone hears it here, once it is recorded. */
  private readonly partnerHere = new LearnedVoice();

  constructor(printer: VoicePrinter) {
    this.printer = printer;
    this.mine = normalized(printer.mine);
  }

  /** How the other person's voice is known. */
  get partner(): PartnerVoice {
    return this.partnerRecorded ? 'recorded' : 'unknown';
  }

  /** Their voice print, when it was recorded or saved: e.g. to save it for later conversations. */
  get recordedPartner(): Float32Array | undefined {
    return this.partnerRecorded;
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
   * (by its language, or by the "Me" / "Them" choice): speech for me must be in my voice,
   * speech for them in mine or, once it is recorded, theirs. Speech in either voice
   * teaches how it sounds here.
   */
  admits(side: string, print: Float32Array, seconds: number): boolean {
    // So that each is still told when the noise around changes how it sounds; only from
    // what its recording itself tells, so that no one else's voice creeps in.
    const recorded = this.partnerRecorded;
    if (side === SOLO_THEM && this.likePartner(print) >= SAME_VOICE) {
      if (recorded && similarity(print, recorded) >= SAME_VOICE) this.learn(SOLO_THEM, print, seconds);
      return true;
    }
    if (this.isMine(print)) {
      if (similarity(print, this.mine) >= SAME_VOICE) this.learn(SOLO_ME, print, seconds);
      return true;
    }
    return false;
  }

  /**
   * Whether a voice is clearly one of the two, as far as they are known, without learning
   * anything; with a side, one that speaks for it (see `admits`).
   */
  recognizes(print: Float32Array, side?: string): boolean {
    return this.isMine(print) || (side !== SOLO_ME && this.likePartner(print) >= SAME_VOICE);
  }

  /** Whether a voice is clearly mine. */
  isMine(print: Float32Array): boolean {
    return this.likeMine(print) >= SAME_VOICE;
  }

  /**
   * Speech that is that side's, e.g. translated after all: how its voice sounds here is
   * learned from it, if it is still somewhat like that voice's recording. Theirs only once
   * it is recorded, and only from speech unlike mine.
   */
  learn(side: string, print: Float32Array, seconds: number): void {
    if (seconds < MIN_LEARN_SECONDS) return;
    if (side !== SOLO_THEM) {
      if (similarity(print, this.mine) >= ALIKE) this.mineHere.add(print);
      return;
    }
    const recorded = this.partnerRecorded;
    if (recorded && similarity(print, recorded) >= ALIKE && this.likeMine(print) < ALIKE) this.partnerHere.add(print);
  }

  /**
   * Their voice, as recorded for this conversation or saved from an earlier one: it
   * replaces whatever was known of it. False for a voice print from another speaker model.
   */
  setPartner(print: Float32Array): boolean {
    if (print.length !== this.mine.length) return false;
    this.partnerRecorded = normalized(print);
    this.partnerHere.forget();
    return true;
  }

  /**
   * How alike a voice is to each of the two as recorded, and as heard here, without learning
   * anything: for a talk report (see `TalkReportEntry`).
   */
  describe(print: Float32Array): VoiceLikeness {
    const recorded = this.partnerRecorded;
    return {
      mine: similarity(print, this.mine),
      mineHere: this.mineHere.likeness(print),
      partner: recorded ? similarity(print, recorded) : -1,
      partnerHere: this.partnerHere.likeness(print),
    };
  }

  /** How alike a voice is to mine, as recorded or as heard here. */
  private likeMine(print: Float32Array): number {
    return Math.max(similarity(print, this.mine), this.mineHere.likeness(print));
  }

  /** How alike a voice is to theirs, as recorded or as heard here; -1 until it is recorded. */
  private likePartner(print: Float32Array): number {
    const recorded = this.partnerRecorded ? similarity(print, this.partnerRecorded) : -1;
    return Math.max(recorded, this.partnerHere.likeness(print));
  }
}

/** A voice learned from the last few voice prints of what someone said. */
class LearnedVoice {
  /** The sum of the prints, when any. */
  private sum: Float32Array | undefined;
  private count = 0;

  /** How alike a voice is to this one (see `similarity`); -1 while it is unknown. */
  likeness(print: Float32Array): number {
    return this.sum ? similarity(print, normalized(this.sum)) : -1;
  }

  add(print: Float32Array): void {
    if (!this.sum) {
      this.sum = new Float32Array(print);
      this.count = 1;
      return;
    }
    // A running mean at first, then one that slowly forgets the oldest prints.
    const keep = this.count >= REMEMBERED_PRINTS ? (REMEMBERED_PRINTS - 1) / REMEMBERED_PRINTS : 1;
    for (let i = 0; i < print.length; i++) this.sum[i] = this.sum[i]! * keep + print[i]!;
    this.count = Math.min(this.count + 1, REMEMBERED_PRINTS);
  }

  forget(): void {
    this.sum = undefined;
    this.count = 0;
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
 * A recording of someone's voice, for their voice print: keeps the moments clearly louder
 * than the background, which are them talking, and leaves out the pauses.
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

  /** How many chunks were added. */
  get length(): number {
    return this.chunks.length;
  }

  /** Seconds of speech so far. */
  get speechSeconds(): number {
    return this.secondsOfSpeech(0);
  }

  /** Seconds of speech from the `from`th chunk on. */
  secondsOfSpeech(from: number): number {
    return this.speechChunks(from).reduce((total, chunk) => total + chunk.length, 0) / AUDIO_SAMPLE_RATE;
  }

  /** The speech so far, from the `from`th chunk on, without the pauses. */
  speech(from = 0): Int16Array {
    return joined(this.speechChunks(from));
  }

  /** The chunks from the `from`th on that are speech, against the background of the whole recording. */
  private speechChunks(from: number): Int16Array[] {
    const sorted = [...this.levels].sort((a, b) => a - b);
    const noise = sorted[Math.floor(sorted.length * NOISE_PERCENTILE)] ?? 0;
    const threshold = Math.max(QUIETEST_SPEECH_DB, noise + SPEECH_ABOVE_NOISE_DB);
    return this.chunks.filter((_, i) => i >= from && this.levels[i]! >= threshold);
  }
}

/** Seconds of the other person's speech their voice print is made from. */
export const PARTNER_SECONDS = 6;
/** When a recording of their voice gives up, this much of it is still enough. */
const MIN_PARTNER_SECONDS = 3;
/** Their recording is checked this many seconds of speech at a time, to leave out my voice. */
const PART_SECONDS = 2;
/** Seconds of sound after which a recording that heard too little of them gives up. */
const PARTNER_GIVE_UP_SECONDS = 30;
/** Seconds of sound after which a recording that heard little of them says so. */
const PARTNER_HINT_SECONDS = 10;

/** How recording the other person's voice is going. */
export interface RecordingProgress {
  /** Seconds of their voice so far. */
  seconds: number;
  /** Seconds of it needed. */
  of: number;
  /** What is going wrong, if anything. */
  hint?: RecordingProblem;
}

export interface PartnerRecordingEvents {
  /** How the recording is going, whenever that changes. */
  progress(progress: RecordingProgress): void;
  /** It is over: their voice is recorded, unless it `failed`. */
  done(failed: RecordingProblem | undefined): void;
}

/**
 * Records the other person's voice for a conversation, from what the microphone hears
 * next. It is checked a couple of seconds of speech at a time, leaving out what is in my
 * voice, until there is enough of theirs for a reliable voice print, which the VoiceFilter
 * then keeps for the conversation.
 */
export class PartnerRecording {
  private readonly voices: VoiceFilter;
  private readonly events: PartnerRecordingEvents;
  private readonly log: Logger;
  private readonly recording = new VoiceRecording();
  /** Samples of sound heard, pauses included. */
  private heard = 0;
  /** The recording's first chunk in the part still being heard. */
  private partStart = 0;
  /** Seconds of speech in the parts not checked yet. */
  private unchecked = 0;
  /** The parts in their voice. */
  private readonly theirs: Int16Array[] = [];
  private theirSeconds = 0;
  private mineParts = 0;
  private hint: RecordingProblem | undefined;
  /** Parts are checked one at a time, in order. */
  private checks: Promise<void> = Promise.resolve();
  /** Enough was heard: what comes next does not count. */
  private full = false;
  /** Done, or stopped: it reports nothing more. */
  private over = false;
  private reported = '';

  constructor(voices: VoiceFilter, events: PartnerRecordingEvents, log: Logger) {
    this.voices = voices;
    this.events = events;
    this.log = log;
  }

  get progress(): RecordingProgress {
    const speech = this.theirSeconds + this.unchecked + this.recording.secondsOfSpeech(this.partStart);
    const seconds = Math.min(PARTNER_SECONDS, Math.floor(speech));
    const quiet = this.heard >= PARTNER_HINT_SECONDS * AUDIO_SAMPLE_RATE && seconds < PARTNER_SECONDS / 3;
    const hint = this.hint ?? (quiet ? 'quiet' : undefined);
    return hint ? { seconds, of: PARTNER_SECONDS, hint } : { seconds, of: PARTNER_SECONDS };
  }

  /** Some 16 kHz mono PCM16 from the microphone. */
  add(pcm: Uint8Array): void {
    if (this.full || this.over) return;
    const chunk = new Int16Array(pcm.byteLength >> 1);
    new Uint8Array(chunk.buffer).set(pcm.subarray(0, chunk.byteLength));
    // Silence in place of the microphone's sound, while the phone talks.
    if (chunk.every((sample) => sample === 0)) return;
    this.heard += chunk.length;
    this.recording.add(chunk);
    const giveUp = this.heard >= PARTNER_GIVE_UP_SECONDS * AUDIO_SAMPLE_RATE;
    const speech = this.recording.secondsOfSpeech(this.partStart);
    // Giving up, the last of what they said still counts, if it is long enough to tell.
    if (speech >= PART_SECONDS || (giveUp && speech >= MIN_CHECK_SECONDS)) {
      const part = this.recording.speech(this.partStart);
      this.partStart = this.recording.length;
      this.unchecked += part.length / AUDIO_SAMPLE_RATE;
      this.queue(() => this.check(part));
    }
    if (giveUp) {
      this.full = true;
      this.queue(() => this.finish());
    }
    this.report();
  }

  /** Stops recording, leaving what is known of their voice as it was. */
  stop(): void {
    this.over = true;
  }

  private queue(task: () => Promise<void>): void {
    this.checks = this.checks.then(task).catch((error: unknown) => {
      this.log.warn('voice recording', error);
      this.end('quiet');
    });
  }

  /** Keeps a part of the recording, unless it is in my voice. */
  private async check(part: Int16Array): Promise<void> {
    if (this.over) return;
    const print = await this.voices.printOf(part);
    const seconds = part.length / AUDIO_SAMPLE_RATE;
    this.unchecked -= seconds;
    if (this.over) return;
    if (print && this.voices.isMine(print)) {
      this.mineParts += 1;
      this.hint = 'mine';
    } else {
      this.theirs.push(part);
      this.theirSeconds += seconds;
      this.hint = undefined;
    }
    if (this.theirSeconds >= PARTNER_SECONDS) {
      this.full = true;
      await this.finish();
    } else {
      this.report();
    }
  }

  /** Makes their voice print from the parts in their voice, if there is enough of them. */
  private async finish(): Promise<void> {
    if (this.over) return;
    if (this.theirSeconds < MIN_PARTNER_SECONDS) {
      this.end(this.mineParts > this.theirs.length ? 'mine' : 'quiet');
      return;
    }
    const print = await this.voices.printOf(joined(this.theirs));
    if (this.over) return;
    if (!print) {
      this.end('quiet');
    } else if (this.voices.isMine(print)) {
      this.end('mine');
    } else {
      this.voices.setPartner(print);
      this.end(undefined);
    }
  }

  private end(failed: RecordingProblem | undefined): void {
    if (this.over) return;
    this.stop();
    this.events.done(failed);
  }

  private report(): void {
    if (this.over) return;
    const progress = this.progress;
    const key = `${progress.seconds} ${progress.hint ?? ''}`;
    if (key === this.reported) return;
    this.reported = key;
    this.events.progress(progress);
  }
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function joined(chunks: readonly Int16Array[]): Int16Array {
  const all = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}
