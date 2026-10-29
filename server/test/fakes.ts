import { silentLogger } from '../../shared/pipeline/log.ts';
import type { SttEvents, SttProvider, SttStream, SttStreamOptions } from '../../shared/pipeline/stt/types.ts';
import type { TranslationRequest, Translator } from '../../shared/pipeline/translate/types.ts';
import type { SpeechRequest, SpeechSynthesizer } from '../../shared/pipeline/voice/types.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { RoomRegistry } from '../src/rooms.ts';
import { ClientSession } from '../src/session.ts';
import type { SessionDeps } from '../src/session.ts';

export class FakeSttStream implements SttStream {
  readonly language: string;
  /** Asked to tell talkers apart. */
  readonly speakers: boolean;
  readonly events: SttEvents;
  readonly audio: Uint8Array[] = [];
  finalized = 0;
  closed = false;
  /** Every complete utterance heard, by this stream and the others of its provider. */
  private readonly said: string[];

  constructor(language: string, events: SttEvents, said: string[] = [], speakers = false) {
    this.language = language;
    this.speakers = speakers;
    this.events = events;
    this.said = said;
  }

  sendAudio(chunk: Uint8Array): void {
    this.audio.push(chunk);
  }

  finalize(): void {
    this.finalized += 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClosed();
  }

  /** The recognizer heard a complete utterance, said between two times (seconds into the stream). */
  say(text: string, wordLanguages: string[] = [], timing: { start: number; end: number } | object = {}): void {
    this.said.push(text);
    this.events.onResult({ text, isFinal: true, speechFinal: true, fromFinalize: false, wordLanguages, ...timing });
  }

  /** The recognizer is still hearing this. */
  hear(text: string, wordLanguages: string[] = [], timing: { start: number; end: number } | object = {}): void {
    this.events.onResult({ text, isFinal: false, speechFinal: false, fromFinalize: false, wordLanguages, ...timing });
  }
}

export class FakeSttProvider implements SttProvider {
  readonly streams: FakeSttStream[] = [];
  /** Every complete utterance its streams heard, in order. */
  readonly said: string[] = [];

  open(options: SttStreamOptions, events: SttEvents): SttStream {
    const stream = new FakeSttStream(options.language, events, this.said, options.speakers === true);
    this.streams.push(stream);
    events.onStatus('connecting');
    return stream;
  }

  get last(): FakeSttStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('no stream opened');
    return stream;
  }
}

/** Translates "text" into "[target] text", streaming it in two partials. */
export class FakeTranslator implements Translator {
  readonly requests: TranslationRequest[] = [];
  failWith: Error | undefined;

  async translate(request: TranslationRequest): Promise<string> {
    this.requests.push(request);
    const failure = this.failWith;
    await Promise.resolve();
    if (failure) throw failure;
    const result = `[${request.targetLang}] ${request.text}`;
    request.onPartial?.(result.slice(0, 4));
    request.onPartial?.(result);
    return result;
  }
}

/** Has a voice for a few languages, and "reads" text as the clip "lang:text". */
export class FakeSynthesizer implements SpeechSynthesizer {
  readonly languages: ReadonlySet<string>;
  readonly requests: SpeechRequest[] = [];
  failWith: Error | undefined;
  private held: Promise<void> | undefined;

  constructor(languages: Iterable<string> = ['en-US', 'es', 'fr', 'de']) {
    this.languages = new Set(languages);
  }

  supports(lang: string): boolean {
    return this.languages.has(lang);
  }

  /** Keeps the voice from finishing until the returned function is called. */
  hold(): () => void {
    let release!: () => void;
    this.held = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  async synthesize(request: SpeechRequest): Promise<string[]> {
    this.requests.push(request);
    const failure = this.failWith;
    await (this.held ?? Promise.resolve());
    if (failure) throw failure;
    return [Buffer.from(`${request.lang}:${request.text}`).toString('base64')];
  }
}

export interface TestClient {
  session: ClientSession;
  messages: ServerMessage[];
  closed: boolean;
  send(message: object): void;
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[];
}

export function createDeps(overrides: Partial<SessionDeps> = {}) {
  const stt = new FakeSttProvider();
  const translator = new FakeTranslator();
  const synthesizer = new FakeSynthesizer();
  const deps: SessionDeps = {
    stt,
    translator,
    synthesizer,
    rooms: new RoomRegistry({ translator, synthesizer, log: silentLogger }),
    accessToken: undefined,
    log: silentLogger,
    ...overrides,
  };
  return { deps, stt, translator, synthesizer };
}

export function connect(deps: SessionDeps): TestClient {
  const messages: ServerMessage[] = [];
  const client: TestClient = {
    session: undefined as unknown as ClientSession,
    messages,
    closed: false,
    send: (message) => client.session.handleText(JSON.stringify(message)),
    of: (type) => messages.filter((m) => m.type === type) as never,
  };
  client.session = new ClientSession(
    {
      send: (message) => messages.push(message),
      close: () => {
        client.closed = true;
      },
    },
    deps,
  );
  return client;
}

/** Let pending promise callbacks (fake translations) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Polls until `probe` returns something truthy (for tests with real sockets), then returns it. */
export async function eventually<T>(probe: () => T, timeoutMs = 2_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
