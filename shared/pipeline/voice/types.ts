// Provider-neutral text-to-speech interface. DeepInfra is the bundled implementation.
// Languages a synthesizer has no voice for are read by the phone's own voice instead.

export interface SpeechRequest {
  text: string;
  lang: string;
  signal?: AbortSignal;
}

export interface SpeechSynthesizer {
  /** Whether there is a voice for this language. */
  supports(lang: string): boolean;
  /**
   * Resolves with audio clips (such as MP3), base64-encoded, to play one after the
   * other. Rejects with a SpeechError (whose message can be shown in the app) or, when
   * `signal` is aborted, with an abort error.
   */
  synthesize(request: SpeechRequest): Promise<string[]>;
}

/** A text-to-speech failure with a message that is safe and useful to show in the app. */
export class SpeechError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpeechError';
  }
}
