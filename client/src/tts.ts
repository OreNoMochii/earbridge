// Reads translations aloud with the phone's built-in voices (Web Speech API). Audio goes
// wherever the phone sends it: the connected earphones, or else the speaker.

import { baseLanguage, languageName } from '../../shared/languages.ts';
import { pickVoice, splitForSpeech } from './speech-text.ts';

const CJK = new Set(['zh', 'ja', 'ko']);

export class SpeechOutput {
  /** Called at most once per problem, e.g. to show a toast. */
  onWarning: ((message: string) => void) | undefined;
  private readonly synth: SpeechSynthesis | undefined;
  private voices: SpeechSynthesisVoice[] = [];
  // Utterances still playing, with a function that settles them. Holding a reference
  // also keeps them from being garbage-collected, which on Chrome loses their end event.
  private readonly active = new Map<SpeechSynthesisUtterance, () => void>();
  private readonly warned = new Set<string>();
  private generation = 0;

  constructor() {
    this.synth = typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis;
    if (!this.synth) return;
    this.loadVoices();
    // Chrome loads its voice list asynchronously.
    this.synth.addEventListener?.('voiceschanged', () => this.loadVoices());
  }

  /**
   * Call during a tap: iOS only lets a page speak after speech was started by a user
   * gesture, so this starts a silent one.
   */
  unlock(): void {
    if (!this.synth) return;
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    this.synth.speak(utterance);
  }

  /** Speaks the text; resolves when it has finished, was cancelled, or failed. */
  async speak(text: string, lang: string): Promise<void> {
    const synth = this.synth;
    if (!synth) {
      this.warn('no-speech', 'This browser cannot speak, so translations are shown as text only.');
      return;
    }
    const generation = this.generation;
    const voice = pickVoice(this.voices, lang);
    if (!voice && this.voices.length > 0) {
      this.warn(
        `voice:${baseLanguage(lang)}`,
        `No ${languageName(lang)} voice is installed on this device, so it may sound wrong. ` +
          'You can add voices in the phone’s text-to-speech settings.',
      );
    }
    const cjk = CJK.has(baseLanguage(lang));
    // Characters carry more per sound in Chinese, Japanese and Korean.
    for (const piece of splitForSpeech(text, cjk ? 60 : 200)) {
      if (generation !== this.generation) return;
      await this.speakPiece(synth, piece, lang, voice, cjk ? 450 : 150);
    }
  }

  /** Stops speaking now and drops whatever speak() calls were still going. */
  cancel(): void {
    this.generation += 1;
    for (const settle of [...this.active.values()]) settle();
    this.synth?.cancel();
  }

  private speakPiece(
    synth: SpeechSynthesis,
    text: string,
    lang: string,
    voice: SpeechSynthesisVoice | undefined,
    msPerCharacter: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = voice?.lang ?? lang;
      if (voice) utterance.voice = voice;

      let timer: number | undefined;
      const settle = () => {
        window.clearTimeout(timer);
        this.active.delete(utterance);
        resolve();
      };
      utterance.onend = settle;
      utterance.onerror = settle;
      this.active.set(utterance, settle);

      // Some engines never report the end (e.g. after an audio interruption); do not wait
      // forever or every later translation would be stuck behind this one.
      const allowanceMs = Math.min(60_000, 2_000 + text.length * msPerCharacter);
      timer = window.setTimeout(() => {
        if (!this.active.has(utterance)) return;
        synth.cancel();
        settle();
      }, allowanceMs);

      if (synth.paused) synth.resume();
      synth.speak(utterance);
    });
  }

  private loadVoices(): void {
    this.voices = this.synth?.getVoices() ?? [];
  }

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onWarning?.(message);
  }
}
