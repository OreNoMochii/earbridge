// How languages are labelled in the UI. Kept free of DOM APIs so it can be unit-tested in Node.

import { baseLanguage, languageName } from '../../shared/languages.ts';

/** The language's name in that language ("es" -> "Español"), if the browser knows it. */
export function nativeLanguageName(code: string): string | undefined {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (!name || name.toLowerCase() === code.toLowerCase()) return undefined;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return undefined;
  }
}

/** "Spanish · Español", or just "English (US)" when the native name adds nothing. */
export function languageLabel(code: string): string {
  const name = languageName(code);
  const native = nativeLanguageName(code);
  return native && baseLanguage(code) !== 'en' ? `${name} · ${native}` : name;
}

/** "EN", "PT", "ZH": for tight spaces. */
export function shortLanguageLabel(code: string): string {
  return baseLanguage(code).toUpperCase();
}
