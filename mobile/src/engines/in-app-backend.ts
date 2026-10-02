// A one-phone conversation run by the app itself, without a computer: the same
// SoloConversation the server runs, with engines the phone reaches on its own. It
// answers in the server's messages, so the rest of the app cannot tell the difference.

import { consoleLogger } from '../../../shared/pipeline/log.ts';
import { SoloConversation } from '../../../shared/pipeline/solo.ts';
import type { SttProvider } from '../../../shared/pipeline/stt/types.ts';
import type { Translator } from '../../../shared/pipeline/translate/types.ts';
import type { SpeechSynthesizer } from '../../../shared/pipeline/voice/types.ts';
import type { VoicePrinter } from '../../../shared/pipeline/voices.ts';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';
import type { Backend, BackendEvents } from './backend.ts';

export interface Pipeline {
  stt: SttProvider;
  translator: Translator;
  synthesizer: SpeechSynthesizer | undefined;
  /** The languages `synthesizer` reads aloud. */
  voiceLangs: readonly string[];
  /** Whether `stt` can tell the two languages apart. Defaults to whether Deepgram can. */
  autoDetect?: boolean;
  /** Whether `stt` says when each word was said, which the noise filters need. Defaults to true. */
  wordTimings?: boolean;
  /** Translate only the voices of the two people at the phone. */
  voices?: VoicePrinter | undefined;
  /** Called once the conversation is over. */
  dispose?(): void;
}

export interface InAppOptions extends BackendEvents {
  myLang: string;
  theirLang: string;
  /** Skip speech much quieter than the two people at the phone. */
  nearbyOnly: boolean;
  /**
   * Gets the engines ready, e.g. downloads what is missing, reporting what it is doing.
   * Rejects with an error whose message can be shown.
   */
  prepare(signal: AbortSignal, progress: (text: string) => void): Promise<Pipeline>;
}

export class InAppBackend implements Backend {
  private readonly options: InAppOptions;
  private readonly preparing = new AbortController();
  private pipeline: Pipeline | undefined;
  private solo: SoloConversation | undefined;
  private lastId = 0;
  private stopped = false;

  constructor(options: InAppOptions) {
    this.options = options;
  }

  start(): void {
    void this.run();
  }

  send(message: ClientMessage): void {
    const solo = this.solo;
    if (!solo) return;
    if (message.type === 'speaker') {
      if (!solo.setSpeaker(message.speaker)) {
        this.emit({ type: 'error', message: 'Automatic speaker detection is not available for this language pair.', fatal: false });
      }
    } else if (message.type === 'flush') {
      solo.flush();
    } else if (message.type === 'accept') {
      solo.accept(message.id);
    }
  }

  sendAudio(pcm: ArrayBuffer): void {
    this.solo?.sendAudio(new Uint8Array(pcm));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.preparing.abort();
    this.solo?.close();
    this.solo = undefined;
    this.pipeline?.dispose?.();
    this.pipeline = undefined;
  }

  private async run(): Promise<void> {
    const { options } = this;
    let pipeline: Pipeline;
    try {
      pipeline = await options.prepare(this.preparing.signal, (text) => {
        if (!this.stopped) options.onProgress?.(text);
      });
    } catch (error) {
      this.end(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.stopped) {
      pipeline.dispose?.();
      return;
    }
    this.pipeline = pipeline;
    options.onProgress?.(undefined);

    const solo = new SoloConversation({
      myLang: options.myLang,
      theirLang: options.theirLang,
      voiceLangs: pipeline.voiceLangs,
      stt: pipeline.stt,
      translator: pipeline.translator,
      synthesizer: pipeline.synthesizer,
      send: (message) => this.emit(message),
      onFatal: (error) => this.end(error.message),
      log: consoleLogger,
      newId: () => `u${++this.lastId}`,
      nearbyOnly: options.nearbyOnly && pipeline.wordTimings !== false,
      ...(pipeline.autoDetect === undefined ? {} : { autoDetect: pipeline.autoDetect }),
      ...(pipeline.voices && pipeline.wordTimings !== false ? { voices: pipeline.voices } : {}),
    });
    this.solo = solo;
    this.emit({
      type: 'ready',
      clientId: 'phone',
      mode: 'solo',
      autoDetect: solo.autoDetect,
      speaker: solo.speaker,
      voiceLangs: [...pipeline.voiceLangs],
    });
    options.onStateChange('ready');
    solo.start();
  }

  private emit(message: ServerMessage): void {
    if (!this.stopped) this.options.onMessage(message);
  }

  private end(message: string): void {
    if (this.stopped) return;
    this.stop();
    this.options.onEnded({ message });
  }
}
