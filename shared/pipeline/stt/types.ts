// Provider-neutral speech-to-text interface. Deepgram is the bundled implementation;
// any streaming recognizer (AssemblyAI, Speechmatics, Google, a local Whisper server...)
// can be plugged in by implementing SttProvider.

export interface SttResult {
  text: string;
  /** This segment's text will not change any more. */
  isFinal: boolean;
  /** The recognizer detected the end of a spoken turn (endpointing). */
  speechFinal: boolean;
  /** Result produced in response to SttStream.finalize(). */
  fromFinalize: boolean;
  /** Per-word language tags (base codes like "en"), when the recognizer provides them. */
  wordLanguages: string[];
  /**
   * When the first word starts and the last one ends, in seconds of audio since the
   * stream's first `sendAudio`, when the recognizer reports word timings.
   */
  start?: number;
  end?: number;
}

export type SttStatus = 'connecting' | 'live' | 'reconnecting';

export interface SttEvents {
  onResult(result: SttResult): void;
  /** Silence after speech: whatever was said so far is a complete utterance. */
  onUtteranceEnd(): void;
  onStatus(status: SttStatus): void;
  onError(error: Error, fatal: boolean): void;
  /** The stream has ended (closed or failed); no further events follow. */
  onClosed(): void;
}

export interface SttStreamOptions {
  /** BCP-47 language code, or "multi" for automatic multilingual recognition. */
  language: string;
}

export interface SttStream {
  /** 16 kHz mono PCM16LE audio. */
  sendAudio(chunk: Uint8Array): void;
  /** Force the recognizer to finalize everything heard so far. */
  finalize(): void;
  /** Finish gracefully: pending results are still delivered, then the stream ends. */
  close(): void;
}

export interface SttProvider {
  open(options: SttStreamOptions, events: SttEvents): SttStream;
}
