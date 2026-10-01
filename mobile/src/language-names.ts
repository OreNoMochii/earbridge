// How languages are shown: in English and in the language itself, so the other person
// can find theirs. The native names are fixed here, since the phone's JavaScript engine
// may not know them.

import { baseLanguage, languageName } from '../../shared/languages.ts';

const NATIVE_NAMES: Readonly<Record<string, string>> = {
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  nl: 'Nederlands',
  ja: '日本語',
  ko: '한국어',
  'zh-CN': '中文（简体）',
  'zh-TW': '中文（繁體）',
  hi: 'हिन्दी',
  ar: 'العربية',
  ru: 'Русский',
  uk: 'Українська',
  tr: 'Türkçe',
  pl: 'Polski',
  sv: 'Svenska',
  da: 'Dansk',
  no: 'Norsk',
  fi: 'Suomi',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  el: 'Ελληνικά',
  cs: 'Čeština',
  ro: 'Română',
  hu: 'Magyar',
  bg: 'Български',
  ca: 'Català',
  sk: 'Slovenčina',
};

/** The language's own name for itself, e.g. "Deutsch"; none for English. */
export function nativeLanguageName(code: string): string | undefined {
  return NATIVE_NAMES[code];
}

/** "German · Deutsch", or just "English (US)". */
export function languageLabel(code: string): string {
  const native = NATIVE_NAMES[code];
  return native ? `${languageName(code)} · ${native}` : languageName(code);
}

/** "DE", for tight spots. */
export function shortLanguageLabel(code: string): string {
  return baseLanguage(code).toUpperCase();
}
