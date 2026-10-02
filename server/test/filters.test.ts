import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeLanguages } from '../../shared/pipeline/language-filter.ts';
import { silentLogger } from '../../shared/pipeline/log.ts';
import { AudioHistory, LoudnessGate, speechLevel } from '../../shared/pipeline/loudness.ts';
import { SoloConversation } from '../../shared/pipeline/solo.ts';
import type { SoloOptions } from '../../shared/pipeline/solo.ts';
import { VoiceFilter, VoiceRecording } from '../../shared/pipeline/voices.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { FakeSttProvider, FakeTranslator, settle } from './fakes.ts';

const votes = (tags: Record<string, number>) => new Map(Object.entries(tags));

/** 16 kHz PCM16 of a constant value: as loud as `value`, and (for the fake voice printer) whose voice it is. */
function sound(seconds: number, value: number): Uint8Array {
  const samples = new Int16Array(Math.round(seconds * 16_000)).fill(value);
  return new Uint8Array(samples.buffer);
}

describe('telling languages apart', () => {
  it('attributes each side by the language of most of its words', () => {
    assert.equal(judgeLanguages(votes({ en: 5 }), 'en-US', 'ja'), 'me');
    assert.equal(judgeLanguages(votes({ ja: 4, en: 1 }), 'en-US', 'ja'), 'them');
    assert.equal(judgeLanguages(votes({ en: 5, ja: 1 }), 'en-US', 'ja'), 'me');
    // Untagged speech still goes to them, as before.
    assert.equal(judgeLanguages(votes({}), 'en-US', 'ja'), 'them');
  });

  it('skips speech mostly in a third language, but not a stray word', () => {
    assert.equal(judgeLanguages(votes({ es: 6 }), 'en-US', 'ja'), 'other');
    assert.equal(judgeLanguages(votes({ es: 3, en: 2 }), 'en-US', 'ja'), 'other');
    assert.equal(judgeLanguages(votes({ es: 1 }), 'en-US', 'ja'), 'them');
    assert.equal(judgeLanguages(votes({ es: 2, en: 2 }), 'en-US', 'ja'), 'me');
  });

  it('counts languages the recognizer confuses with one side as that side', () => {
    assert.equal(judgeLanguages(votes({ es: 2, pt: 3 }), 'en-US', 'es'), 'them');
    assert.equal(judgeLanguages(votes({ nl: 4 }), 'de', 'ja'), 'me');
    // Related to both sides: still ours, though it cannot say who spoke.
    assert.equal(judgeLanguages(votes({ it: 5 }), 'es', 'pt-BR'), 'them');
    assert.equal(judgeLanguages(votes({ it: 5, es: 1 }), 'es', 'pt-BR'), 'me');
  });
});

describe('loudness', () => {
  it('keeps the last stretch of audio and returns any part of it', () => {
    const history = new AudioHistory(1);
    for (let i = 1; i <= 15; i++) history.append(sound(0.1, i));
    assert.equal(history.now, 1.5);
    const part = history.slice(1.15, 1.35);
    assert.equal(part.length, 3200);
    assert.deepEqual([part[0], part[799], part[800], part[2399], part[2400], part[3199]], [12, 12, 13, 13, 14, 14]);
    // Older audio is gone.
    assert.equal(history.slice(0, 0.5).length, 0);
    assert.equal(history.slice(0.45, 0.55)[0], 6);
  });

  it('measures speech by its louder parts, not the pauses', () => {
    const quiet = speechLevel(new Int16Array(sound(1, 1000).buffer))!;
    const loud = speechLevel(new Int16Array(sound(1, 4000).buffer))!;
    assert.ok(Math.abs(loud - quiet - 12) < 0.1);
    const withPauses = new Int16Array(16_000);
    withPauses.fill(4000, 0, 9600);
    assert.ok(Math.abs(speechLevel(withPauses)! - loud) < 0.1);
    assert.equal(speechLevel(new Int16Array(1000)), undefined);
  });

  it('learns how loud each side is and refuses much quieter speech', () => {
    const gate = new LoudnessGate();
    assert.equal(gate.accepts('me', -60, 0), true, 'nothing to compare with yet');
    for (const level of [-20, -22, -21]) gate.learn('me', level, 1);
    assert.equal(gate.accepts('me', -30, 2), true);
    assert.equal(gate.accepts('me', -35, 2), false);
    // Their side is compared with mine, more leniently, until they have spoken a few times.
    assert.equal(gate.accepts('them', -38, 2), true);
    assert.equal(gate.accepts('them', -45, 2), false);
    for (const level of [-40, -41, -39]) gate.learn('them', level, 3);
    assert.equal(gate.accepts('them', -50, 4), true);
    // Levels are forgotten after a few minutes of listening.
    assert.equal(gate.accepts('me', -60, 1 + 181), true);
  });

  it('lets speech as quiet as one translated after all through from then on', () => {
    const gate = new LoudnessGate();
    for (const level of [-20, -22, -21]) gate.learn('them', level, 1);
    assert.equal(gate.accepts('them', -40, 2), false);
    gate.allow('them', -40, 2);
    assert.equal(gate.accepts('them', -45, 3), true);
    assert.equal(gate.accepts('them', -55, 3), false);
    assert.equal(gate.accepts('me', -45, 3), true, 'compared with them until I have spoken');
  });
});

