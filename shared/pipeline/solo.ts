import { canAutoDetect } from '../languages.ts';
import { AUDIO_SAMPLE_RATE, SKIPPED_KEPT, SOLO_ME, SOLO_THEM } from '../protocol.ts';
import type { ServerMessage, SkipReason, SpeakerSelection } from '../protocol.ts';
import { ConversationHistory } from './history.ts';
import { judgeLanguages } from './language-filter.ts';
import type { Logger } from './log.ts';
import { AudioHistory, LoudnessGate, speechLevel } from './loudness.ts';
import { UtteranceSegmenter } from './stt/segmenter.ts';
import type { SpeechDetails } from './stt/segmenter.ts';
import type { SttProvider, SttStream } from './stt/types.ts';
import { deliverTranslation } from './translate/deliver.ts';
import type { TranslationRequest, Translator } from './translate/types.ts';
import { deliverSpeech } from './voice/deliver.ts';
import type { SpeechSynthesizer } from './voice/types.ts';
import { VoiceFilter } from './voices.ts';
import type { VoicePrinter } from './voices.ts';

export interface SoloOptions {
  myLang: string;
  theirLang: string;
  /** Translations into these languages are also read aloud by `synthesizer`. */
  voiceLangs: readonly string[];
  stt: SttProvider;
  translator: Translator;
  synthesizer: SpeechSynthesizer | undefined;
  send(message: ServerMessage): void;
  /** Speech recognition failed for good; the conversation cannot continue. */
  onFatal(error: Error): void;
  log: Logger;
  /** A unique id for each utterance. */
  newId(): string;
  /**
   * Whether `stt` can tell the two languages apart, so the speaker can be "auto".
   * Defaults to whether Deepgram can for this language pair.
   */
  autoDetect?: boolean;
  /**
   * Skip speech much quieter than the two people at the phone usually sound: others
   * further away, or a radio. Needs a recognizer that reports word timings.
   */
  nearbyOnly?: boolean;
  /** Skip speech in any voice but the two people's. Needs word timings too. */
  voices?: VoicePrinter;
}

type SoloSpeaker = typeof SOLO_ME | typeof SOLO_THEM;

/** Something heard but not translated, kept a while in case the phone wants it after all. */
interface Skipped {
  speakerId: SoloSpeaker;
  /** The language it seemed to be in. */
  lang: string;
  text: string;
  reason: SkipReason;
  level: number | undefined;
  print: Float32Array | undefined;
}

/** Seconds of audio around the recognized words that count as theirs. */
const PADDING = 0.1;

/**
 * One phone shared by two people. A single recognizer stream listens at a time: in
 * "auto" it recognizes both languages and attributes each utterance by the language it
 * detected; otherwise it expects one side's language and attributes everything to them.
 * Speech in another language, and optionally from further away or in other voices, is
 * skipped rather than translated.
 */
export class SoloConversation {
  readonly autoDetect: boolean;
  private readonly options: SoloOptions;
  private readonly history = new ConversationHistory();
  private readonly translations = new AbortController();
  /** The last half minute of audio, when a filter needs to look back at what was said. */
  private readonly audio: AudioHistory | undefined;
  private readonly loudness: LoudnessGate | undefined;
  private readonly voices: VoiceFilter | undefined;
  private readonly skipped = new Map<string, Skipped>();
  /** Voice checks take a moment; utterances wait for the ones before them, to stay in order. */
  private checks: Promise<void> = Promise.resolve();
  private showingInterim = false;
  private selection: SpeakerSelection;
  private stream: SttStream | undefined;
  private generation = 0;
  private closed = false;

  constructor(options: SoloOptions) {
    this.options = options;
    this.autoDetect = options.autoDetect ?? canAutoDetect(options.myLang, options.theirLang);
    this.selection = this.autoDetect ? 'auto' : SOLO_THEM;
    this.loudness = options.nearbyOnly ? new LoudnessGate() : undefined;
    this.voices = options.voices ? new VoiceFilter(options.voices) : undefined;
    this.audio = this.loudness || this.voices ? new AudioHistory() : undefined;
  }

  get speaker(): SpeakerSelection {
    return this.selection;
  }

  start(): void {
    this.listen();
  }

