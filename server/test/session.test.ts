import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TranslationRefusedError } from '../../shared/pipeline/translate/types.ts';
import { SpeechError } from '../../shared/pipeline/voice/types.ts';
import { sanitizeName } from '../src/session.ts';
import { connect, createDeps, settle } from './fakes.ts';

const pcm = (bytes: number) => Buffer.alloc(bytes);

describe('solo conversation (one phone)', () => {
  it('detects who is speaking by language and translates the other way', async () => {
    const { deps, stt, translator } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es' });

    assert.deepEqual(client.of('ready')[0], {
      type: 'ready',
      clientId: client.session.id,
      mode: 'solo',
      autoDetect: true,
      speaker: 'auto',
      voiceLangs: [],
    });
    assert.equal(stt.last.language, 'multi');

    stt.last.say('¿Dónde está la estación?', ['es', 'es', 'es', 'es']);
    stt.last.say('Is it far?', ['en', 'en', 'en']);
    await settle();

    const [theirs, mine] = client.of('utterance');
    assert.equal(theirs?.speakerId, 'them');
    assert.equal(theirs?.lang, 'es');
    assert.equal(mine?.speakerId, 'me');
    assert.equal(mine?.lang, 'en-US');

    const done = client.of('translation').filter((m) => m.done);
    assert.deepEqual(
      done.map((m) => [m.id, m.lang, m.text]),
      [
        [theirs?.id, 'en-US', '[en-US] ¿Dónde está la estación?'],
        [mine?.id, 'es', '[es] Is it far?'],
      ],
    );
    // Partial translations stream first, cumulatively.
    assert.ok(client.of('translation').some((m) => !m.done && m.id === theirs?.id));

    // The second translation sees the first utterance as context.
    assert.deepEqual(translator.requests[1]?.context, [
      { speaker: 'Person B', lang: 'es', text: '¿Dónde está la estación?' },
    ]);
  });

  it('uses Me/Them selection when the pair cannot be auto-detected', async () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'ko' });

    assert.equal(client.of('ready')[0]?.autoDetect, false);
    assert.equal(client.of('ready')[0]?.speaker, 'them');
    const themStream = stt.last;
    assert.equal(themStream.language, 'ko');

    client.send({ type: 'speaker', speaker: 'me' });
    assert.equal(themStream.closed, true);
    assert.equal(stt.last.language, 'en-US');

    client.send({ type: 'speaker', speaker: 'auto' });
    assert.equal(client.of('error').at(-1)?.fatal, false);
    assert.equal(stt.streams.length, 2);

    stt.last.say('Nice to meet you');
    await settle();
    assert.equal(client.of('utterance')[0]?.speakerId, 'me');
    assert.equal(client.of('translation').at(-1)?.lang, 'ko');
  });

  it('only forwards audio after hello, in whole 16-bit samples', () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.session.handleAudio(pcm(3200));
    client.send({ type: 'hello', mode: 'solo', myLang: 'fr', theirLang: 'de' });
    client.session.handleAudio(pcm(3200));
    client.session.handleAudio(pcm(3201));
    assert.deepEqual(
      stt.last.audio.map((chunk) => chunk.length),
      [3200],
    );
  });

  it('drops audio arriving much faster than real time', () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'fr', theirLang: 'de' });
    // 60 seconds of audio at once: only the burst allowance gets through.
    for (let i = 0; i < 600; i++) client.session.handleAudio(pcm(3200));
    const seconds = stt.last.audio.length / 10;
    assert.ok(seconds >= 9 && seconds <= 11, `forwarded ${seconds}s`);
  });

  it('flush finalizes the recognizer (push-to-talk release)', () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'fr', theirLang: 'de' });
    client.send({ type: 'flush' });
    assert.equal(stt.last.finalized, 1);
  });

  it('skips distant speech when the phone asks, and translates it if the phone accepts it', async () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', nearbyOnly: true });
    const tenth = (value: number) => Buffer.from(new Int16Array(1600).fill(value).buffer);
    for (let i = 0; i < 30; i++) client.session.handleAudio(tenth(8000));
    for (let i = 0; i < 10; i++) client.session.handleAudio(tenth(500)); // 24 dB quieter
    for (const [i, text] of ['One', 'Two', 'Three'].entries()) stt.last.say(text, ['en'], { start: i, end: i + 1 });
    stt.last.say('Lejos', ['es'], { start: 3, end: 4 });
    await settle();

    assert.deepEqual(
      client.of('utterance').map((m) => m.text),
      ['One', 'Two', 'Three'],
    );
    const [skipped] = client.of('skipped');
    assert.deepEqual(skipped && [skipped.speakerId, skipped.lang, skipped.reason], ['them', 'es', 'distant']);
    assert.equal(skipped && 'text' in skipped, false, 'not its words');
    client.send({ type: 'accept', id: skipped?.id });
    client.send({ type: 'accept', id: 42 });
    await settle();
    assert.deepEqual(client.of('utterance').at(-1)?.text, 'Lejos');
    assert.equal(client.of('translation').filter((m) => m.done && m.id === skipped?.id).length, 1);
    assert.deepEqual(client.of('error'), []);
  });

  it('skips nothing while whoever talks holds a button', async () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', nearbyOnly: true });
    client.send({ type: 'talk-mode', mode: 'hold' });
    client.send({ type: 'talk-mode', mode: 42 });
    const tenth = (value: number) => Buffer.from(new Int16Array(1600).fill(value).buffer);
    for (let i = 0; i < 30; i++) client.session.handleAudio(tenth(8000));
    for (let i = 0; i < 10; i++) client.session.handleAudio(tenth(500)); // 24 dB quieter
    for (const [i, text] of ['One', 'Two', 'Three'].entries()) stt.last.say(text, ['en'], { start: i, end: i + 1 });
    stt.last.say('Lejos', ['es'], { start: 3, end: 4 });
    await settle();
    assert.deepEqual(
      client.of('utterance').map((m) => m.text),
      ['One', 'Two', 'Three', 'Lejos'],
    );
    assert.deepEqual([...client.of('skipped'), ...client.of('error')], []);
  });

  it('takes the requests to record their voice, which need voice prints the server does not have', () => {
    const { deps } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es' });
    client.send({ type: 'record-voice' });
    client.send({ type: 'stop-recording' });
    assert.deepEqual(client.of('error'), []);
    assert.deepEqual(client.of('voices'), []);
  });

  it('rejects two identical languages', () => {
    const { deps } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'en-GB' });
    assert.equal(client.of('error')[0]?.fatal, true);
    assert.equal(client.closed, true);
  });

  it('reports refused and failed translations without ending the session', async () => {
    const { deps, stt, translator } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es' });
    translator.failWith = new TranslationRefusedError();
    stt.last.say('Hello', ['en']);
    translator.failWith = new Error('socket hang up');
    stt.last.say('Hello again', ['en']);
    await settle();

    const [refused, failed] = client.of('translation');
    assert.equal(refused?.error, 'The translation service declined to translate this utterance.');
    assert.equal(failed?.error, 'Translation failed.');
    assert.equal(client.closed, false);
  });

  it('ends the session when speech recognition fails for good', () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es' });
    stt.last.events.onError(new Error('Deepgram rejected the API key.'), true);
    assert.deepEqual(client.of('error')[0], {
      type: 'error',
      message: 'Deepgram rejected the API key.',
      fatal: true,
    });
    assert.equal(client.closed, true);
    assert.equal(stt.last.closed, true);
  });

  it('stops translating once the phone disconnects', async () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es' });
    stt.last.say('Hello', ['en']);
    client.session.close();
    await settle();
    assert.equal(client.of('translation').length, 0);
  });
});

