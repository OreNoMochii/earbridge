import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { DeepgramProvider } from '../../shared/pipeline/stt/deepgram.ts';
import type { SttEvents, SttResult, SttStatus, SttStream } from '../../shared/pipeline/stt/types.ts';
import { openDeepgramSocket } from '../src/deepgram-socket.ts';
import { eventually } from './fakes.ts';

interface Connection {
  url: URL;
  authorization: string | undefined;
  socket: WebSocket;
  audio: Buffer[];
  controls: string[];
}

/** Stands in for wss://api.deepgram.com/v1/listen. */
class FakeDeepgram {
  readonly connections: Connection[] = [];
  /** Decides whether to refuse a connection, like Deepgram does for bad keys or languages. */
  reject: ((url: URL) => { status: number; error: string } | undefined) | undefined;
  /** What Deepgram still sends after CloseStream, before closing the socket. */
  finalMessages: object[] = [];
  private readonly server: WebSocketServer;

  constructor() {
    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, done) => {
        const rejection = this.reject?.(new URL(info.req.url ?? '/', 'ws://localhost'));
        if (rejection) done(false, rejection.status, 'Rejected', { 'dg-error': rejection.error });
        else done(true);
      },
    });
    this.server.on('connection', (socket, req) => {
      const connection: Connection = {
        url: new URL(req.url ?? '/', 'ws://localhost'),
        authorization: req.headers.authorization,
        socket,
        audio: [],
        controls: [],
      };
      this.connections.push(connection);
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          connection.audio.push(data as Buffer);
          return;
        }
        const { type } = JSON.parse(data.toString()) as { type: string };
        connection.controls.push(type);
        if (type === 'CloseStream') {
          for (const message of this.finalMessages) socket.send(JSON.stringify(message));
          socket.close(1000);
        }
      });
    });
  }

  async listening(): Promise<void> {
    await once(this.server, 'listening');
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/listen`;
  }

  reset(): void {
    for (const client of this.server.clients) client.terminate();
    this.connections.length = 0;
    this.reject = undefined;
    this.finalMessages = [];
  }

  close(): Promise<void> {
    this.reset();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** Records stream events in order, e.g. ["status:connecting", "status:live", "result:Hola", "closed"]. */
class Recorder implements SttEvents {
  readonly log: string[] = [];
  readonly results: SttResult[] = [];
  readonly statuses: SttStatus[] = [];
  readonly errors: Array<{ message: string; fatal: boolean }> = [];

  onResult(result: SttResult): void {
    this.results.push(result);
    this.log.push(`result:${result.text}`);
  }
  onUtteranceEnd(): void {
    this.log.push('utterance-end');
  }
  onStatus(status: SttStatus): void {
    this.statuses.push(status);
    this.log.push(`status:${status}`);
  }
  onError(error: Error, fatal: boolean): void {
    this.errors.push({ message: error.message, fatal });
    this.log.push('error');
  }
  onClosed(): void {
    this.log.push('closed');
  }

  count(status: SttStatus): number {
    return this.statuses.filter((s) => s === status).length;
  }
}

function results(transcript: string, flags: object = {}, words: object[] = []): object {
  return { type: 'Results', ...flags, channel: { alternatives: [{ transcript, words }] } };
}

describe('Deepgram live transcription', () => {
  const deepgram = new FakeDeepgram();
  const opened: Array<{ stream: SttStream; events: Recorder }> = [];

  function open(language: string, speakers?: boolean) {
    const provider = new DeepgramProvider({
      apiKey: 'dg-test-key',
      model: 'nova-3',
      fallbackModel: 'nova-2',
      url: deepgram.url,
      openSocket: openDeepgramSocket,
      keyHint: 'Check DEEPGRAM_API_KEY on the server.',
    });
    const events = new Recorder();
    const stream = provider.open({ language, ...(speakers !== undefined && { speakers }) }, events);
    opened.push({ stream, events });
    return { stream, events };
  }

  before(() => deepgram.listening());
  afterEach(async () => {
    // Wait for each stream to wind down so no timer outlives its test.
    for (const { stream, events } of opened.splice(0)) {
      stream.close();
      await eventually(() => events.log.includes('closed'));
    }
    deepgram.reset();
  });
  after(() => deepgram.close());

  it('streams 16 kHz PCM with the key, model and language, including audio sent while connecting', async () => {
    const { stream, events } = open('multi');
    stream.sendAudio(Buffer.alloc(640));
    await eventually(() => events.count('live'));
    stream.sendAudio(Buffer.alloc(320));

    const connection = deepgram.connections[0]!;
    assert.equal(connection.authorization, 'Token dg-test-key');
    const { model, language, encoding, sample_rate, channels, interim_results } = Object.fromEntries(
      connection.url.searchParams,
    );
    assert.deepEqual(
      { model, language, encoding, sample_rate, channels, interim_results },
      {
        model: 'nova-3',
        language: 'multi',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        interim_results: 'true',
      },
    );
    await eventually(() => connection.audio.length === 2);
    assert.deepEqual(
      connection.audio.map((chunk) => chunk.length),
      [640, 320],
    );
  });

  it('turns transcripts into results with per-word languages', async () => {
    const { events } = open('multi');
    await eventually(() => events.count('live'));
    const { socket } = deepgram.connections[0]!;
    socket.send(JSON.stringify({ type: 'SpeechStarted' }));
    socket.send('not json');
    socket.send(
      JSON.stringify(
        results('Hola amigo', { is_final: true, speech_final: true }, [
          { word: 'hola', language: 'es' },
          { word: 'amigo', language: 'es-419' },
        ]),
      ),
    );
    socket.send(
      JSON.stringify({
        type: 'Results',
        channel: { alternatives: [{ transcript: 'Bonjour', words: [{ word: 'bonjour' }], languages: ['fr'] }] },
      }),
    );
    socket.send(JSON.stringify({ type: 'UtteranceEnd' }));
    await eventually(() => events.log.includes('utterance-end'));

    assert.deepEqual(events.results, [
      { text: 'Hola amigo', isFinal: true, speechFinal: true, fromFinalize: false, wordLanguages: ['es', 'es'] },
      { text: 'Bonjour', isFinal: false, speechFinal: false, fromFinalize: false, wordLanguages: ['fr'] },
    ]);
  });

  it('tells the talkers apart when asked, labelling each word by connection and talker', async () => {
    const { events } = open('multi', true);
    await eventually(() => events.count('live'));
    const { socket, url } = deepgram.connections[0]!;
    assert.equal(url.searchParams.get('diarize'), 'true');
    socket.send(
      JSON.stringify(
        results('Hello there', { is_final: true, speech_final: true }, [
          { word: 'hello', punctuated_word: 'Hello', start: 0.1, end: 0.4, speaker: 0 },
          { word: 'there', punctuated_word: 'there', start: 0.5, end: 0.8, speaker: 1 },
          { word: 'hm', start: 0.9, end: 1.0 },
        ]),
      ),
    );
    await eventually(() => events.results.length === 1);
    assert.deepEqual(
      events.results[0]!.words?.map(({ text, speaker }) => [text, speaker]),
      [
        ['Hello', '1:0'],
        ['there', '1:1'],
        ['hm', undefined],
      ],
    );
  });

  it('does not ask who said what unless told to', async () => {
    const { events } = open('multi');
    await eventually(() => events.count('live'));
    assert.equal(deepgram.connections[0]!.url.searchParams.get('diarize'), null);
  });

  it('finalizes audio sent while connecting once the connection is up', async () => {
    const { stream, events } = open('en-US');
    stream.sendAudio(Buffer.alloc(640));
    stream.finalize();
    await eventually(() => events.count('live'));
    const connection = deepgram.connections[0]!;
    await eventually(() => connection.controls.includes('Finalize'));
    assert.equal(connection.audio.length, 1, 'the audio arrives before the Finalize');
    assert.deepEqual(connection.controls, ['Finalize']);
  });

  it('delivers the last results before reporting a graceful close', async () => {
    const { stream, events } = open('en-US');
    await eventually(() => events.count('live'));
    deepgram.finalMessages = [results('Goodbye', { is_final: true, from_finalize: true })];

    stream.finalize();
    stream.close();
    await eventually(() => events.log.includes('closed'));
    assert.deepEqual(deepgram.connections[0]!.controls, ['Finalize', 'CloseStream']);
    assert.deepEqual(events.log.slice(-2), ['result:Goodbye', 'closed']);
    assert.deepEqual(events.errors, []);
    stream.sendAudio(Buffer.alloc(320)); // ignored once closed
  });

  it('retries with the fallback model when the first one does not support the language', async () => {
    deepgram.reject = (url) =>
      url.searchParams.get('model') === 'nova-3'
        ? { status: 400, error: 'No such model/language/tier combination found' }
        : undefined;
    const { events } = open('bg');
    await eventually(() => events.count('live'));
    assert.equal(deepgram.connections[0]!.url.searchParams.get('model'), 'nova-2');
    assert.deepEqual(events.errors, []);
  });

  it('fails for good when no model supports the language', async () => {
    deepgram.reject = () => ({ status: 400, error: 'No such model/language/tier combination found' });
    const { events } = open('xx');
    await eventually(() => events.errors.length);
    assert.deepEqual(events.errors, [
      {
        message: 'Speech recognition does not support "xx" (No such model/language/tier combination found).',
        fatal: true,
      },
    ]);
    assert.ok(events.log.includes('closed'));
  });

  it('fails for good when the API key is rejected', async () => {
    deepgram.reject = () => ({ status: 401, error: 'Invalid credentials' });
    const { events } = open('en-US');
    await eventually(() => events.errors.length);
    assert.match(events.errors[0]!.message, /DEEPGRAM_API_KEY/);
    assert.equal(events.errors[0]!.fatal, true);
    assert.deepEqual(
      events.log.filter((entry) => entry === 'closed'),
      ['closed'],
    );
  });

  it('reconnects after the connection drops and resends audio captured meanwhile', async () => {
    const { stream, events } = open('en-US');
    await eventually(() => events.count('live'));
    deepgram.connections[0]!.socket.terminate();
    await eventually(() => events.count('reconnecting'));
    stream.sendAudio(Buffer.alloc(960));

    await eventually(() => events.count('live') === 2, 3_000);
    assert.deepEqual(events.statuses, ['connecting', 'live', 'reconnecting', 'live']);
    const second = deepgram.connections[1]!;
    await eventually(() => second.audio.length);
    assert.equal(second.audio[0]!.length, 960);
  });

  it('times words from the first audio of the stream, across reconnections', async () => {
    const { stream, events } = open('en-US');
    stream.sendAudio(Buffer.alloc(32_000)); // 1 s while connecting
    await eventually(() => events.count('live'));
    stream.sendAudio(Buffer.alloc(32_000));
    const words = (...spans: Array<[number, number]>) => spans.map(([start, end]) => ({ word: 'x', start, end }));
    deepgram.connections[0]!.socket.send(JSON.stringify(results('one two', {}, words([0.5, 0.7], [0.75, 0.9]))));
    await eventually(() => events.results.length === 1);

    deepgram.connections[0]!.socket.terminate();
    await eventually(() => events.count('reconnecting'));
    stream.sendAudio(Buffer.alloc(16_000)); // half a second while reconnecting
    await eventually(() => events.count('live') === 2, 3_000);
    // The new connection counts from its own first audio, two seconds into the stream.
    deepgram.connections[1]!.socket.send(JSON.stringify(results('three', {}, words([0.1, 0.4]))));
    await eventually(() => events.results.length === 2);

    assert.deepEqual(
      events.results.map(({ start, end }) => [start, end]),
      [
        [0.5, 0.9],
        [2.1, 2.4],
      ],
    );
  });

  it('sends KeepAlive while nobody is speaking', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const { events } = open('en-US');
    await eventually(() => events.count('live'));
    t.mock.timers.tick(4_000);
    const connection = deepgram.connections[0]!;
    await eventually(() => connection.controls.includes('KeepAlive'));
  });
});
