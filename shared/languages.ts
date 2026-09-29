// Languages offered in the app. `code` is a BCP-47 tag that is passed as-is to the
// speech recognizer and used to pick a text-to-speech voice in the browser.

export interface Language {
  code: string;
  /** English name, used in the UI and in the translation prompt. */
  name: string;
}

export const LANGUAGES: readonly Language[] = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh-CN', name: 'Chinese (Mandarin, Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Mandarin, Traditional)' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'el', name: 'Greek' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'sk', name: 'Slovak' },
];

/**
 * Base languages Deepgram's multilingual streaming mode (`language=multi`) can
 * recognize and tag word-by-word. When both sides of a one-phone conversation are in
 * this set we can detect who is speaking automatically; otherwise the user taps
 * "Me" / "Them" to tell the recognizer which language to expect.
 */
export const AUTO_DETECT_BASES: ReadonlySet<string> = new Set([
  'en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl',
]);

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function isSupportedLanguage(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}

export function languageName(code: string): string {
  return BY_CODE.get(code)?.name ?? code;
}

/** "pt-BR" -> "pt". */
export function baseLanguage(code: string): string {
  return code.split('-')[0]!.toLowerCase();
}

export function sameLanguage(a: string, b: string): boolean {
  return baseLanguage(a) === baseLanguage(b);
}

export function canAutoDetect(a: string, b: string): boolean {
  return (
    !sameLanguage(a, b) &&
    AUTO_DETECT_BASES.has(baseLanguage(a)) &&
    AUTO_DETECT_BASES.has(baseLanguage(b))
  );
}