/** A voice print for each fake voice, told by the value of its samples. */
const VOICES: Record<number, number[]> = {
  1000: [1, 0, 0],
  2000: [0, 1, 0],
  3000: [0, 0, 1],
  4000: [0, 0.8, 0.6],
  5000: [0.3, 0, 0.954],
};
const printer = {
  mine: new Float32Array(VOICES[1000]!),
  print: async (samples: Int16Array) => {
    const print = VOICES[samples[Math.floor(samples.length / 2)]!];
    return print && new Float32Array(print);
  },
};

describe('voices', () => {
  const print = (value: number) => new Float32Array(VOICES[value]!);

  it('lets my voice through for either side, and learns theirs from the first long-enough thing they say', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.admits('me', print(1000), 2), true);
    assert.equal(voices.admits('them', print(1000), 2), true);
    // A stranger speaking my language before the other person is known.
    assert.equal(voices.admits('me', print(3000), 2), false);
    // Too short to learn from: let through, but not learned.
    assert.equal(voices.admits('them', print(3000), 0.8), true);
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.admits('them', print(3000), 2), false);
    assert.equal(voices.admits('me', print(2000), 2), true, 'they may speak my language');
    assert.equal(voices.admits('them', print(4000), 2), true, 'a similar voice');
  });

  it('does not learn their voice from one rather like mine', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.admits('them', print(5000), 2), true);
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.admits('them', print(5000), 2), false);
  });

  it('learns the other person afresh when told', () => {
    const voices = new VoiceFilter(printer);
    voices.admits('them', print(2000), 2);
    voices.learnPartner(print(3000));
    assert.equal(voices.admits('them', print(2000), 2), false);
    assert.equal(voices.admits('them', print(3000), 2), true);
    voices.forgetPartner();
    assert.equal(voices.admits('them', print(2000), 2), true);
  });

  it('does not check speech too short to tell', async () => {
    const voices = new VoiceFilter(printer);
    assert.equal(await voices.printOf(new Int16Array(sound(0.5, 3000).buffer)), undefined);
    assert.deepEqual([...(await voices.printOf(new Int16Array(sound(1, 3000).buffer)))!], [0, 0, 1]);
  });

  it('records my voice without the pauses, nor the noise around', () => {
    const recording = new VoiceRecording();
    const record = (seconds: number, value: number) => {
      for (let i = 0; i < seconds * 10; i++) recording.add(new Int16Array(sound(0.1, value).buffer));
    };
    record(0.5, 300); // the café
    record(2, 3000);
    record(0.5, 300);
    record(1, 3000);
    record(0.4, 600); // a cup set down
    assert.equal(recording.speechSeconds, 3);
    const speech = recording.speech();
    assert.equal(speech.length, 3 * 16_000);
    assert.ok(speech.every((sample) => sample === 3000));
  });

  it('does not take a quiet room for speech', () => {
    const recording = new VoiceRecording();
    for (let i = 0; i < 30; i++) recording.add(new Int16Array(sound(0.1, i % 2 ? 40 : 10).buffer));
    assert.equal(recording.speechSeconds, 0);
    assert.equal(recording.speech().length, 0);
  });
});

function soloSetup(options: Partial<SoloOptions> = {}) {
  const stt = new FakeSttProvider();
  const translator = new FakeTranslator();
  const messages: ServerMessage[] = [];
  let ids = 0;
  const solo = new SoloConversation({
    myLang: 'en-US',
    theirLang: 'ja',
    voiceLangs: [],
    stt,
    translator,
    synthesizer: undefined,
    send: (message) => messages.push(message),
    onFatal: (error) => assert.fail(error),
    log: silentLogger,
    newId: () => `u${++ids}`,
    ...options,
  });
  solo.start();
  const of = <T extends ServerMessage['type']>(type: T) =>
    messages.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  return { solo, stt, translator, messages, of };
}

