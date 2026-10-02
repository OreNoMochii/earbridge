import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OnDeviceSttProvider, pickRecognitionLocale } from '../../shared/pipeline/stt/on-device.ts';
import type { OnDeviceRecognizer, RecognitionEvent } from '../../shared/pipeline/stt/on-device.ts';
import type { SttEvents, SttResult, SttStatus } from '../../shared/pipeline/stt/types.ts';

/** Records what the stream asks of the phone's recognizer, and plays its events back. */
class FakeRecognizer implements OnDeviceRecognizer {
  readonly calls: string[] = [];
  readonly sessions: number[] = [];
  readonly locales: string[] = [];
  readonly audio = new Map<number, number>();
  private listener: ((event: RecognitionEvent) => void) | undefined;

  get listening(): boolean {
    return this.listener !== undefined;
  }

  /** The session started n-th (0-based); throws if there is none. */
  session(index: number): number {
    const session = this.sessions[index];
    if (session === undefined) throw new Error(`no session ${index}`);
    return session;
  }

  start(session: number, locale: string): void {
    this.sessions.push(session);
    this.locales.push(locale);
    this.calls.push(`start ${this.sessions.length - 1}`);
  }

  write(session: number, pcm: Uint8Array): void {
    this.audio.set(session, (this.audio.get(session) ?? 0) + pcm.length);
  }

  end(session: number): void {
    this.calls.push(`end ${this.sessions.indexOf(session)}`);
  }

  cancel(session: number): void {
    this.calls.push(`cancel ${this.sessions.indexOf(session)}`);
  }

