// Speech recognition that runs on the phone itself (Android's on-device recognizer),
// behind the same interface as Deepgram. The native side recognizes one session at a
// time; this turns its sessions into a stream that can be finalized and closed.

import { languageName } from '../../languages.ts';
import type { SttEvents, SttProvider, SttStatus, SttStream, SttStreamOptions } from './types.ts';

/** What the recognizer reports for a session. `end` always comes last, after a fatal error too. */
export type RecognitionEvent =
  | { session: number; type: 'ready' }
  /** What it is hearing so far in the current sentence, or the sentence once it is done. */
  | { session: number; type: 'partial' | 'segment'; text: string }
  /** An Android SpeechRecognizer error code. */
  | { session: number; type: 'error'; code: number; fatal: boolean }
  | { session: number; type: 'end' };

/**
 * The phone's recognizer. A session is one turn: audio is written to it as it is
 * recorded until `end`, then it is recognized to the last word and reports `end`.
 * Sessions are recognized one at a time, in the order they started.
 */
export interface OnDeviceRecognizer {
  start(session: number, locale: string): void;
  /** 16 kHz mono PCM16LE. */
  write(session: number, pcm: Uint8Array): void;
  end(session: number): void;
  /** Stops at once; `end` is still reported. */
  cancel(session: number): void;
  /** Returns a function that stops listening. */
  listen(listener: (event: RecognitionEvent) => void): () => void;
}

export interface OnDeviceSttOptions {
  recognizer: OnDeviceRecognizer;
  /** The recognizer's locale for a language, e.g. "es" -> "es-ES". Others are passed as they are. */
  locales?: Readonly<Record<string, string>>;
}

// Android SpeechRecognizer error codes.
const ERROR_INSUFFICIENT_PERMISSIONS = 9;
const ERROR_LANGUAGE_NOT_SUPPORTED = 12;
const ERROR_LANGUAGE_UNAVAILABLE = 13;

/** How long a closing stream waits for its last words. */
const CLOSE_GRACE_MS = 6_000;

/** Session ids are unique across streams: they share one recognizer. */
let lastSession = 0;

export class OnDeviceSttProvider implements SttProvider {
  private readonly options: OnDeviceSttOptions;

  constructor(options: OnDeviceSttOptions) {
    this.options = options;
  }

  open(options: SttStreamOptions, events: SttEvents): SttStream {
    const locale = this.options.locales?.[options.language] ?? options.language;
    return new OnDeviceStream(this.options.recognizer, options.language, locale, events);
  }
}

/**
 * Each finalize() ends the current session, so the recognizer finishes that turn, and
 * starts the next one at once; its audio waits on the native side until the recognizer
 * gets to it.
 */
class OnDeviceStream implements SttStream {
  private readonly recognizer: OnDeviceRecognizer;
  private readonly language: string;
  private readonly locale: string;
  private readonly events: SttEvents;
  private readonly unsubscribe: () => void;
  /** Sessions of this stream the recognizer has not ended yet. */
  private readonly live = new Set<number>();
  private current = 0;
  private status: SttStatus = 'connecting';
  private closing = false;
  private finished = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(recognizer: OnDeviceRecognizer, language: string, locale: string, events: SttEvents) {
    this.recognizer = recognizer;
    this.language = language;
    this.locale = locale;
    this.events = events;
    this.unsubscribe = recognizer.listen((event) => this.handle(event));
    events.onStatus('connecting');
    this.begin();
  }

  sendAudio(chunk: Uint8Array): void {
    if (!this.closing) this.recognizer.write(this.current, chunk);
  }

  finalize(): void {
    if (this.closing) return;
    const previous = this.current;
    this.begin();
    this.recognizer.end(previous);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.recognizer.end(this.current);
    if (this.live.size === 0) this.finish();
    else this.closeTimer = setTimeout(() => this.finish(), CLOSE_GRACE_MS);
  }

  private begin(): void {
    const session = ++lastSession;
    this.current = session;
    this.live.add(session);
    try {
      this.recognizer.start(session, this.locale);
    } catch (error) {
      // Reported once whoever opened the stream has it.
      setTimeout(() => this.fail(error instanceof Error ? error : new Error(String(error))), 0);
    }
  }

