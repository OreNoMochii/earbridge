// Kept free of DOM APIs so it can be unit-tested in Node.

export interface SpeechItem {
  /** Id of the utterance this is a translation of. */
  id: string;
  text: string;
  lang: string;
  /** A natural voice reading the text, as base64 audio clips. Without it, the phone's own voice reads. */
  audio?: readonly string[];
}

export interface SpeechQueueOptions {
  /** Speaks one item; resolves when it has finished (or failed). */
  speak(item: SpeechItem): Promise<void>;
  /** How long later translations wait for an earlier, slower one before going ahead. */
  maxWaitMs?: number;
  onSpeakingChange?(speaking: boolean): void;
  now?(): number;
  /** Schedules a callback and returns a function that cancels it. */
  setTimer?(callback: () => void, ms: number): () => void;
}

interface Slot {
  id: string;
  since: number;
  item?: SpeechItem;
  skipped?: boolean;
}

/**
 * Speaks translations one at a time, in the order the utterances were heard, although
 * translations finish out of order. A translation that takes too long stops holding
 * the others back and is spoken whenever it arrives.
 */
export class OrderedSpeechQueue {
  private readonly options: SpeechQueueOptions;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private slots: Slot[] = [];
  private speaking = false;
  private paused = false;
  private reported = false;
  private cancelTimer: (() => void) | undefined;
  private generation = 0;

  constructor(options: SpeechQueueOptions) {
    this.options = options;
    this.maxWaitMs = options.maxWaitMs ?? 8_000;
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      });
  }

  /** An utterance was heard whose translation should be spoken once it is ready. */
  expect(id: string): void {
    if (!this.find(id)) this.slots.push({ id, since: this.now() });
    this.pump();
  }

  /** A translation is complete. */
  ready(item: SpeechItem): void {
    const slot = this.find(item.id);
    if (slot) slot.item = item;
    else this.slots.push({ id: item.id, since: this.now(), item });
    this.pump();
  }

  /** The translation failed or is not needed; stop waiting for it. */
  skip(id: string): void {
    const slot = this.find(id);
    if (slot) slot.skipped = true;
    this.pump();
  }

  /**
   * While paused nothing new starts, e.g. while the user holds the talk button and the
   * phone must not talk over them. Stopping the item already playing is up to the caller.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.pump();
  }

  /** Stop waiting for every translation that has not arrived yet (e.g. the connection dropped). */
  skipPending(): void {
    for (const slot of this.slots) if (!slot.item) slot.skipped = true;
    this.pump();
  }

  /** Forget everything (the caller also stops the speech engine). */
  clear(): void {
    this.generation += 1;
    this.slots = [];
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.speaking = false;
    this.report();
  }

  private find(id: string): Slot | undefined {
    return this.slots.find((slot) => slot.id === id);
  }

  private pump(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    while (!this.speaking && !this.paused && this.slots.length > 0) {
      const head = this.slots[0]!;
      const waited = this.now() - head.since;
      if (head.item) {
        this.slots.shift();
        this.play(head.item);
      } else if (head.skipped || waited >= this.maxWaitMs) {
        this.slots.shift(); // a late translation is queued again by ready()
      } else {
        this.cancelTimer = this.setTimer(() => this.pump(), this.maxWaitMs - waited);
        break;
      }
    }
    this.report();
  }

  private play(item: SpeechItem): void {
    const generation = this.generation;
    this.speaking = true;
    // The executor turns a synchronous throw into a rejection, so the queue never stalls.
    new Promise<void>((resolve) => resolve(this.options.speak(item)))
      .catch(() => {})
      .then(() => {
        if (generation !== this.generation) return;
        this.speaking = false;
        this.pump();
      });
  }

  private report(): void {
    if (this.speaking === this.reported) return;
    this.reported = this.speaking;
    this.options.onSpeakingChange?.(this.speaking);
  }
}
