// Provider-neutral translation interface. DeepInfra and Claude are the bundled implementations.

export interface ContextLine {
  speaker: string;
  lang: string;
  text: string;
}

export interface TranslationRequest {
  text: string;
  sourceLang: string;
  targetLang: string;
  /** Recent conversation, oldest first, to resolve pronouns, names and ASR errors. */
  context: readonly ContextLine[];
  /** Called with the cumulative translation as it streams in. */
  onPartial?: (textSoFar: string) => void;
  signal?: AbortSignal;
}

export interface Translator {
  /**
   * Resolves with the complete translation. Rejects with a TranslationError (whose
   * message can be shown to the people in the conversation) or, when `signal` is
   * aborted, with an abort error.
   */
  translate(request: TranslationRequest): Promise<string>;
}

/** A translation failure with a message that is safe and useful to show in the app. */
export class TranslationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranslationError';
  }
}

export class TranslationRefusedError extends TranslationError {
  constructor() {
    super('The translation service declined to translate this utterance.');
    this.name = 'TranslationRefusedError';
  }
}
