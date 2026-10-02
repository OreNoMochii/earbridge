// On this phone: Android's own speech recognition and Google ML Kit translation, read
// aloud by the phone's voice. No server and no keys. Each language is downloaded once
// (about 30 MB for translation), then it works offline.

import { Platform } from 'react-native';

import { baseLanguage, languageName } from '../../../shared/languages.ts';
import { OnDeviceSttProvider, pickRecognitionLocale } from '../../../shared/pipeline/stt/on-device.ts';
import type { OnDeviceRecognizer } from '../../../shared/pipeline/stt/on-device.ts';
import { TranslationError } from '../../../shared/pipeline/translate/types.ts';
import type { TranslationRequest, Translator } from '../../../shared/pipeline/translate/types.ts';
import EarbridgeOnDevice from '../../modules/earbridge-audio/src/EarbridgeOnDeviceModule.ts';
import type { Settings } from '../../../client/src/settings.ts';
import type { Pipeline } from './in-app-backend.ts';

type OnDeviceModule = NonNullable<typeof EarbridgeOnDevice>;

const OTHER_ENGINES = 'Choose Online, best quality or Through a computer instead.';
/** How long to wait for a download Android does in its own time. */
const DOWNLOAD_WAIT_MS = 3 * 60_000;
const DOWNLOAD_POLL_MS = 2_000;

export interface LocalSupport {
  available: boolean;
  /** Why not, when it is not. */
  reason?: string;
}

let support: LocalSupport | undefined;

/** Whether this phone can translate on its own. */
export function localSupport(): LocalSupport {
  support ??= checkSupport();
  return support;
}

function checkSupport(): LocalSupport {
  if (Platform.OS !== 'android') {
    return { available: false, reason: `On-phone translation isn't available on iPhone yet. ${OTHER_ENGINES}` };
  }
  if (typeof Platform.Version === 'number' && Platform.Version < 33) {
    return { available: false, reason: `On-phone translation needs Android 13 or newer. ${OTHER_ENGINES}` };
  }
  let available = false;
  try {
    available = EarbridgeOnDevice?.isAvailable() ?? false;
  } catch {
    // Treated as unavailable.
  }
  return available
    ? { available: true }
    : { available: false, reason: `This phone has no on-device speech recognition. ${OTHER_ENGINES}` };
}

/** Gets speech recognition and translation for both languages ready, downloading what is missing. */
export async function prepareLocal(
  settings: Settings,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<Pipeline> {
  const module = EarbridgeOnDevice;
  const { available, reason } = localSupport();
  if (!module || !available) throw new Error(reason ?? 'On-phone translation is not available.');

  const { myLang, theirLang } = settings;
  const locales: Record<string, string> = {};
  for (const language of new Set([myLang, theirLang])) {
    locales[language] = await recognitionLocale(module, language, signal, progress);
  }
  await prepareTranslation(module, myLang, theirLang, signal, progress);

  return {
    stt: new OnDeviceSttProvider({ recognizer: nativeRecognizer(module), locales }),
    translator: new OnDeviceTranslator(module),
    synthesizer: undefined,
    voiceLangs: [],
    // It recognizes one language at a time, so the speaker is chosen with Me and Them.
    autoDetect: false,
    wordTimings: false,
    dispose: () => module.closeTranslation(),
  };
}

/** The recognizer's locale for a language, once it is on the phone. */
async function recognitionLocale(
  module: OnDeviceModule,
  language: string,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<string> {
  const name = languageName(language);
  const picked = pickRecognitionLocale(language, await abortable(module.recognitionLanguages(), signal));
  if (!picked) throw new Error(`Speech recognition on this phone doesn't support ${name}. ${OTHER_ENGINES}`);
  if (picked.installed) return picked.locale;

  const { locale } = picked;
  const downloading = `Downloading ${name} speech recognition…`;
  progress(downloading);
  const subscription = module.addListener('onDownloadProgress', (event) => {
    if (event.language === locale) progress(`${downloading} ${event.percent}%`);
  });
  let result: Awaited<ReturnType<OnDeviceModule['downloadRecognition']>>;
  try {
    result = await abortable(module.downloadRecognition(locale), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`Speech recognition for ${name} could not be downloaded. Connect to the internet and try again.`, {
      cause: error,
    });
  } finally {
    subscription.remove();
  }
  if (result === 'done') return locale;

  // Android downloads it in its own time (it may ask first): wait for it.
  progress(`Android is downloading ${name} speech recognition…`);
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(DOWNLOAD_POLL_MS, signal);
    const now = pickRecognitionLocale(language, await abortable(module.recognitionLanguages(), signal));
    if (now?.installed) return now.locale;
  }
  throw new Error(`Android is still downloading speech recognition for ${name}. Try again in a few minutes.`);
}

async function prepareTranslation(
  module: OnDeviceModule,
  myLang: string,
  theirLang: string,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  const mine = baseLanguage(myLang);
  const theirs = baseLanguage(theirLang);
  if (mine === theirs) return;
  const downloaded = new Set(await abortable(module.translationModels(), signal));
  const missing = [myLang, theirLang].filter((language) => !downloaded.has(baseLanguage(language))).map(languageName);
  if (missing.length > 0) progress(`Downloading ${missing.join(' and ')} translation…`);
  try {
    await abortable(module.prepareTranslation(mine, theirs), signal);
    await abortable(module.prepareTranslation(theirs, mine), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    const names = (missing.length > 0 ? missing : [myLang, theirLang].map(languageName)).join(' and ');
    throw new Error(
      `The translation for ${names} could not be downloaded. Connect to the internet once to download it (about 30 MB per language).`,
      { cause: error },
    );
  }
}

/** ML Kit translates a whole utterance at once; there is nothing to stream. */
class OnDeviceTranslator implements Translator {
  private readonly module: OnDeviceModule;

  constructor(module: OnDeviceModule) {
    this.module = module;
  }

  async translate(request: TranslationRequest): Promise<string> {
    const { signal } = request;
    const source = baseLanguage(request.sourceLang);
    const target = baseLanguage(request.targetLang);
    let text = request.text;
    if (source !== target) {
      try {
        text = await abortable(this.module.translate(source, target, request.text), signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new TranslationError('The phone could not translate this.', { cause: error });
      }
    }
    text = text.trim();
    request.onPartial?.(text);
    return text;
  }
}

function nativeRecognizer(module: OnDeviceModule): OnDeviceRecognizer {
  return {
    start: (session, locale) => module.startRecognition(session, locale),
    write: (session, pcm) => module.writeAudio(session, pcm),
    end: (session) => module.endAudio(session),
    cancel: (session) => module.cancelRecognition(session),
    listen: (listener) => {
      const subscription = module.addListener('onRecognition', listener);
      return () => subscription.remove();
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Aborted');
}

/** Rejects as soon as `signal` is aborted; the work itself carries on. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}
