// A gate in front of a speech recognizer that is paid by the second of audio: it lets
// through what sounds like one of the two people at the phone, and keeps back silence and
// everyone else, who would be recognized for nothing (and skipped afterwards anyway).

import { AUDIO_SAMPLE_RATE } from '../protocol.ts';

/**
 * Whose voice a piece of sound is in: one of the two people's ('ours'), nobody's ('quiet'),
 * someone else's ('other'), or not to be told yet ('maybe'), e.g. while a voice is not known.
 */
export type GateVerdict = 'quiet' | 'other' | 'ours' | 'maybe';

export interface GateWindow {
  /** On the conversation's clock. */
  start: number;
  end: number;
}

export interface SpeechGateOptions {
  /** Whose voice the sound between two times is in. One judgement at a time. */
  judge(window: GateWindow): Promise<GateVerdict>;
  /** Sends a chunk on to the recognizer; `at` is when it started on the conversation's clock. */
  send(chunk: Uint8Array, at: number): void;
  /** Told of each piece judged, and whether sound goes through after it. */
  judged?(window: GateWindow, verdict: GateVerdict, open: boolean): void;
}

/** A piece of sound is judged once there is this much of it, then every HOP seconds. */
export const GATE_WINDOW_SECONDS = 1.5;
export const GATE_HOP_SECONDS = 0.5;
/**
 * The gate opens on a piece in one of our voices: the sound from a little before that
 * piece on is sent too, so that the start of a line is not cut off.
 */
const PRE_ROLL_SECONDS = 0.3;
/** Sound kept back while the gate is closed is kept this long; older sound is dropped. */
const MAX_PENDING_SECONDS = 4;
/** The gate closes after this many pieces in a row in nobody's voice or someone else's. */
const CLOSE_AFTER = 3;
const BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * 2;
/** Pieces end on sample boundaries; this much is nothing. */
const EPSILON = 1e-6;

interface Pending {
  chunk: Uint8Array;
  /** When it started and ended on the conversation's clock. */
  start: number;
  end: number;
}

/**
 * Sound goes through the gate as it is heard while the gate is open; closed, the gate keeps
 * the latest few seconds back. Every half second, the latest piece of sound is judged (see
 * `judge`): one in one of the two voices, or that may be, opens the gate, and what was kept
 * back from a little before it on goes through; a few pieces in a row of silence, or of
 * someone else, close it. A turn ending (`flush`) sends on what was not judged yet, so that
 * no short line is lost, and the next turn starts with the gate closed.
 */
export class SpeechGate {
  private readonly options: SpeechGateOptions;
  private open = false;
  private pending: Pending[] = [];
  private pendingSeconds = 0;
  /** Where the sound heard so far ends on the conversation's clock. */
  private heardUntil = 0;
  private heardSeconds = 0;
  private sentSeconds = 0;
  /** Where the sound judged so far ends, and where the turn being heard started. */
  private judgedUntil = 0;
  private turnStart = 0;
  /** Pieces in a row that were not one of the two voices, while open. */
  private misses = 0;
  private judging: Promise<void> | undefined;
  /** A turn that ended while a piece was being judged, waiting for the verdict; sound heard meanwhile is the next turn's. */
  private flushing: { promise: Promise<void>; resolve: () => void; heard: Array<{ chunk: Uint8Array; at: number }> } | undefined;
  private closed = false;

  constructor(options: SpeechGateOptions) {
    this.options = options;
  }

  /** Seconds of sound heard, and of it sent on. */
  get stats(): { heard: number; sent: number } {
    return { heard: this.heardSeconds, sent: this.sentSeconds };
  }

  /** Some sound from the microphone, starting at `at` on the conversation's clock. */
  hear(chunk: Uint8Array, at: number): void {
    if (this.closed) return;
    if (this.flushing) {
      this.flushing.heard.push({ chunk, at });
      return;
    }
    const seconds = chunk.byteLength / BYTES_PER_SECOND;
    const end = at + seconds;
    this.heardUntil = end;
    this.heardSeconds += seconds;
    if (this.open) {
      this.sendOn(chunk, at);
    } else {
      this.pending.push({ chunk, start: at, end });
      this.pendingSeconds += seconds;
      while (this.pendingSeconds > MAX_PENDING_SECONDS && this.pending.length > 1) {
        this.pendingSeconds -= this.pending.shift()!.chunk.byteLength / BYTES_PER_SECOND;
      }
    }
    this.judgeIfDue();
  }

  /**
   * The turn is over (a button let go, or a pause): what was heard but not judged yet goes
   * through, in case it is the end of a line, and the rest kept back is dropped. Resolves
   * once all of the turn's sound that goes through has been sent, which waits for the
   * verdict on a piece still being judged. The next turn starts with the gate closed.
   */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing.promise;
    if (!this.judging) {
      this.endTurn();
      return Promise.resolve();
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.flushing = { promise, resolve, heard: [] };
    return promise;
  }

  /** The conversation is over: nothing more goes through. */
  close(): void {
    this.closed = true;
    this.pending = [];
    this.pendingSeconds = 0;
    this.flushing?.resolve();
    this.flushing = undefined;
  }

  private sendOn(chunk: Uint8Array, at: number): void {
    this.sentSeconds += chunk.byteLength / BYTES_PER_SECOND;
    this.options.send(chunk, at);
  }

  private endTurn(): void {
    if (!this.open) {
      for (const piece of this.pending) {
        if (piece.end > this.judgedUntil + EPSILON) this.sendOn(piece.chunk, piece.start);
      }
    }
    this.pending = [];
    this.pendingSeconds = 0;
    this.open = false;
    this.misses = 0;
    this.turnStart = this.heardUntil;
    this.judgedUntil = this.heardUntil;
  }

  /** Judges the latest piece once there is a new one, one judgement at a time. */
  private judgeIfDue(): void {
    if (this.judging || this.closed) return;
    const end = this.heardUntil;
    const start = end - GATE_WINDOW_SECONDS;
    if (start < this.turnStart - EPSILON || end < this.judgedUntil + GATE_HOP_SECONDS - EPSILON) return;
    this.judgedUntil = end;
    const window = { start, end };
    this.judging = this.options
      .judge(window)
      .then((verdict) => this.apply(window, verdict))
      .catch(() => this.apply(window, 'maybe'))
      .finally(() => {
        this.judging = undefined;
        const flushing = this.flushing;
        if (!flushing) {
          this.judgeIfDue();
          return;
        }
        this.flushing = undefined;
        this.endTurn();
        flushing.resolve();
        for (const { chunk, at } of flushing.heard) this.hear(chunk, at);
      });
  }

  private apply(window: GateWindow, verdict: GateVerdict): void {
    if (this.closed) return;
    const ours = verdict === 'ours' || verdict === 'maybe';
    if (ours) {
      this.misses = 0;
      if (!this.open) this.release(window.start - PRE_ROLL_SECONDS);
    } else if (this.open && ++this.misses >= CLOSE_AFTER) {
      this.open = false;
      this.misses = 0;
    }
    this.options.judged?.(window, verdict, this.open);
  }

  /** Opens the gate, sending on what was kept back from `from` on. */
  private release(from: number): void {
    this.open = true;
    for (const piece of this.pending) {
      if (piece.end > from + EPSILON) this.sendOn(piece.chunk, piece.start);
    }
    this.pending = [];
    this.pendingSeconds = 0;
  }
}