  /** Returns false if the selection is not available for this language pair. */
  setSpeaker(selection: SpeakerSelection): boolean {
    if (selection === 'auto' && !this.autoDetect) return false;
    if (this.closed || selection === this.selection) return true;
    this.selection = selection;
    // "Them" says the other person is about to talk: their voice is learned afresh.
    if (selection === SOLO_THEM) this.voices?.forgetPartner();
    // The previous stream finishes gracefully: whatever it already heard is still
    // transcribed and attributed to the previous selection.
    this.stream?.close();
    this.listen();
    return true;
  }

  sendAudio(chunk: Uint8Array): void {
    this.audio?.append(chunk);
    this.stream?.sendAudio(chunk);
  }

  /** The current turn is over: transcribe and translate what was heard so far. */
  flush(): void {
    this.stream?.finalize();
  }

  /** Translates something that was skipped after all, and learns from the mistake. */
  accept(id: string): void {
    const skipped = this.skipped.get(id);
    if (!skipped || this.closed) return;
    this.skipped.delete(id);
    if (skipped.level !== undefined) {
      const now = this.audio!.now;
      if (skipped.reason === 'distant') this.loudness?.allow(skipped.speakerId, skipped.level, now);
      else this.loudness?.learn(skipped.speakerId, skipped.level, now);
    }
    // Their voice was not the one learned: someone else is talking with the phone now.
    // (Mine is never learned from a mistake; it comes from the recording in the settings.)
    if (skipped.reason === 'voice' && skipped.speakerId === SOLO_THEM && skipped.print) {
      this.voices?.learnPartner(skipped.print);
    }
    this.deliver(id, skipped.speakerId, skipped.text, skipped.lang);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.translations.abort();
    this.stream?.close();
    this.stream = undefined;
  }

  private listen(): void {
    const selection = this.selection;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation && !this.closed;
    const language = selection === 'auto' ? 'multi' : this.langOf(selection);
    // The recognizer times words from the stream's first audio, which is this far into the conversation's.
    const origin = this.audio?.now ?? 0;

    const segmenter = new UtteranceSegmenter({
      interim: (text, _detected, details) => this.interim(selection, text, details, origin),
      utterance: (text, detected, details) => this.utterance(selection, text, detected, details, origin),
    });

    this.stream = this.options.stt.open(
      { language },
      {
        onResult: (result) => segmenter.handleResult(result),
        onUtteranceEnd: () => segmenter.handleUtteranceEnd(),
        onStatus: (status) => {
          if (isCurrent()) this.options.send({ type: 'status', stt: status });
        },
        onError: (error, fatal) => {
          if (fatal && isCurrent()) this.options.onFatal(error);
          else this.options.log.warn(`speech recognition (${language})`, error);
        },
        onClosed: () => segmenter.flush(),
      },
    );
  }

  /** Who said it: the selected side, or in "auto" whoever speaks its language. */
  private attribute(selection: SpeakerSelection, details: SpeechDetails): SoloSpeaker | 'other' {
    if (selection !== 'auto') return selection;
    return judgeLanguages(details.languages, this.options.myLang, this.options.theirLang);
  }

  private langOf(speaker: SoloSpeaker): string {
    return speaker === SOLO_ME ? this.options.myLang : this.options.theirLang;
  }

  /** The audio of some speech, when the recognizer said when it was. */
  private audioOf(details: SpeechDetails, origin: number): Int16Array | undefined {
    if (!this.audio || details.start === undefined || details.end === undefined) return undefined;
    return this.audio.slice(origin + details.start - PADDING, origin + details.end + PADDING);
  }

  private tooQuiet(speakerId: SoloSpeaker, level: number | undefined): boolean {
    return level !== undefined && !!this.loudness && !this.loudness.accepts(speakerId, level, this.audio!.now);
  }

  private interim(selection: SpeakerSelection, text: string, details: SpeechDetails, origin: number): void {
    if (this.closed) return;
    const verdict = this.attribute(selection, details);
    const speakerId = verdict === 'other' ? SOLO_THEM : verdict;
    const samples = this.loudness ? this.audioOf(details, origin) : undefined;
    const hidden = verdict === 'other' || this.tooQuiet(speakerId, samples && speechLevel(samples));
    this.showInterim(speakerId, hidden ? '' : text);
  }