  listen(listener: (event: RecognitionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: RecognitionEvent): void {
    this.listener?.(event);
  }
}

function setup(language = 'es', locales?: Record<string, string>) {
  const recognizer = new FakeRecognizer();
  const results: SttResult[] = [];
  const statuses: SttStatus[] = [];
  const errors: Array<[string, boolean]> = [];
  let closed = 0;
  const events: SttEvents = {
    onResult: (result) => results.push(result),
    onUtteranceEnd: () => {},
    onStatus: (status) => statuses.push(status),
    onError: (error, fatal) => errors.push([error.message, fatal]),
    onClosed: () => {
      closed += 1;
    },
  };
  const stream = new OnDeviceSttProvider({ recognizer, locales }).open({ language }, events);
  return {
    recognizer,
    stream,
    results,
    statuses,
    errors,
    get closed() {
      return closed;
    },
  };
}

describe('OnDeviceSttProvider', () => {
  it('starts a session in the recognizer locale and goes live once the recognizer is ready', () => {
    const { recognizer, statuses } = setup('es', { es: 'es-ES' });
    assert.deepEqual(recognizer.locales, ['es-ES']);
    assert.deepEqual(statuses, ['connecting']);
    recognizer.emit({ session: recognizer.session(0), type: 'ready' });
    recognizer.emit({ session: recognizer.session(0), type: 'ready' });
    assert.deepEqual(statuses, ['connecting', 'live']);
  });

  it('passes languages without a known locale as they are', () => {
    const { recognizer } = setup('fr', { es: 'es-ES' });
    assert.deepEqual(recognizer.locales, ['fr']);
  });

  it('turns partials into interim results and each segment into a whole utterance', () => {
    const { recognizer, results } = setup();
    const session = recognizer.session(0);
    recognizer.emit({ session, type: 'partial', text: 'dónde' });
    recognizer.emit({ session, type: 'segment', text: '¿Dónde está la estación?' });
    assert.deepEqual(results, [
      { text: 'dónde', isFinal: false, speechFinal: false, fromFinalize: false, wordLanguages: [] },
      { text: '¿Dónde está la estación?', isFinal: true, speechFinal: true, fromFinalize: false, wordLanguages: [] },
    ]);
  });

  it('sends audio to the current session', () => {
    const { recognizer, stream } = setup();
    stream.sendAudio(new Uint8Array(3200));
    stream.finalize();
    stream.sendAudio(new Uint8Array(1600));
    assert.equal(recognizer.audio.get(recognizer.session(0)), 3200);
    assert.equal(recognizer.audio.get(recognizer.session(1)), 1600);
  });

  it('finalize starts the next turn before ending the current one, whose last words come from the finalize', () => {
    const { recognizer, stream, results, errors } = setup();
    stream.finalize();
    assert.deepEqual(recognizer.calls, ['start 0', 'start 1', 'end 0']);
    recognizer.emit({ session: recognizer.session(0), type: 'segment', text: 'gracias' });
    recognizer.emit({ session: recognizer.session(0), type: 'end' });
    recognizer.emit({ session: recognizer.session(1), type: 'segment', text: 'adiós' });
    assert.deepEqual(
      results.map((result) => [result.text, result.fromFinalize]),
      [
        ['gracias', true],
        ['adiós', false],
      ],
    );
    assert.deepEqual(errors, []);
  });

  it('gives each session a new id, also across streams', () => {
    const first = setup();
    first.stream.finalize();
    const second = setup();
    const ids = [...first.recognizer.sessions, ...second.recognizer.sessions];
    assert.equal(new Set(ids).size, 3);
  });

  it('close waits for every session to finish so the last words are not lost', () => {
    const fixture = setup();
    const { recognizer, stream, results } = fixture;
    stream.finalize();
    stream.close();
    assert.deepEqual(recognizer.calls, ['start 0', 'start 1', 'end 0', 'end 1']);
    stream.sendAudio(new Uint8Array(100));
    assert.equal(recognizer.audio.size, 0);

    recognizer.emit({ session: recognizer.session(1), type: 'segment', text: 'adiós' });
    recognizer.emit({ session: recognizer.session(1), type: 'end' });
    assert.equal(fixture.closed, 0);
    recognizer.emit({ session: recognizer.session(0), type: 'segment', text: 'gracias' });
    recognizer.emit({ session: recognizer.session(0), type: 'end' });
    assert.equal(fixture.closed, 1);
    assert.equal(recognizer.listening, false);
    assert.deepEqual(
      results.map((result) => result.text),
      ['adiós', 'gracias'],
    );
    // Nothing was left to cancel.
    assert.ok(!recognizer.calls.some((call) => call.startsWith('cancel')));
  });

  it('close gives up on sessions that never end', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = setup();
    const { recognizer, stream } = fixture;
    stream.close();
    t.mock.timers.tick(5_999);
    assert.equal(fixture.closed, 0);
    t.mock.timers.tick(1);
    assert.equal(fixture.closed, 1);
    assert.deepEqual(recognizer.calls, ['start 0', 'end 0', 'cancel 0']);
    assert.equal(recognizer.listening, false);
  });

  it('reports retries as reconnecting, and goes live again once it hears something', () => {
    const { recognizer, statuses, errors } = setup();
    const session = recognizer.session(0);
    recognizer.emit({ session, type: 'ready' });
    recognizer.emit({ session, type: 'error', code: 2, fatal: false });
    recognizer.emit({ session, type: 'partial', text: 'hola' });
    assert.deepEqual(statuses, ['connecting', 'live', 'reconnecting', 'live']);
    assert.deepEqual(
      errors.map(([, fatal]) => fatal),
      [false],
    );
  });

  it('a fatal error ends the stream with a message people can act on', () => {
    const fixture = setup('es');
    const { recognizer, errors } = fixture;
    recognizer.emit({ session: recognizer.session(0), type: 'error', code: 13, fatal: true });
    assert.equal(fixture.closed, 1);
    assert.equal(recognizer.listening, false);
    assert.deepEqual(errors, [
      [
        "Speech recognition for Spanish isn't downloaded on this phone yet. Connect to the internet and start again to download it.",
        true,
      ],
    ]);
    // The session it reported is already over; the recognizer still cancels anything left.
    assert.deepEqual(recognizer.calls, ['start 0', 'cancel 0']);
  });

  it('explains the other fatal errors', () => {
    const messages = [9, 12, 5].map((code) => {
      const { recognizer, errors } = setup('de');
      recognizer.emit({ session: recognizer.session(0), type: 'error', code, fatal: true });
      return errors[0]?.[0];
    });
    assert.deepEqual(messages, [
      "Android didn't allow EarBridge to use speech recognition.",
      "Speech recognition on this phone doesn't support German.",
      'Speech recognition on this phone stopped working (error 5).',
    ]);
  });

  it('fails if the current session ends while it is still listening', () => {
    const fixture = setup();
    const { recognizer, errors } = fixture;
    recognizer.emit({ session: recognizer.session(0), type: 'end' });
    assert.equal(fixture.closed, 1);
    assert.deepEqual(errors, [['Speech recognition on this phone stopped unexpectedly.', true]]);
  });

  it('fails soon after if the recognizer cannot start', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const recognizer = new FakeRecognizer();
    recognizer.start = () => {
      throw new Error('On-phone speech recognition needs Android 13 or newer.');
    };
    const errors: Array<[string, boolean]> = [];
    let closed = 0;
    new OnDeviceSttProvider({ recognizer }).open(
      { language: 'en' },
      {
        onResult: () => {},
        onUtteranceEnd: () => {},
        onStatus: () => {},
        onError: (error, fatal) => errors.push([error.message, fatal]),
        onClosed: () => {
          closed += 1;
        },
      },
    );
    assert.deepEqual(errors, []);
    t.mock.timers.tick(0);
    assert.deepEqual(errors, [['On-phone speech recognition needs Android 13 or newer.', true]]);
    assert.equal(closed, 1);
  });