describe('natural voices', () => {
  const audio = (lang: string, text: string) => Buffer.from(`${lang}:${text}`).toString('base64');

  it('reads each finished translation aloud, after the text', async () => {
    const { deps, stt, synthesizer } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', voiceLangs: ['en-US', 'es'] });
    assert.deepEqual(client.of('ready')[0]?.voiceLangs, ['en-US', 'es']);

    stt.last.say('¿Dónde está la estación?', ['es', 'es', 'es', 'es']);
    stt.last.say('Is it far?', ['en', 'en', 'en']);
    await settle();

    const [theirs, mine] = client.of('utterance');
    assert.deepEqual(client.of('speech'), [
      { type: 'speech', id: theirs?.id, lang: 'en-US', audio: [audio('en-US', '[en-US] ¿Dónde está la estación?')] },
      { type: 'speech', id: mine?.id, lang: 'es', audio: [audio('es', '[es] Is it far?')] },
    ]);
    // Each voice follows the text of its translation.
    const translated = (id?: string) => client.messages.findIndex((m) => m.type === 'translation' && m.done && m.id === id);
    const spoken = (id?: string) => client.messages.findIndex((m) => m.type === 'speech' && m.id === id);
    for (const id of [theirs?.id, mine?.id]) assert.ok(translated(id) >= 0 && translated(id) < spoken(id));
    assert.deepEqual(
      synthesizer.requests.map((r) => [r.lang, r.text]),
      [
        ['en-US', '[en-US] ¿Dónde está la estación?'],
        ['es', '[es] Is it far?'],
      ],
    );
  });

  it('only voices the languages asked for that have a voice', async () => {
    const { deps, stt } = createDeps();
    const client = connect(deps);
    // No voice for Korean, and French is not in this conversation.
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'ko', voiceLangs: ['ko', 'en-US', 'fr'] });
    assert.deepEqual(client.of('ready')[0]?.voiceLangs, ['en-US']);

    stt.last.say('만나서 반가워요');
    await settle();
    client.send({ type: 'speaker', speaker: 'me' });
    stt.last.say('Nice to meet you too');
    await settle();

    assert.equal(client.of('translation').filter((m) => m.done).length, 2);
    assert.deepEqual(
      client.of('speech').map((m) => m.lang),
      ['en-US'],
    );
  });

  it('voices nothing when the phone asks for none or the server has no voices', async () => {
    for (const [overrides, voiceLangs] of [
      [{}, undefined],
      [{}, 'en-US'],
      [{ synthesizer: undefined }, ['en-US', 'es']],
    ] as const) {
      const { deps, stt, synthesizer } = createDeps(overrides);
      const client = connect(deps);
      client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', voiceLangs });
      assert.deepEqual(client.of('ready')[0]?.voiceLangs, []);
      stt.last.say('Hello', ['en']);
      await settle();
      assert.equal(client.of('translation').filter((m) => m.done).length, 1);
      assert.equal(client.of('speech').length, 0);
      assert.equal(synthesizer.requests.length, 0);
    }
  });

  it('reports a failed voice, so the phone reads the translation itself', async () => {
    const { deps, stt, synthesizer } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', voiceLangs: ['es'] });
    synthesizer.failWith = new SpeechError('The voice service is busy.');
    stt.last.say('Hello', ['en']);
    await settle();
    synthesizer.failWith = new Error('socket hang up');
    stt.last.say('Hello again', ['en']);
    await settle();

    const [first, second] = client.of('utterance');
    assert.deepEqual(client.of('speech'), [
      { type: 'speech', id: first?.id, lang: 'es', audio: [], error: 'The voice service is busy.' },
      { type: 'speech', id: second?.id, lang: 'es', audio: [], error: 'The voice failed.' },
    ]);
    assert.equal(client.of('translation').filter((m) => m.done).length, 2);
    assert.equal(client.closed, false);
  });

  it('does not voice a failed translation', async () => {
    const { deps, stt, translator, synthesizer } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', voiceLangs: ['es'] });
    translator.failWith = new Error('socket hang up');
    stt.last.say('Hello', ['en']);
    await settle();
    assert.equal(client.of('translation')[0]?.error, 'Translation failed.');
    assert.equal(client.of('speech').length, 0);
    assert.equal(synthesizer.requests.length, 0);
  });

  it('stops reading aloud once the phone disconnects', async () => {
    const { deps, stt, synthesizer } = createDeps();
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', voiceLangs: ['es'] });
    const release = synthesizer.hold();
    stt.last.say('Hello', ['en']);
    await settle();
    assert.equal(synthesizer.requests.length, 1);
    client.session.close();
    assert.equal(synthesizer.requests[0]?.signal?.aborted, true);
    release();
    await settle();
    assert.equal(client.of('speech').length, 0);
  });

  it('reads room translations aloud once per language, for the listeners who want it', async () => {
    const { deps, stt, synthesizer } = createDeps();
    const join = (name: string, lang: string, room?: string, voiceLangs?: string[]) => {
      const client = connect(deps);
      client.send({ type: 'hello', mode: 'room', name, lang, room, voiceLangs });
      return client;
    };
    const ann = join('Ann', 'en-US');
    const code = ann.of('ready')[0]?.room;
    const annStream = stt.last;
    const bea = join('Bea', 'es', code, ['es']);
    const carlos = join('Carlos', 'es', code);
    const didier = join('Didier', 'fr', code, ['fr']);
    const eun = join('Eun', 'ko', code, ['ko']);
    const fede = join('Fede', 'es', code, ['es']);
    assert.deepEqual(
      [ann, bea, carlos, didier, eun, fede].map((client) => client.of('ready')[0]?.voiceLangs),
      [[], ['es'], [], ['fr'], [], ['es']],
    );

    const release = synthesizer.hold();
    annStream.say('Hello everyone');
    await settle();
    // Fede leaves while the voices are being made.
    fede.session.close();
    release();
    await settle();

    assert.deepEqual(synthesizer.requests.map((r) => r.lang).sort(), ['es', 'fr']);
    const spoken = (client: typeof ann) => client.of('speech').map((m) => [m.lang, m.audio]);
    assert.deepEqual(spoken(bea), [['es', [audio('es', '[es] Hello everyone')]]]);
    assert.deepEqual(spoken(didier), [['fr', [audio('fr', '[fr] Hello everyone')]]]);
    assert.deepEqual(spoken(carlos), [], 'did not ask for a voice');
    assert.deepEqual(spoken(eun), [], 'no voice for Korean');
    assert.deepEqual(spoken(fede), [], 'left');
    assert.deepEqual(spoken(ann), []);
  });
});