  /** Shows what is being said, or with no text, stops showing it. */
  private showInterim(speakerId: SoloSpeaker, text: string): void {
    if (!text && !this.showingInterim) return;
    this.showingInterim = text !== '';
    this.options.send({ type: 'interim', speakerId, lang: this.langOf(speakerId), text });
  }

  private utterance(
    selection: SpeakerSelection,
    text: string,
    detected: string | undefined,
    details: SpeechDetails,
    origin: number,
  ): void {
    if (this.closed) return;
    const id = this.options.newId();
    const samples = this.audioOf(details, origin);
    const check = () => this.check(id, selection, text, detected, details, samples);
    if (!this.voices) {
      void check();
      return;
    }
    this.checks = this.checks.then(check).catch((error: unknown) => this.options.log.warn('voice check', error));
  }

  /** Translates an utterance, unless it seems to come from someone else. */
  private async check(
    id: string,
    selection: SpeakerSelection,
    text: string,
    detected: string | undefined,
    details: SpeechDetails,
    samples: Int16Array | undefined,
  ): Promise<void> {
    if (this.closed) return;
    const verdict = this.attribute(selection, details);
    if (verdict === 'other') {
      const lang = detected ?? this.options.theirLang;
      this.skip(id, { speakerId: SOLO_THEM, lang, text, reason: 'language', level: undefined, print: undefined });
      return;
    }
    const speakerId = verdict;
    const lang = this.langOf(speakerId);
    const level = samples && speechLevel(samples);
    const now = this.audio?.now ?? 0;
    if (this.tooQuiet(speakerId, level)) {
      this.skip(id, { speakerId, lang, text, reason: 'distant', level, print: undefined });
      return;
    }
    if (this.voices && samples) {
      const print = await this.voices.printOf(samples);
      if (this.closed) return;
      if (print && !this.voices.admits(speakerId, print, samples.length / AUDIO_SAMPLE_RATE)) {
        this.skip(id, { speakerId, lang, text, reason: 'voice', level, print });
        return;
      }
    }
    if (level !== undefined) this.loudness?.learn(speakerId, level, now);
    this.deliver(id, speakerId, text);
  }

  private skip(id: string, skipped: Skipped): void {
    this.skipped.set(id, skipped);
    if (this.skipped.size > SKIPPED_KEPT) this.skipped.delete(this.skipped.keys().next().value!);
    // Phones that do not know "skipped" still stop showing the live caption.
    this.showInterim(skipped.speakerId, '');
    const { speakerId, lang, text, reason } = skipped;
    this.options.send({ type: 'skipped', id, speakerId, lang, text, reason });
  }

  private deliver(id: string, speakerId: SoloSpeaker, text: string, sourceLang = this.langOf(speakerId)): void {
    if (this.closed) return;
    const listenerId = speakerId === SOLO_ME ? SOLO_THEM : SOLO_ME;
    const targetLang = this.langOf(listenerId);

    this.showingInterim = false; // the phone stops showing it when the utterance arrives
    this.options.send({
      type: 'utterance',
      id,
      speakerId,
      speakerName: speakerId === SOLO_ME ? 'You' : 'Them',
      lang: sourceLang,
      text,
    });

    const context = this.history.recent();
    this.history.add({ speaker: speakerId === SOLO_ME ? 'Person A' : 'Person B', lang: sourceLang, text });

    void this.translate(id, { text, sourceLang, targetLang, context });
  }

  /** Translates an utterance, then has a natural voice read the translation if wanted. */
  private async translate(id: string, request: Omit<TranslationRequest, 'onPartial' | 'signal'>): Promise<void> {
    const { translator, synthesizer, voiceLangs, log } = this.options;
    const signal = this.translations.signal;
    const send = (message: ServerMessage) => {
      if (!this.closed) this.options.send(message);
    };
    const translation = await deliverTranslation(translator, { ...request, signal }, id, send, log);
    if (translation && synthesizer && voiceLangs.includes(request.targetLang)) {
      await deliverSpeech(synthesizer, { text: translation, lang: request.targetLang, signal }, id, send, log);
    }
  }
}
