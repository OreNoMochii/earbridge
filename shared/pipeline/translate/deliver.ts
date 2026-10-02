import type { ServerMessage } from '../../protocol.ts';
import type { Logger } from '../log.ts';
import { TranslationError } from './types.ts';
import type { TranslationRequest, Translator } from './types.ts';

export type TranslationMessage = Extract<ServerMessage, { type: 'translation' }>;

/**
 * Runs one translation and reports it as `translation` messages: cumulative partial
 * text while it streams, then a final message with `done: true` (and `error` if it
 * failed). Nothing is reported once `request.signal` is aborted. Resolves with the
 * translation, or undefined if there is none.
 */
export async function deliverTranslation(
  translator: Translator,
  request: Omit<TranslationRequest, 'onPartial'>,
  utteranceId: string,
  deliver: (message: TranslationMessage) => void,
  log: Logger,
): Promise<string | undefined> {
  const base = { type: 'translation', id: utteranceId, lang: request.targetLang } as const;
  let lastPartial = '';

  try {
    const text = await translator.translate({
      ...request,
      onPartial: (textSoFar) => {
        const partial = textSoFar.trim();
        if (!partial || partial === lastPartial || request.signal?.aborted) return;
        lastPartial = partial;
        deliver({ ...base, text: partial, done: false });
      },
    });
    if (request.signal?.aborted) return undefined;
    deliver({ ...base, text, done: true });
    return text;
  } catch (error) {
    if (request.signal?.aborted) return undefined;
    log.warn(`translation ${request.sourceLang} -> ${request.targetLang} failed`, error);
    const message = error instanceof TranslationError ? error.message : 'Translation failed.';
    deliver({ ...base, text: '', done: true, error: message });
    return undefined;
  }
}
