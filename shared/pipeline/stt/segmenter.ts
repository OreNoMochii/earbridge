import type { SttResult } from './types.ts';

/** What else the recognizer said about some speech. */
export interface SpeechDetails {
  /** How many words it tagged with each language. */
  languages: ReadonlyMap<string, number>;
  /** When the speech started and ended on the stream's clock (seconds), if it reports word timings. */
  start?: number;
  end?: number;
}

export interface SegmenterOutput {
  /** Live caption: everything heard in the current utterance so far, with its likely language. */
  interim(text: string, detectedLanguage: string | undefined, details: SpeechDetails): void;
  /** A complete utterance, with the dominant language the recognizer tagged (if any). */
  utterance(text: string, detectedLanguage: string | undefined, details: SpeechDetails): void;
}

/**
 * Turns a stream of recognizer results into whole utterances worth translating.
 *
 * Final segments are accumulated until the recognizer signals the end of the turn
 * (endpointing, utterance-end, or an explicit finalize). Long monologues are cut at
 * `maxWords` so the listener is never left waiting too long for a translation.
 */
export class UtteranceSegmenter {
  private readonly output: SegmenterOutput;
  private readonly maxWords: number;
  private finals: string[] = [];
  private languageVotes = new Map<string, number>();
  private start: number | undefined;
  private end: number | undefined;

  constructor(output: SegmenterOutput, maxWords = 40) {
    this.output = output;
    this.maxWords = maxWords;
  }

  handleResult(result: SttResult): void {
    const text = result.text.trim();

    if (!result.isFinal) {
      if (text) {
        const details = this.details(result);
        this.output.interim(this.join(text), dominantLanguage(details.languages), details);
      }
      return;
    }

    if (text) {
      this.finals.push(text);
      for (const lang of result.wordLanguages) {
        this.languageVotes.set(lang, (this.languageVotes.get(lang) ?? 0) + 1);
      }
      if (result.start !== undefined) this.start = Math.min(this.start ?? Infinity, result.start);
      if (result.end !== undefined) this.end = Math.max(this.end ?? -Infinity, result.end);
    }

    if (result.speechFinal || result.fromFinalize || this.isTooLong()) {
      this.flush();
    } else if (text) {
      const details = this.details();
      this.output.interim(this.join(), dominantLanguage(details.languages), details);
    }
  }

  handleUtteranceEnd(): void {
    this.flush();
  }

  flush(): void {
    if (this.finals.length === 0) return;
    const text = this.join();
    const details = this.details();
    this.finals = [];
    this.languageVotes = new Map();
    this.start = undefined;
    this.end = undefined;
    this.output.utterance(text, dominantLanguage(details.languages), details);
  }

  private join(pending?: string): string {
    return pending ? [...this.finals, pending].join(' ') : this.finals.join(' ');
  }

  private isTooLong(): boolean {
    const words = this.finals.reduce((n, segment) => n + segment.split(/\s+/).length, 0);
    // Character cap covers languages written without spaces (Chinese, Japanese, Thai).
    const chars = this.finals.reduce((n, segment) => n + segment.length, 0);
    return words >= this.maxWords || chars >= this.maxWords * 6;
  }

  /** What the finals so far say, plus a pending interim result. */
  private details(pending?: SttResult): SpeechDetails {
    const languages = new Map(this.languageVotes);
    for (const lang of pending?.wordLanguages ?? []) languages.set(lang, (languages.get(lang) ?? 0) + 1);
    const start = minimum(this.start, pending?.start);
    const end = maximum(this.end, pending?.end);
    return {
      languages,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
    };
  }
}

function dominantLanguage(votes: ReadonlyMap<string, number>): string | undefined {
  let best: string | undefined;
  let bestVotes = 0;
  for (const [lang, count] of votes) {
    if (count > bestVotes) {
      best = lang;
      bestVotes = count;
    }
  }
  return best;
}

function minimum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

function maximum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}
