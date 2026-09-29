// Preferences remembered on this device. Kept free of DOM APIs so it can be unit-tested
// in Node: the caller passes in localStorage and navigator.languages.

import { LANGUAGES, baseLanguage, isSupportedLanguage, sameLanguage } from '../../shared/languages.ts';
import type { Mode } from '../../shared/protocol.ts';

/** handsfree: the microphone is always on. hold: it is on while a button is held. */
export type TalkMode = 'handsfree' | 'hold';

/**
 * earphones: translations for me play in my earphones.
 * speaker: every translation is read aloud on the phone speaker, and the microphone
 *          pauses meanwhile so the phone does not transcribe itself.
 */
export type Output = 'earphones' | 'speaker';

export interface Settings {
  mode: Mode;
  /** My language, in both modes. */
  myLang: string;
  /** The other person's language, in one-phone mode. */
  theirLang: string;
  /** Shown to the others in a room. */
  name: string;
  talkMode: TalkMode;
  output: Output;
  /** Microphone deviceId, or '' for the system default. */
  micId: string;
  /** Access code, for servers that require one. */
  token: string;
}

/** The part of the Storage API used here. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'earbridge.settings';
export const MAX_NAME_LENGTH = 40;
const COMMONWEALTH_ENGLISH = /^en-(gb|au|nz|ie|za|in)\b/;

/** Maps a browser language tag ("en-AU", "zh-Hant-HK", "nb") to a language the app offers. */
export function matchLanguage(tag: string): string | undefined {
  const normalized = tag.replace(/_/g, '-').toLowerCase();
  const exact = LANGUAGES.find((language) => language.code.toLowerCase() === normalized);
  if (exact) return exact.code;
  const base = baseLanguage(normalized);
  if (base === 'en') return COMMONWEALTH_ENGLISH.test(normalized) ? 'en-GB' : 'en-US';
  if (base === 'zh') return /-(hant|tw|hk|mo)\b/.test(normalized) ? 'zh-TW' : 'zh-CN';
  if (base === 'nb' || base === 'nn') return 'no';
  return LANGUAGES.find((language) => baseLanguage(language.code) === base)?.code;
}

/** A sensible other language: the browser's next preference, else English (or Spanish). */
function partnerLanguage(myLang: string, browserLanguages: readonly string[]): string {
  for (const tag of browserLanguages) {
    const code = matchLanguage(tag);
    if (code && !sameLanguage(code, myLang)) return code;
  }
  return baseLanguage(myLang) === 'en' ? 'es' : 'en-US';
}

export function defaultSettings(browserLanguages: readonly string[]): Settings {
  const myLang = browserLanguages.map(matchLanguage).find((code) => code !== undefined) ?? 'en-US';
  return {
    mode: 'solo',
    myLang,
    theirLang: partnerLanguage(myLang, browserLanguages),
    name: '',
    talkMode: 'handsfree',
    output: 'earphones',
    micId: '',
    token: '',
  };
}

export function loadSettings(store: KeyValueStore | undefined, browserLanguages: readonly string[]): Settings {
  const defaults = defaultSettings(browserLanguages);
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(store?.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      saved = parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable (storage disabled, or edited by hand): start from the defaults.
  }

  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const text = (value: unknown, maxLength: number): string =>
    typeof value === 'string' ? value.slice(0, maxLength) : '';

  const myLang = isSupportedLanguage(saved['myLang']) ? saved['myLang'] : defaults.myLang;
  let theirLang = isSupportedLanguage(saved['theirLang']) ? saved['theirLang'] : defaults.theirLang;
  if (sameLanguage(myLang, theirLang)) theirLang = partnerLanguage(myLang, browserLanguages);

  return {
    mode: oneOf(saved['mode'], ['solo', 'room'], defaults.mode),
    myLang,
    theirLang,
    name: text(saved['name'], MAX_NAME_LENGTH),
    talkMode: oneOf(saved['talkMode'], ['handsfree', 'hold'], defaults.talkMode),
    output: oneOf(saved['output'], ['earphones', 'speaker'], defaults.output),
    micId: text(saved['micId'], 500),
    token: text(saved['token'], 500),
  };
}

export function saveSettings(store: KeyValueStore | undefined, settings: Settings): void {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or disabled: the settings just won't be remembered.
  }
}
