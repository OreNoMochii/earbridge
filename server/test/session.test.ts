import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeName } from '../src/session.ts';
import { TranslationRefusedError } from '../src/translate/types.ts';
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
