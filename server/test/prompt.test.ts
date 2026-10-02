import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../shared/pipeline/translate/prompt.ts';

describe('translation prompt', () => {
  it('names both languages and wraps the utterance', () => {
    const prompt = buildUserPrompt({
      text: 'Where is the station?',
      sourceLang: 'en-US',
      targetLang: 'ja',
      context: [],
    });
    assert.equal(
      prompt,
      'Translate this utterance from English (US) into Japanese:\n<utterance>\nWhere is the station?\n</utterance>',
    );
  });

  it('includes recent conversation for context, oldest first', () => {
    const prompt = buildUserPrompt({
      text: 'Is it far?',
      sourceLang: 'en-US',
      targetLang: 'es',
      context: [
        { speaker: 'Ann', lang: 'en-US', text: 'Where is the station?' },
        { speaker: 'Bea', lang: 'es', text: 'Está al final de la calle.' },
      ],
    });
    assert.match(
      prompt,
      /^<recent_conversation>\nAnn \(English \(US\)\): Where is the station\?\nBea \(Spanish\): Está al final de la calle\.\n<\/recent_conversation>\n\nTranslate this utterance from English \(US\) into Spanish:/,
    );
  });

  it('keeps the system prompt static so it can be cached', () => {
    assert.doesNotMatch(SYSTEM_PROMPT, /\$\{/);
  });
});