describe('access code', () => {
  for (const [label, token] of [
    ['missing', undefined],
    ['wrong', 'guess'],
  ] as const) {
    it(`refuses a ${label} access code`, () => {
      const { deps } = createDeps({ accessToken: 'open-sesame' });
      const client = connect(deps);
      client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', token });
      assert.equal(client.of('error')[0]?.code, 'unauthorized');
      assert.equal(client.closed, true);
    });
  }

  it('accepts the right access code', () => {
    const { deps } = createDeps({ accessToken: 'open-sesame' });
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'solo', myLang: 'en-US', theirLang: 'es', token: 'open-sesame' });
    assert.equal(client.of('ready').length, 1);
  });
});

describe('room (everyone on their own phone)', () => {
  function joinRoom(deps: ReturnType<typeof createDeps>['deps'], name: string, lang: string, room?: string) {
    const client = connect(deps);
    client.send({ type: 'hello', mode: 'room', name, lang, room });
    return client;
  }

  it('translates each utterance once per listening language', async () => {
    const { deps, stt, translator } = createDeps();
    const ann = joinRoom(deps, 'Ann', 'en-US');
    const code = ann.of('ready')[0]?.room;
    assert.match(code ?? '', /^[A-Z2-9]{6}$/);
    const annStream = stt.last;

    const bea = joinRoom(deps, 'Bea', 'es', code?.toLowerCase());
    const carlos = joinRoom(deps, 'Carlos', 'es', code);
    const didier = joinRoom(deps, 'Didier', 'fr', code);
    const ed = joinRoom(deps, 'Ed', 'en-GB', code);
    assert.deepEqual(
      ed.of('participants').at(-1)?.participants.map((p) => p.name),
      ['Ann', 'Bea', 'Carlos', 'Didier', 'Ed'],
    );

    annStream.hear('Hello every');
    annStream.say('Hello everyone');
    await settle();

    for (const client of [ann, bea, carlos, didier, ed]) {
      assert.equal(client.of('utterance')[0]?.text, 'Hello everyone');
      assert.equal(client.of('interim')[0]?.text, 'Hello every');
    }
    assert.deepEqual(translator.requests.map((r) => r.targetLang).sort(), ['es', 'fr']);
    const final = (client: typeof ann) => client.of('translation').filter((m) => m.done).map((m) => m.text);
    assert.deepEqual(final(bea), ['[es] Hello everyone']);
    assert.deepEqual(final(carlos), ['[es] Hello everyone']);
    assert.deepEqual(final(didier), ['[fr] Hello everyone']);
    assert.deepEqual(final(ann), []);
    assert.deepEqual(final(ed), [], 'same language: heard directly');
  });

  it('tells the others when someone leaves', () => {
    const { deps } = createDeps();
    const ann = joinRoom(deps, 'Ann', 'en-US');
    const bea = joinRoom(deps, 'Bea', 'es', ann.of('ready')[0]?.room);
    bea.session.close();
    assert.deepEqual(
      ann.of('participants').at(-1)?.participants.map((p) => p.name),
      ['Ann'],
    );
  });

  it('keeps an empty room joinable for a while', () => {
    const { deps } = createDeps();
    const ann = joinRoom(deps, 'Ann', 'en-US');
    const code = ann.of('ready')[0]?.room;
    ann.session.close();
    const again = joinRoom(deps, 'Ann', 'en-US', code);
    assert.equal(again.of('ready')[0]?.room, code);
  });

  it('refuses unknown and malformed room codes', () => {
    const { deps } = createDeps();
    const unknown = joinRoom(deps, 'Bea', 'es', 'ABCDEF');
    assert.equal(unknown.of('error')[0]?.code, 'room_not_found');
    assert.equal(unknown.closed, true);
    const malformed = joinRoom(deps, 'Bea', 'es', '<script>');
    assert.equal(malformed.of('error')[0]?.code, 'room_not_found');
  });

  it('refuses to grow past ten people', () => {
    const { deps } = createDeps();
    const code = joinRoom(deps, 'Host', 'en-US').of('ready')[0]?.room;
    for (let i = 0; i < 9; i++) joinRoom(deps, `Guest ${i}`, 'es', code);
    const late = joinRoom(deps, 'Late', 'fr', code);
    assert.match(late.of('error')[0]?.message ?? '', /full/);
  });
});

describe('sanitizeName', () => {
  it('strips markup, control and bidi characters and caps the length', () => {
    assert.equal(sanitizeName('  <b>Zoë</b>\n '), 'bZoë/b');
    assert.equal(sanitizeName('‮evil'), 'evil');
    assert.equal(sanitizeName('x'.repeat(100)).length, 40);
    assert.equal(sanitizeName(''), 'Guest');
    assert.equal(sanitizeName(42), 'Guest');
  });
});