  private handle(event: RecognitionEvent): void {
    if (this.finished || !this.live.has(event.session)) return;
    switch (event.type) {
      case 'ready':
        this.setStatus('live');
        break;
      case 'partial':
        this.setStatus('live');
        this.events.onResult({ text: event.text, isFinal: false, speechFinal: false, fromFinalize: false, wordLanguages: [] });
        break;
      case 'segment':
        this.setStatus('live');
        // Each sentence the recognizer completes is a whole utterance worth translating.
        this.events.onResult({
          text: event.text,
          isFinal: true,
          speechFinal: true,
          fromFinalize: event.session !== this.current,
          wordLanguages: [],
        });
        break;
      case 'error':
        if (event.fatal) {
          this.fail(new Error(this.describe(event.code)));
        } else {
          if (event.session === this.current && !this.closing) this.setStatus('reconnecting');
          this.events.onError(new Error(`On-device speech recognition error ${event.code}; retrying.`), false);
        }
        break;
      case 'end':
        this.live.delete(event.session);
        if (this.closing) {
          if (this.live.size === 0) this.finish();
        } else if (event.session === this.current) {
          this.fail(new Error('Speech recognition on this phone stopped unexpectedly.'));
        }
        break;
    }
  }

  private setStatus(status: SttStatus): void {
    if (status === this.status || this.closing) return;
    this.status = status;
    this.events.onStatus(status);
  }

  private describe(code: number): string {
    const name = languageName(this.language);
    switch (code) {
      case ERROR_INSUFFICIENT_PERMISSIONS:
        return "Android didn't allow EarBridge to use speech recognition.";
      case ERROR_LANGUAGE_NOT_SUPPORTED:
        return `Speech recognition on this phone doesn't support ${name}.`;
      case ERROR_LANGUAGE_UNAVAILABLE:
        return `Speech recognition for ${name} isn't downloaded on this phone yet. Connect to the internet and start again to download it.`;
      default:
        return `Speech recognition on this phone stopped working (error ${code}).`;
    }
  }

  private fail(error: Error): void {
    if (this.finished) return;
    this.finish();
    this.events.onError(error, true);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.closing = true;
    clearTimeout(this.closeTimer);
    this.unsubscribe();
    for (const session of this.live) this.recognizer.cancel(session);
    this.live.clear();
    this.events.onClosed();
  }
}

/** Recognizer locales such as "en-US" or "cmn-Hans-CN". */
export interface RecognitionLanguages {
  installed: readonly string[];
  /** Scheduled to download. */
  pending: readonly string[];
  /** Can be downloaded. */
  supported: readonly string[];
}

export interface RecognitionLocale {
  locale: string;
  /** Otherwise it has to be downloaded first. */
  installed: boolean;
}

/** Old or alternative codes recognizers use for the app's languages. */
const ALIASES: Readonly<Record<string, string>> = { cmn: 'zh', nb: 'no', iw: 'he', in: 'id' };

/**
 * The recognizer locale that fits an app language best ("es" -> "es-ES", "zh-TW" ->
 * "cmn-Hant-TW"), preferring one that is installed when two fit as well. Undefined if
 * the recognizer has nothing for the language.
 */
export function pickRecognitionLocale(language: string, available: RecognitionLanguages): RecognitionLocale | undefined {
  let best: RecognitionLocale | undefined;
  let bestFit = 0;
  const consider = (locales: readonly string[], installed: boolean) => {
    for (const locale of locales) {
      const score = fit(language, locale);
      if (score > bestFit) {
        best = { locale, installed };
        bestFit = score;
      }
    }
  };
  consider(available.installed, true);
  consider([...available.pending, ...available.supported], false);
  return best;
}

interface Tag {
  base: string;
  subtags: string[];
  normalized: string;
}

function parseTag(tag: string): Tag {
  const parts = tag.toLowerCase().replace(/_/g, '-').split('-').filter(Boolean);
  const first = parts[0] ?? '';
  const base = ALIASES[first] ?? first;
  const subtags = parts.slice(1);
  return { base, subtags, normalized: [base, ...subtags].join('-') };
}

/** 0: another language. 1: the same language. 2: also the right region or script. 3: exactly. */
function fit(language: string, locale: string): number {
  const want = parseTag(language);
  const have = parseTag(locale);
  if (!want.base || have.base !== want.base) return 0;
  if (have.normalized === want.normalized) return 3;
  let preferred: string[];
  if (want.base === 'zh') {
    const traditional = want.subtags.some((subtag) => subtag === 'tw' || subtag === 'hk' || subtag === 'hant');
    preferred = traditional ? ['hant', 'tw'] : ['hans', 'cn'];
  } else {
    // The region asked for ("pt-BR"), or else the language's home region ("fr" -> "fr-FR").
    preferred = want.subtags.length > 0 ? want.subtags : [want.base];
  }
  return have.subtags.some((subtag) => preferred.includes(subtag)) ? 2 : 1;
}
