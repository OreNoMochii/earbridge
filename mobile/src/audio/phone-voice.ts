// Reads translations aloud with the phone's own text-to-speech voices. A port of the web
// app's client/src/tts.ts.

import * as Speech from 'expo-speech';

import { baseLanguage, languageName } from '../../../shared/languages.ts';
import { splitForSpeech } from '../../../shared/speech-text.ts';
import { pickVoice } from '../../../client/src/speech-text.ts';
import type { VoiceInfo } from '../../../client/src/speech-text.ts';

const CJK = new Set(['zh', 'ja', 'ko']);

interface PhoneVoiceInfo extends VoiceInfo {
  identifier: string;
}

export class PhoneVoice {
  /** Called at most once per problem, e.g. to show a toast. */
  onWarning: ((message: string) => void) | undefined;
  private voices: Promise<PhoneVoiceInfo[]> | undefined;
  // Pieces still being read, with a function that settles them.
  private readonly active = new Set<() => void>();
  private readonly warned = new Set<string>();
  private generation = 0;

  /** Speaks the text; resolves when it has finished, was cancelled, or failed. */
  async speak(text: string, lang: string): Promise<void> {
    const generation = this.generation;
    const voices = await this.loadVoices();
    if (generation !== this.generation) return;
    const voice = pickVoice(voices, lang);
    if (!voice && voices.length > 0) {
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
      await this.speakPiece(piece, voice?.lang ?? lang, voice?.identifier, cjk ? 450 : 150);
    }
  }

  /** Stops speaking now and drops whatever speak() calls were still going. */
  cancel(): void {
    this.generation += 1;
    const speaking = this.active.size > 0;
    for (const settle of [...this.active]) settle();
    if (speaking) void Speech.stop().catch(() => {});
  }

  private speakPiece(text: string, lang: string, voice: string | undefined, msPerCharacter: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (!this.active.delete(settle)) return;
        clearTimeout(timer);
        resolve();
      };
      this.active.add(settle);
      // Some engines never report the end (e.g. after an audio interruption); do not wait
      // forever or every later translation would be stuck behind this one.
      timer = setTimeout(
        () => {
          if (!this.active.has(settle)) return;
          void Speech.stop().catch(() => {});
          settle();
        },
        Math.min(60_000, 2_000 + text.length * msPerCharacter),
      );
      Speech.speak(text, {
        language: lang,
        voice,
        // iPhone: speak within the conversation's audio session, so it goes to the earphones.
        useApplicationAudioSession: true,
        onDone: settle,
        onStopped: settle,
        onError: settle,
      });
    });
  }

  private loadVoices(): Promise<PhoneVoiceInfo[]> {
    this.voices ??= Speech.getAvailableVoicesAsync().then(
      (voices) => {
        const list = voices.map((voice) => ({
          identifier: voice.identifier,
          name: voice.quality === Speech.VoiceQuality.Enhanced ? `${voice.name} (enhanced)` : voice.name,
          lang: voice.language,
          // Android's network voices need a connection; they are named like "en-us-x-tpd-network".
          localService: !/network/i.test(voice.identifier),
          default: false,
        }));
        // The list can be empty while the speech engine is still starting; ask again next time.
        if (list.length === 0) this.voices = undefined;
        return list;
      },
      () => {
        this.voices = undefined;
        return [];
      },
    );
    return this.voices;
  }

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onWarning?.(message);
  }
}
