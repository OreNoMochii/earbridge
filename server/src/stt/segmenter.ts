import type { SttResult } from './types.ts';

export interface SegmenterOutput {
  /** Live caption: everything heard in the current utterance so far, with its likely language. */
  interim(text: string, detectedLanguage: string | undefined): void;
  /** A complete utterance, with the dominant language the recognizer tagged (if any). */
  utterance(text: string, detectedLanguage: string | undefined): void;
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

  constructor(output: SegmenterOutput, maxWords = 40) {
    this.output = output;
    this.maxWords = maxWords;
  }

  handleResult(result: SttResult): void {
    const text = result.text.trim();

    if (!result.isFinal) {
      if (text) this.output.interim(this.join(text), this.dominantLanguage(result.wordLanguages));
      return;
    }

    if (text) {
      this.finals.push(text);
      for (const lang of result.wordLanguages) {
        this.languageVotes.set(lang, (this.languageVotes.get(lang) ?? 0) + 1);
      }
    }

    if (result.speechFinal || result.fromFinalize || this.isTooLong()) {
      this.flush();
    } else if (text) {
      this.output.interim(this.join(), this.dominantLanguage());
    }
  }

  handleUtteranceEnd(): void {
    this.flush();
  }

  flush(): void {
    if (this.finals.length === 0) return;
    const text = this.join();
    const language = this.dominantLanguage();
    this.finals = [];
    this.languageVotes = new Map();
    this.output.utterance(text, language);
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

  private dominantLanguage(pending: readonly string[] = []): string | undefined {
    const tally = new Map(this.languageVotes);
    for (const lang of pending) tally.set(lang, (tally.get(lang) ?? 0) + 1);
    let best: string | undefined;
    let bestVotes = 0;
    for (const [lang, votes] of tally) {
      if (votes > bestVotes) {
        best = lang;
        bestVotes = votes;
      }
    }
    return best;
  }
}
