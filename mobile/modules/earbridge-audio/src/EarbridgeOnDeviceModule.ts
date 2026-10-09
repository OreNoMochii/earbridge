import { type NativeModule, requireOptionalNativeModule } from 'expo';

/** What the recognizer reports for a session. "end" always comes last, after a fatal error too. */
export type RecognitionEvent =
  | { session: number; type: 'ready' }
  /**
   * What it is hearing so far in the current sentence, or the sentence once it is done.
   * `start` and `end`: when its words were said, in seconds since the session's first
   * audio (Android 14 and newer, from recognizers that report word timings).
   */
  | { session: number; type: 'partial' | 'segment'; text: string; start?: number; end?: number }
  /** An Android SpeechRecognizer error code. */
  | { session: number; type: 'error'; code: number; fatal: boolean }
  | { session: number; type: 'end' };

/** Recognizer locales such as "en-US" or "cmn-Hans-CN". */
export type RecognitionLanguages = {
  installed: string[];
  /** Scheduled to download. */
  pending: string[];
  /** Can be downloaded. */
  supported: string[];
};

export type EarbridgeOnDeviceEvents = {
  onRecognition: (event: RecognitionEvent) => void;
  onDownloadProgress: (event: { language: string; percent: number }) => void;
};

declare class EarbridgeOnDeviceModule extends NativeModule<EarbridgeOnDeviceEvents> {
  /** Android 13 or newer with an on-device speech recognizer. */
  isAvailable(): boolean;
  recognitionLanguages(): Promise<RecognitionLanguages>;
  /** "scheduled" or "requested": Android downloads it in its own time. */
  downloadRecognition(language: string): Promise<'done' | 'scheduled' | 'requested'>;
  /** Sessions are recognized one at a time, in the order they start. */
  startRecognition(session: number, language: string): void;
  /** 16 kHz 16-bit mono PCM. */
  writeAudio(session: number, pcm: Uint8Array): void;
  /** Recognizes the rest of what was written, then reports "end". */
  endAudio(session: number): void;
  cancelRecognition(session: number): void;
  /** ML Kit language codes ("en", "es", "zh"...) of the translation models already on the phone. */
  translationModels(): Promise<string[]>;
  /** Downloads what the language pair needs (about 30 MB per language), unless it is already there. */
  prepareTranslation(source: string, target: string): Promise<void>;
  translate(source: string, target: string, text: string): Promise<string>;
  closeTranslation(): void;
}

// Android only; undefined on iOS.
export default requireOptionalNativeModule<EarbridgeOnDeviceModule>('EarbridgeOnDevice');
