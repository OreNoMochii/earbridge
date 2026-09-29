import type { ServerMessage } from '../../shared/protocol.ts';
import { silentLogger } from '../src/log.ts';
import { RoomRegistry } from '../src/rooms.ts';
import { ClientSession } from '../src/session.ts';
import type { SessionDeps } from '../src/session.ts';
import type { SttEvents, SttProvider, SttStream, SttStreamOptions } from '../src/stt/types.ts';
import type { TranslationRequest, Translator } from '../src/translate/types.ts';

export class FakeSttStream implements SttStream {
  readonly language: string;
  readonly events: SttEvents;
  readonly audio: Buffer[] = [];
  finalized = 0;
  closed = false;

  constructor(language: string, events: SttEvents) {
    this.language = language;
    this.events = events;
  }

  sendAudio(chunk: Buffer): void {
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

  /** The recognizer heard a complete utterance. */
  say(text: string, wordLanguages: string[] = []): void {
    this.events.onResult({ text, isFinal: true, speechFinal: true, fromFinalize: false, wordLanguages });
  }

  /** The recognizer is still hearing this. */
  hear(text: string, wordLanguages: string[] = []): void {
    this.events.onResult({ text, isFinal: false, speechFinal: false, fromFinalize: false, wordLanguages });
  }
}

export class FakeSttProvider implements SttProvider {
  readonly streams: FakeSttStream[] = [];

  open(options: SttStreamOptions, events: SttEvents): SttStream {
    const stream = new FakeSttStream(options.language, events);
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
  const deps: SessionDeps = {
    stt,
    translator,
    rooms: new RoomRegistry({ translator, log: silentLogger }),
    accessToken: undefined,
    log: silentLogger,
    ...overrides,
  };
  return { deps, stt, translator };
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