describe('one phone in a noisy place', () => {
  it('skips speech in another language, unless asked to translate it', async () => {
    const { solo, stt, of } = soloSetup();
    stt.last.hear('Hola', ['es']);
    stt.last.hear('Hola, ¿qué tal', ['es', 'es', 'es']);
    stt.last.say('Hola, ¿qué tal?', ['es', 'es', 'es']);
    stt.last.say('Where is the station?', ['en', 'en', 'en', 'en']);
    await settle();

    assert.deepEqual(
      of('interim').map((m) => m.text),
      ['Hola', ''],
    );
    assert.deepEqual(of('skipped'), [
      { type: 'skipped', id: 'u1', speakerId: 'them', lang: 'es', text: 'Hola, ¿qué tal?', reason: 'language' },
    ]);
    assert.deepEqual(
      of('utterance').map((m) => [m.id, m.speakerId, m.text]),
      [['u2', 'me', 'Where is the station?']],
    );

    solo.accept('u1');
    solo.accept('u1');
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.id, m.speakerId, m.lang]),
      [
        ['u2', 'me', 'en-US'],
        ['u1', 'them', 'es'],
      ],
    );
    assert.deepEqual(
      of('translation')
        .filter((m) => m.done)
        .map((m) => [m.id, m.lang]),
      [
        ['u2', 'ja'],
        ['u1', 'en-US'],
      ],
    );
  });

  it('skips speech much quieter than the people at the phone, when asked to', async () => {
    const { solo, stt, of } = soloSetup({ nearbyOnly: true });
    solo.sendAudio(sound(0.5, 0));
    for (let i = 0; i < 3; i++) solo.sendAudio(sound(1, 8000));
    solo.sendAudio(sound(1, 1000)); // 18 dB quieter
    stt.last.say('One', ['en'], { start: 0.5, end: 1.5 });
    stt.last.say('Two', ['en'], { start: 1.5, end: 2.5 });
    stt.last.say('Three', ['en'], { start: 2.5, end: 3.5 });
    stt.last.hear('Far', ['en'], { start: 3.5, end: 4.5 });
    stt.last.say('Far away', ['en'], { start: 3.5, end: 4.5 });
    await settle();

    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One', 'Two', 'Three'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [m.text, m.reason]),
      [['Far away', 'distant']],
    );
    assert.equal(of('interim').length, 0, 'the far voice was never shown');

    // Translating it after all teaches that this is near enough.
    solo.accept(of('skipped')[0]!.id);
    solo.sendAudio(sound(1, 1000));
    stt.last.say('Still there', ['en'], { start: 4.5, end: 5.5 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One', 'Two', 'Three', 'Far away', 'Still there'],
    );
    assert.equal(of('skipped').length, 1);
  });

  it('times speech from the start of each recognizer stream', async () => {
    const { solo, stt, of } = soloSetup({ nearbyOnly: true });
    for (let i = 0; i < 3; i++) solo.sendAudio(sound(1, 8000));
    for (let i = 0; i < 3; i++) stt.last.say('Near', ['en'], { start: i, end: i + 1 });
    solo.setSpeaker('them');
    solo.sendAudio(sound(1, 8000));
    solo.sendAudio(sound(1, 500));
    // Seconds 3 to 4 of the conversation are 0 to 1 of the new stream.
    stt.last.say('近い', [], { start: 0, end: 1 });
    stt.last.say('遠い', [], { start: 1, end: 2 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Near', 'Near', 'Near', '近い'],
    );
    assert.deepEqual(
      of('skipped').map((m) => m.text),
      ['遠い'],
    );
  });

  it('only translates our two voices, in order', async () => {
    const { solo, stt, of } = soloSetup({ voices: printer });
    solo.sendAudio(sound(2, 1000)); // me
    solo.sendAudio(sound(2, 2000)); // them
    solo.sendAudio(sound(2, 3000)); // a stranger, or a song
    stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    stt.last.say('こんにちは', ['ja'], { start: 2, end: 4 });
    stt.last.say('Somebody else', ['en'], { start: 4, end: 6 });
    stt.last.say('Hola amigos', ['es', 'es'], { start: 4, end: 6 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [
        ['me', 'Hello'],
        ['them', 'こんにちは'],
      ],
    );
    assert.deepEqual(
      of('skipped').map((m) => [m.text, m.reason]),
      [
        ['Somebody else', 'voice'],
        ['Hola amigos', 'language'],
      ],
    );
  });

  it('learns a new partner from skipped speech that was them after all', async () => {
    const { solo, stt, of } = soloSetup({ voices: printer });
    solo.sendAudio(sound(2, 2000));
    solo.sendAudio(sound(2, 3000));
    solo.sendAudio(sound(2, 3000));
    stt.last.say('はい', ['ja'], { start: 0, end: 2 });
    stt.last.say('いらっしゃいませ', ['ja'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(
      of('skipped').map((m) => m.text),
      ['いらっしゃいませ'],
    );
    solo.accept(of('skipped')[0]!.id);
    stt.last.say('どうぞ', ['ja'], { start: 4, end: 6 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['はい', 'いらっしゃいませ', 'どうぞ'],
    );
  });
});