  it('ignores events of other streams and of sessions that are over', () => {
    const { recognizer, results } = setup();
    recognizer.emit({ session: recognizer.session(0) + 1000, type: 'segment', text: 'not mine' });
    recognizer.emit({ session: recognizer.session(0) - 1, type: 'segment', text: 'not mine either' });
    assert.deepEqual(results, []);
  });

  it('says nothing more once closed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = setup();
    const { recognizer, stream, statuses } = fixture;
    stream.close();
    recognizer.emit({ session: recognizer.session(0), type: 'ready' });
    recognizer.emit({ session: recognizer.session(0), type: 'error', code: 2, fatal: false });
    assert.deepEqual(statuses, ['connecting']);
    stream.finalize();
    assert.deepEqual(recognizer.calls, ['start 0', 'end 0']);
  });
});

describe('pickRecognitionLocale', () => {
  const languages = {
    installed: ['en-US'],
    pending: [],
    supported: ['en-GB', 'es-US', 'es-ES', 'fr-FR', 'fr-CA', 'cmn-Hans-CN', 'cmn-Hant-TW', 'nb-NO', 'pt-BR', 'pt-PT', 'iw-IL'],
  };

  it('picks the matching region, or the language at home', () => {
    assert.deepEqual(pickRecognitionLocale('en-GB', languages), { locale: 'en-GB', installed: false });
    assert.deepEqual(pickRecognitionLocale('es', languages), { locale: 'es-ES', installed: false });
    assert.deepEqual(pickRecognitionLocale('fr', languages), { locale: 'fr-FR', installed: false });
    assert.deepEqual(pickRecognitionLocale('pt-BR', languages), { locale: 'pt-BR', installed: false });
  });

  it('prefers what is installed when it fits as well', () => {
    assert.deepEqual(pickRecognitionLocale('en-US', languages), { locale: 'en-US', installed: true });
    // "en" has no home region; the installed one is as good as any.
    assert.deepEqual(pickRecognitionLocale('en', languages), { locale: 'en-US', installed: true });
  });

  it('knows the codes recognizers use for Chinese, Norwegian and Hebrew', () => {
    assert.deepEqual(pickRecognitionLocale('zh', languages), { locale: 'cmn-Hans-CN', installed: false });
    assert.deepEqual(pickRecognitionLocale('zh-CN', languages), { locale: 'cmn-Hans-CN', installed: false });
    assert.deepEqual(pickRecognitionLocale('zh-TW', languages), { locale: 'cmn-Hant-TW', installed: false });
    assert.deepEqual(pickRecognitionLocale('no', languages), { locale: 'nb-NO', installed: false });
    assert.deepEqual(pickRecognitionLocale('he', languages), { locale: 'iw-IL', installed: false });
  });

  it('accepts underscores and any letter case', () => {
    assert.deepEqual(pickRecognitionLocale('es', { installed: ['ES_es'], pending: [], supported: [] }), {
      locale: 'ES_es',
      installed: true,
    });
  });

  it('counts a scheduled download as not installed', () => {
    assert.deepEqual(pickRecognitionLocale('de', { installed: [], pending: ['de-DE'], supported: [] }), {
      locale: 'de-DE',
      installed: false,
    });
  });

  it('returns nothing for a language the recognizer lacks', () => {
    assert.equal(pickRecognitionLocale('sw', languages), undefined);
    assert.equal(pickRecognitionLocale('', languages), undefined);
  });
});
