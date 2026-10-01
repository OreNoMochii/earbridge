// What the app remembers: the web app's settings, plus the server and the microphone,
// which only the phone app asks for.

import { getLocales } from 'expo-localization';

import { loadSettings, saveSettings } from '../../client/src/settings.ts';
import type { Settings } from '../../client/src/settings.ts';
import { storage } from './storage.ts';

/**
 * auto: the phone's microphone with one phone (it hears you both, and Bluetooth earphones
 *       keep their full sound quality), the earphones' microphone in a room.
 */
export type MicChoice = 'auto' | 'phone' | 'earphones';

export interface AppSettings extends Settings {
  /** The EarBridge server, as typed, e.g. "192.168.1.20:8787". */
  server: string;
  mic: MicChoice;
}

const APP_KEY = 'earbridge.app';
/** Can be built in: EXPO_PUBLIC_SERVER_URL=http://192.168.1.20:8787 npx expo run:android */
const DEFAULT_SERVER = process.env.EXPO_PUBLIC_SERVER_URL ?? '';

export function loadAppSettings(): AppSettings {
  const languages = getLocales().map((locale) => locale.languageTag);
  const settings = loadSettings(storage, languages.length > 0 ? languages : ['en-US']);
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(APP_KEY) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      saved = parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable: start from the defaults.
  }
  const server = typeof saved['server'] === 'string' && saved['server'].trim() ? saved['server'] : DEFAULT_SERVER;
  const mic = saved['mic'] === 'phone' || saved['mic'] === 'earphones' ? saved['mic'] : 'auto';
  return { ...settings, server: server.slice(0, 500), mic };
}

export function saveAppSettings(settings: AppSettings): void {
  const { server, mic, ...shared } = settings;
  saveSettings(storage, shared);
  storage.setItem(APP_KEY, JSON.stringify({ server, mic }));
}

/** Whether to listen through the earphones' microphone, when they have one. */
export function wantsEarphoneMic(settings: AppSettings): boolean {
  return settings.mic === 'earphones' || (settings.mic === 'auto' && settings.mode === 'room');
}
