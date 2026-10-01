import { randomUUID } from 'node:crypto';
import { baseLanguage, canAutoDetect } from '../../shared/languages.ts';
import { SOLO_ME, SOLO_THEM } from '../../shared/protocol.ts';
import type { ServerMessage, SpeakerSelection } from '../../shared/protocol.ts';
import { ConversationHistory } from './history.ts';
import type { Logger } from './log.ts';
import { UtteranceSegmenter } from './stt/segmenter.ts';
import type { SttProvider, SttStream } from './stt/types.ts';
import { deliverTranslation } from './translate/deliver.ts';
import type { TranslationRequest, Translator } from './translate/types.ts';
import { deliverSpeech } from './voice/deliver.ts';
import type { SpeechSynthesizer } from './voice/types.ts';

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
}

type SoloSpeaker = typeof SOLO_ME | typeof SOLO_THEM;

/**
 * One phone shared by two people. A single recognizer stream listens at a time: in
 * "auto" it recognizes both languages and attributes each utterance by the language it
 * detected; otherwise it expects one side's language and attributes everything to them.
 */
export class SoloConversation {
  readonly autoDetect: boolean;
  private readonly options: SoloOptions;
  private readonly history = new ConversationHistory();
  private readonly translations = new AbortController();
  private selection: SpeakerSelection;
  private stream: SttStream | undefined;
  private generation = 0;
  private closed = false;

  constructor(options: SoloOptions) {
    this.options = options;
    this.autoDetect = canAutoDetect(options.myLang, options.theirLang);
    this.selection = this.autoDetect ? 'auto' : SOLO_THEM;
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
    // The previous stream finishes gracefully: whatever it already heard is still
    // transcribed and attributed to the previous selection.
    this.stream?.close();
    this.listen();
    return true;
  }

  sendAudio(chunk: Buffer): void {
    this.stream?.sendAudio(chunk);
  }

  /** The current turn is over: transcribe and translate what was heard so far. */
  flush(): void {
    this.stream?.finalize();
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

    const segmenter = new UtteranceSegmenter({
      interim: (text, detected) => this.interim(selection, text, detected),
      utterance: (text, detected) => this.utterance(selection, text, detected),
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

  private attribute(selection: SpeakerSelection, detected: string | undefined): SoloSpeaker {
    if (selection !== 'auto') return selection;
    return detected === baseLanguage(this.options.myLang) ? SOLO_ME : SOLO_THEM;
  }

  private langOf(speaker: SoloSpeaker): string {
    return speaker === SOLO_ME ? this.options.myLang : this.options.theirLang;
  }

  private interim(selection: SpeakerSelection, text: string, detected: string | undefined): void {
    if (this.closed) return;
    const speakerId = this.attribute(selection, detected);
    this.options.send({ type: 'interim', speakerId, lang: this.langOf(speakerId), text });
  }

  private utterance(selection: SpeakerSelection, text: string, detected: string | undefined): void {
    if (this.closed) return;
    const speakerId = this.attribute(selection, detected);
    const listenerId = speakerId === SOLO_ME ? SOLO_THEM : SOLO_ME;
    const sourceLang = this.langOf(speakerId);
    const targetLang = this.langOf(listenerId);
    const id = randomUUID();

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
