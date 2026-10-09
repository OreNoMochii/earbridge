import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DirectionFilter, headingOf } from '../../shared/pipeline/direction.ts';
import { judgeLanguages } from '../../shared/pipeline/language-filter.ts';
import { silentLogger } from '../../shared/pipeline/log.ts';
import { AudioHistory, LoudnessGate, NoisyPlace, speechLevel } from '../../shared/pipeline/loudness.ts';
import type { TalkReportEntry } from '../../shared/pipeline/report.ts';
import { SoloConversation } from '../../shared/pipeline/solo.ts';
import type { SoloOptions } from '../../shared/pipeline/solo.ts';
import { PartnerRecording, VoiceFilter, VoiceRecording } from '../../shared/pipeline/voices.ts';
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

  it('measures how far speech stands above the place, once it has heard enough of it', () => {
    const place = new NoisyPlace();
    // The phone's microphone muted while it talks is not the place.
    place.append(sound(5, 0));
    place.append(sound(9, 1000));
    assert.equal(place.margin({ start: 0, end: 14 }), undefined, 'under 10 s of the place');
    assert.equal(place.margin(undefined), undefined);
    place.append(sound(1, 1000));
    place.append(sound(2, 4000));
    assert.equal(place.now, 17);
    const timed = place.margin({ start: 14.9, end: 17.1 })!;
    assert.equal(timed.timed, true);
    assert.ok(Math.abs(timed.db - 12) < 0.1, `${timed.db}`);
    // Without word timings, from the loudest of the last seconds.
    const untimed = place.margin(undefined)!;
    assert.equal(untimed.timed, false);
    assert.ok(Math.abs(untimed.db - 12) < 0.1, `${untimed.db}`);
    assert.equal(place.margin({ start: 16.9, end: 17.1 }), undefined, 'too short to tell');
  });

  it('judges the place by its last half minute', () => {
    const place = new NoisyPlace();
    place.append(sound(30, 500));
    // It got louder.
    place.append(sound(31, 1000));
    place.append(sound(2, 4000));
    assert.equal(place.now, 63);
    const margin = place.margin({ start: 61, end: 63 })!;
    assert.ok(Math.abs(margin.db - 12) < 0.1, `${margin.db}`);
  });

  it('finds it too loud once the latest things one of us said barely stood out', () => {
    const timed = (db: number) => ({ db, timed: true });
    const place = new NoisyPlace();
    for (let i = 0; i < 3; i++) {
      place.hear('me', timed(5));
      place.hear('them', timed(5));
    }
    assert.equal(place.tooLoud, false, 'too little of either side');
    place.hear('them', timed(5));
    assert.equal(place.tooLoud, true);

    // By the middle of the latest four: one odd one does not decide.
    const odd = new NoisyPlace();
    for (const db of [12, 12, 12, 2]) odd.hear('me', timed(db));
    assert.equal(odd.tooLoud, false);
    for (const db of [5, 5, 5, 20]) odd.hear('me', timed(db));
    assert.equal(odd.tooLoud, true);

    // Without word timings, both sides together, which need to stand out a little more.
    const enough = new NoisyPlace();
    for (let i = 0; i < 4; i++) enough.hear('me', timed(8.5));
    assert.equal(enough.tooLoud, false);
    const untimed = new NoisyPlace();
    for (const side of ['me', 'them', 'me']) untimed.hear(side, { db: 8.5, timed: false });
    assert.equal(untimed.tooLoud, false);
    untimed.hear('them', { db: 8.5, timed: false });
    assert.equal(untimed.tooLoud, true);
  });
});

/** A voice print for each fake voice, told by the value of its samples. */
const VOICES: Record<number, number[]> = {
  1000: [1, 0, 0],
  2000: [0, 1, 0],
  3000: [0, 0, 1],
  4000: [0, 0.8, 0.6],
  5000: [0.3, 0, 0.954],
  6000: [0, 0, -1],
  7000: [0.6, 0, 0.8],
  8000: [0, 0.95, 0.3122],
  9000: [-0.3, 0.7, 0.648],
  10000: [0.3, 0.8, -0.52],
};
const printer = {
  mine: new Float32Array(VOICES[1000]!),
  print: async (samples: Int16Array) => {
    const print = VOICES[samples[Math.floor(samples.length / 2)]!];
    return print && new Float32Array(print);
  },
};
const print = (value: number) => new Float32Array(VOICES[value]!);

describe('voices', () => {
  it('lets only my voice through until theirs is recorded, and takes no other voice for theirs', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.admits('me', print(1000), 2), true);
    assert.equal(voices.admits('them', print(1000), 2), true);
    // Whoever talks for them is not taken for them, however long they talk.
    assert.equal(voices.admits('them', print(2000), 2), false);
    assert.equal(voices.admits('them', print(2000), 6), false);
    assert.equal(voices.admits('me', print(3000), 2), false);
    assert.equal(voices.recognizes(print(2000)), false);
    assert.equal(voices.partner, 'unknown');
    voices.setPartner(print(2000));
    assert.equal(voices.partner, 'recorded');
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.admits('them', print(4000), 2), true, 'a similar voice');
    assert.equal(voices.admits('them', print(3000), 2), false);
    assert.equal(voices.admits('me', print(2000), 2), false, 'what is said for me is in my voice');
    assert.equal(voices.recognizes(print(2000)), true);
    assert.equal(voices.recognizes(print(2000), 'me'), false);
  });

  it('takes their voice afresh from a new recording, forgetting how the last one sounded here', () => {
    const voices = new VoiceFilter(printer);
    voices.setPartner(print(2000));
    assert.equal(voices.admits('them', print(4000), 2), true);
    assert.equal(voices.admits('them', print(3000), 2), true, 'like their voice as heard here');
    voices.setPartner(print(6000));
    assert.equal(voices.admits('them', print(3000), 2), false);
    assert.equal(voices.admits('them', print(2000), 2), false);
    assert.equal(voices.admits('them', print(6000), 2), true);
  });

  it('learns how their voice sounds here only from what their recording itself tells', () => {
    const voices = new VoiceFilter(printer);
    voices.setPartner(print(3000));
    assert.equal(voices.admits('them', print(4000), 2), true);
    // Taken for theirs only by how it sounded here: learning from it would drift toward other voices.
    assert.equal(voices.admits('them', print(8000), 2), true);
    assert.equal(voices.admits('them', print(10000), 2), false);
  });

  it('learns their voice as heard here from what was translated after all, only once it is recorded', () => {
    const voices = new VoiceFilter(printer);
    voices.learn('them', print(3000), 2);
    assert.equal(voices.admits('them', print(3000), 2), false, 'not recorded');
    voices.setPartner(print(3000));
    // Nothing like their recording: someone else, translated only to see what they said.
    voices.learn('them', print(2000), 2);
    assert.equal(voices.admits('them', print(2000), 2), false);
    // Rather like it: them, sounding different here.
    voices.learn('them', print(8000), 2);
    assert.equal(voices.admits('them', print(2000), 2), true);
  });

  it('learns my voice as heard here from speech known to be mine some other way', () => {
    const voices = new VoiceFilter(printer);
    // My voice in a noisy place: rather like my recording, but not enough.
    assert.equal(voices.admits('me', print(5000), 2), false);
    voices.learn('me', print(5000), 1);
    assert.equal(voices.admits('me', print(5000), 2), false, 'too short to learn from');
    voices.learn('me', print(5000), 2);
    assert.equal(voices.admits('me', print(5000), 2), true);
    assert.equal(voices.recognizes(print(5000)), true);
    // Nothing unlike my recording is learned as mine.
    voices.learn('me', print(2000), 2);
    assert.equal(voices.recognizes(print(2000)), false);
  });

  it('learns how my voice sounds here from what is clearly mine', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.admits('me', print(5000), 2), false);
    assert.equal(voices.admits('me', print(7000), 1), true);
    assert.equal(voices.admits('me', print(5000), 2), false, 'too short to learn from');
    assert.equal(voices.admits('me', print(7000), 2), true);
    assert.equal(voices.admits('me', print(5000), 2), true);
  });

  it('learns how my voice sounds here only from what my recording itself tells', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.admits('me', print(7000), 2), true);
    // Taken for mine only by how it sounded here: learning from it would drift toward other voices.
    assert.equal(voices.admits('me', print(5000), 2), true);
    assert.equal(voices.admits('me', print(9000), 2), false);
  });

  it('makes no voice print of speech too short to tell whose it is', async () => {
    const voices = new VoiceFilter(printer);
    assert.equal(await voices.printOf(new Int16Array(sound(0.4, 3000).buffer)), undefined);
    assert.deepEqual([...(await voices.printOf(new Int16Array(sound(0.5, 3000).buffer)))!], [0, 0, 1]);
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

describe('recording their voice', () => {
  function setup(voices = new VoiceFilter(printer)) {
    /** How it went: the seconds of their voice so far, with what is going wrong, then how it ended. */
    const events: string[] = [];
    const recording = new PartnerRecording(
      voices,
      {
        progress: ({ seconds, hint }) => events.push(hint ? `${seconds} ${hint}` : `${seconds}`),
        done: (failed) => events.push(failed ? `failed: ${failed}` : 'recorded'),
      },
      silentLogger,
    );
    /** Some seconds of a voice, or of the background, as the microphone sends it; each part is checked at once. */
    const hear = async (seconds: number, value: number) => {
      for (let i = 0; i < Math.round(seconds * 10); i++) {
        recording.add(sound(0.1, value));
        await settle();
      }
    };
    return { voices, recording, events, hear };
  }

  it('records their voice from six seconds of it, leaving out the pauses', async () => {
    const { voices, recording, events, hear } = setup();
    assert.deepEqual(recording.progress, { seconds: 0, of: 6 });
    await hear(1, 100); // the café
    await hear(2.5, 3000);
    await hear(0.5, 100);
    await hear(3.5, 3000);
    await hear(1, 3000); // once it is done
    assert.deepEqual(events, ['0', '1', '2', '3', '4', '5', '6', 'recorded']);
    assert.equal(voices.partner, 'recorded');
    assert.equal(voices.admits('them', print(3000), 2), true);
    assert.equal(voices.admits('them', print(2000), 2), false);
  });

  it('leaves out my voice, and says so', async () => {
    const { voices, events, hear } = setup();
    await hear(1, 100);
    await hear(2, 1000); // me, explaining what to do
    await hear(6, 3000);
    assert.deepEqual(events, ['0', '1', '2', '0 mine', '1 mine', '2 mine', '2', '3', '4', '5', '6', 'recorded']);
    assert.equal(voices.admits('them', print(3000), 2), true);
    assert.equal(voices.admits('them', print(1000), 2), true, 'mine, still');
  });

  it('skips the silence sent in place of the microphone while the phone talks', async () => {
    const { events, hear } = setup();
    await hear(1, 100);
    await hear(40, 0);
    await hear(6, 3000);
    assert.deepEqual(events, ['0', '1', '2', '3', '4', '5', '6', 'recorded']);
  });

  it('gives up after half a minute of too little of their voice', async () => {
    const quiet = setup();
    await quiet.hear(30, 100);
    assert.deepEqual(quiet.events, ['0', '0 quiet', 'failed: quiet']);
    assert.equal(quiet.voices.partner, 'unknown');

    const mine = setup();
    await mine.hear(1, 100);
    await mine.hear(4, 1000);
    await mine.hear(25, 100);
    assert.deepEqual(mine.events, ['0', '1', '2', '0 mine', '1 mine', '2 mine', '0 mine', 'failed: mine']);
    assert.equal(mine.voices.partner, 'unknown');
  });

  it('makes do with three seconds of their voice when it gives up', async () => {
    const { voices, events, hear } = setup();
    await hear(1, 100);
    await hear(3.5, 3000);
    await hear(25.5, 100);
    assert.deepEqual(events, ['0', '1', '2', '3', 'recorded']);
    assert.equal(voices.partner, 'recorded');
  });

  it('stops without a word, leaving what was known of their voice', async () => {
    const voices = new VoiceFilter(printer);
    voices.setPartner(print(2000));
    const { recording, events, hear } = setup(voices);
    assert.equal(voices.admits('them', print(3000), 2), false, 'only recorded voices, meanwhile too');
    await hear(1, 100);
    // Stopped while a part is being checked.
    for (let i = 0; i < 20; i++) recording.add(sound(0.1, 3000));
    recording.stop();
    await settle();
    await hear(6, 3000);
    assert.deepEqual(events, ['0', '1', '2']);
    assert.equal(voices.partner, 'recorded');
    assert.equal(voices.admits('them', print(3000), 2), false);
    assert.equal(voices.admits('them', print(2000), 2), true);
  });

  it('fails, rather than waits forever, when voice prints do', async () => {
    const broken = new VoiceFilter({
      mine: printer.mine,
      print: async () => {
        throw new Error('out of memory');
      },
    });
    const { events, hear } = setup(broken);
    await hear(1, 100);
    await hear(2, 3000);
    assert.deepEqual(events, ['0', '1', '2', 'failed: quiet']);
    assert.equal(broken.partner, 'unknown');
  });
});

describe('directions', () => {
  const moment = (delay: number, clarity = 0.8) => ({ delay, clarity });
  const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual}`);

  it('finds the direction most of some speech came from', () => {
    near(headingOf([moment(5), moment(5.5), moment(4.5), moment(-3, 0.3), moment(0, 0.1)]), 5);
    // Chatter from all around.
    assert.equal(headingOf([moment(5, 0.1), moment(-2, 0.15), moment(1, 0.1), moment(3, 0.05)]), undefined);
    assert.equal(headingOf([moment(5), moment(5)]), undefined, 'too little to tell');
    // Several people at once, from all sides.
    assert.equal(headingOf([moment(-6), moment(-3), moment(0), moment(3), moment(6)]), undefined);
  });

  it('learns where the two people sit and tells voices from the sides', () => {
    const filter = new DirectionFilter();
    assert.equal(filter.judge(0), undefined, 'nothing known yet');
    filter.learn('me', -5);
    filter.learn('me', -4.5);
    assert.equal(filter.judge(-5), 'me');
    assert.equal(filter.judge(0), undefined, 'only where I sit is known');
    filter.learn('them', 5);
    filter.learn('them', 5.5);
    assert.deepEqual([filter.judge(0), filter.judge(3), filter.judge(-2)], ['between', 'between', 'between']);
    assert.deepEqual([filter.judge(-4), filter.judge(-7), filter.judge(4), filter.judge(7)], ['me', 'me', 'them', 'them']);
    // Speech from where they sit does not teach where I do.
    filter.learn('me', 5);
    filter.learn('me', 5);
    assert.deepEqual([filter.judge(-5), filter.judge(0)], ['me', 'between']);
  });

  it('learns nothing from the sides of the phone, nor from odd speech from its other end', () => {
    const filter = new DirectionFilter();
    // Someone passing by, taken for them, then them.
    for (const delay of [0.5, -1.5, 5, 5]) filter.learn('them', delay);
    // Them answering in my language, taken for me, then me.
    for (const delay of [5.5, -5, -5]) filter.learn('me', delay);
    assert.deepEqual([filter.judge(0.5), filter.judge(-1.5), filter.judge(5.5), filter.judge(-5)], ['between', 'between', 'them', 'me']);
  });

  it('cannot tell anyone else from the two people unless they sit at the two ends', () => {
    // The phone lies across the table.
    const across = new DirectionFilter();
    for (const delay of [1.5, 1.5]) across.learn('them', delay);
    for (const delay of [-1.5, -1.5]) across.learn('me', delay);
    assert.deepEqual([across.judge(-1.5), across.judge(0), across.judge(6)], [undefined, undefined, undefined]);
    // Both at the same end.
    const ahead = new DirectionFilter();
    for (const delay of [2, 2]) ahead.learn('me', delay);
    for (const delay of [7, 7]) ahead.learn('them', delay);
    assert.deepEqual([ahead.judge(4.5), ahead.judge(-4)], [undefined, undefined]);
  });

  it('learns afresh when told, and forgets everything when the phone moves', () => {
    const filter = new DirectionFilter();
    filter.hear(0, { pose: 1 });
    for (const delay of [-5, -5]) filter.learn('me', delay);
    for (const delay of [5, 5]) filter.learn('them', delay);
    assert.equal(filter.judge(0.5), 'between');
    // That was them: they moved, nearer a side.
    filter.correct('them', 2.5);
    assert.equal(filter.judge(0.5), undefined);
    filter.learn('them', 2.5);
    assert.deepEqual([filter.judge(2.5), filter.judge(-2), filter.judge(-4)], ['them', 'between', 'me']);
    // Now they sit at a side, where nobody can be told from them.
    filter.correct('them', 0.5);
    filter.learn('them', 0.5);
    filter.learn('them', 0.5);
    assert.deepEqual([filter.judge(0.5), filter.judge(-1), filter.judge(-4)], [undefined, undefined, 'me']);
    filter.hear(1, { pose: 2 });
    assert.deepEqual([filter.judge(5), filter.judge(-4)], [undefined, undefined]);
  });

  it('times directions on the audio clock and keeps half a minute of them', () => {
    const filter = new DirectionFilter();
    for (let i = 0; i < 400; i++) filter.hear(i * 0.1, { pose: 0, direction: moment(i < 100 ? -5 : 5) });
    assert.equal(filter.headingBetween(0, 9), undefined, 'forgotten');
    near(filter.headingBetween(15, 20), 5);
    // A direction only now and then, as with a quiet voice: not enough.
    assert.equal(filter.headingBetween(39.85, 50), undefined);
  });
});

/**
 * One second (or more) of a voice from one direction, in 100 ms chunks, as a phone recording
 * two microphones tells it; with no delay, from no clear direction.
 */
function sendFrom(solo: SoloConversation, delay: number | undefined, { seconds = 1, voice = 1000, pose = 0 } = {}): void {
  for (let i = 0; i < seconds * 10; i++) {
    solo.sendAudio(sound(0.1, voice), delay === undefined ? { pose } : { pose, direction: { delay, clarity: 0.8 } });
  }
}

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
  /** What was said in an utterance, from its id, whether or not the phone was told (as `skipped` does not). */
  const words = (m: { id: string }) => stt.said[Number(m.id.slice(1)) - 1];
  /** The live captions sent, including the empty ones that stop showing one. */
  const captions = () => of('interim').map((m) => m.text);
  return { solo, stt, translator, messages, of, words, captions };
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
    // Without its words.
    assert.deepEqual(of('skipped'), [{ type: 'skipped', id: 'u1', speakerId: 'them', lang: 'es', reason: 'language' }]);
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
    const { solo, stt, of, words } = soloSetup({ nearbyOnly: true });
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
      of('skipped').map((m) => [words(m), m.reason]),
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

  it('says once when the recognizer does not time words, then shows what it hears', async () => {
    const { solo, stt, of, captions } = soloSetup({ nearbyOnly: true });
    solo.sendAudio(sound(3, 3000));
    stt.last.hear('Hello', ['en']);
    stt.last.say('Hello there', ['en', 'en']);
    stt.last.say('How are you?', ['en', 'en', 'en']);
    stt.last.hear('Fine', ['en']);
    stt.last.say('Fine, thanks', ['en', 'en']);
    await settle();
    assert.deepEqual(
      of('error').map((m) => [m.message.includes('noisy-place filters'), m.fatal]),
      [[true, false]],
    );
    assert.deepEqual(captions(), ['Hello', 'Fine']);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Hello there', 'How are you?', 'Fine, thanks'],
    );

    // Nothing to say when it does, or when nothing needs the timings.
    const timed = soloSetup({ nearbyOnly: true });
    timed.solo.sendAudio(sound(2, 8000));
    timed.stt.last.say('One', ['en'], { start: 0, end: 1 });
    timed.stt.last.say('Two', ['en']);
    timed.stt.last.say('Three', ['en']);
    const plain = soloSetup();
    plain.stt.last.say('One', ['en']);
    plain.stt.last.say('Two', ['en']);
    await settle();
    assert.deepEqual([...timed.of('error'), ...plain.of('error')], []);
  });

  it('shows nothing a recognizer did not time when only recorded voices count, and says why once', async () => {
    const { solo, stt, of, words, captions } = soloSetup({ nearbyOnly: true, voices: printer });
    solo.usePartner(print(2000));
    solo.sendAudio(sound(3, 1000));
    stt.last.hear('Hello', ['en']);
    stt.last.say('Hello there', ['en', 'en']);
    stt.last.hear('How', ['en']);
    stt.last.say('How are you?', ['en', 'en', 'en']);
    stt.last.hear('Fine', ['en']);
    stt.last.say('Fine, thanks', ['en', 'en']);
    await settle();
    assert.deepEqual(
      of('error').map((m) => [m.message.includes('Voices can’t be checked'), m.fatal]),
      [[true, false]],
    );
    assert.deepEqual(captions(), []);
    assert.deepEqual(of('utterance'), []);
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Hello there', 'untimed'],
        ['How are you?', 'untimed'],
        ['Fine, thanks', 'untimed'],
      ],
    );
    // Translated when tapped, all the same.
    solo.accept(of('skipped')[1]!.id);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['How are you?'],
    );
  });

  it('times speech from the start of each recognizer stream', async () => {
    const { solo, stt, of, words } = soloSetup({ nearbyOnly: true });
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
      of('skipped').map(words),
      ['遠い'],
    );
  });

  it('only translates our two voices, in order', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.usePartner(print(2000));
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
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Somebody else', 'voice'],
        ['Hola amigos', 'language'],
      ],
    );
  });

  it('keeps their voice when told they are talking', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.usePartner(print(2000));
    solo.sendAudio(sound(2, 2000));
    stt.last.say('はい', ['ja'], { start: 0, end: 2 });
    await settle();
    solo.setSpeaker('them');
    solo.sendAudio(sound(2, 3000));
    stt.last.say('いらっしゃいませ', [], { start: 0, end: 2 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['はい'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['いらっしゃいませ', 'voice']],
    );
  });

  it('skips voices from the sides of a phone lying between us, unless told otherwise', async () => {
    const { solo, stt, of, words } = soloSetup({ directions: true });
    const lines: [string, string[], number][] = [
      ['Hello', ['en'], -5],
      ['こんにちは', ['ja'], 5],
      ['How are you?', ['en'], -5],
      ['元気です', ['ja'], 5],
      ['Two coffees please', ['en'], 0],
      ['いらっしゃいませ', ['ja'], 0.5],
      ['Great', ['en'], -6.5],
    ];
    const say = (i: number) => {
      const [text, langs, delay] = lines[i]!;
      sendFrom(solo, delay);
      stt.last.say(text, langs, { start: i, end: i + 1 });
    };
    lines.forEach((_, i) => say(i));
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Hello', 'こんにちは', 'How are you?', '元気です', 'Great'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.speakerId, m.reason]),
      [
        ['Two coffees please', 'me', 'direction'],
        ['いらっしゃいませ', 'them', 'direction'],
      ],
    );

    // That was them after all: they moved.
    solo.accept(of('skipped')[1]!.id);
    lines.push(['こちらへ', ['ja'], 0.5], ['どうぞ', ['ja'], 0.5]);
    say(7);
    say(8);
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Hello', 'こんにちは', 'How are you?', '元気です', 'Great', 'いらっしゃいませ', 'こちらへ', 'どうぞ'],
    );
    assert.equal(of('skipped').length, 2);
  });

  it('forgets where we sit when the phone is turned', async () => {
    const { solo, stt, of, words } = soloSetup({ directions: true });
    const lines: [string, string[], number, number][] = [
      ['Hello', ['en'], -5, 0],
      ['こんにちは', ['ja'], 5, 0],
      ['How are you?', ['en'], -5, 0],
      ['元気です', ['ja'], 5, 0],
      ['Two coffees please', ['en'], 0, 0],
      ['Over here', ['en'], 0, 1],
    ];
    lines.forEach(([text, langs, delay, pose], i) => {
      sendFrom(solo, delay, { pose });
      stt.last.say(text, langs, { start: i, end: i + 1 });
    });
    await settle();
    assert.deepEqual(
      of('skipped').map(words),
      ['Two coffees please'],
    );
    assert.equal(of('utterance').at(-1)?.text, 'Over here');
  });

  it('checks the voice of speech from where one of us sits too', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer, directions: true });
    solo.usePartner(print(2000));
    const lines: [string, string[], number, number][] = [
      ['Hello', ['en'], -5, 1000],
      ['こんにちは', ['ja'], 5, 2000],
      ['How are you?', ['en'], -5, 1000],
      ['元気です', ['ja'], 5, 2000],
      // A stranger behind me.
      ['Two coffees please', ['en'], -5, 3000],
      // A stranger beside the phone.
      ['Excuse me', ['en'], 0, 6000],
      // They leaned over: from the side, but clearly their voice.
      ['すみません', ['ja'], 0, 2000],
      // My voice, as the noise around changes it.
      ['Great to hear', ['en'], -5, 5000],
    ];
    lines.forEach(([text, langs, delay, voice], i) => {
      sendFrom(solo, delay, { seconds: 2, voice });
      stt.last.say(text, langs, { start: i * 2, end: i * 2 + 2 });
    });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Hello', 'こんにちは', 'How are you?', '元気です', 'すみません'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Two coffees please', 'voice'],
        ['Excuse me', 'direction'],
        ['Great to hear', 'voice'],
      ],
    );

    // That was me: how my voice sounds here is known now, even with no clear direction.
    solo.accept(of('skipped')[2]!.id);
    sendFrom(solo, undefined, { seconds: 2, voice: 5000 });
    stt.last.say('Sure', ['en'], { start: 16, end: 18 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text).slice(-2),
      ['Great to hear', 'Sure'],
    );
  });

  it('checks the voice of speech too short to tell whose it is, when it can', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.usePartner(print(2000));
    solo.sendAudio(sound(2, 1000));
    solo.sendAudio(sound(2, 2000));
    stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    stt.last.say('こんにちは', ['ja'], { start: 2, end: 4 });
    await settle();
    // Half a second each: a stranger's, then mine.
    solo.sendAudio(sound(0.5, 3000));
    solo.sendAudio(sound(0.5, 1000));
    stt.last.say('OK', ['en'], { start: 4.1, end: 4.4 });
    stt.last.say('Yes', ['en'], { start: 4.6, end: 4.9 });
    // A word too short to tell by its voice, and one the recognizer did not time.
    solo.sendAudio(sound(0.4, 1000));
    stt.last.say('So', ['en'], { start: 5.1, end: 5.3 });
    stt.last.say('Mm', ['en']);
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Hello', 'こんにちは', 'Yes'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['OK', 'voice'],
        ['So', 'short'],
        ['Mm', 'untimed'],
      ],
    );
    solo.accept(of('skipped')[1]!.id);
    assert.equal(of('utterance').at(-1)?.text, 'So');
  });

  it('translates speech in a voice not recorded when asked, without taking that voice for theirs', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.sendAudio(sound(2, 3000));
    solo.sendAudio(sound(2, 3000));
    stt.last.say('いらっしゃいませ', ['ja'], { start: 0, end: 2 });
    await settle();
    solo.accept(of('skipped')[0]!.id);
    stt.last.say('どうぞ', ['ja'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['いらっしゃいませ'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['いらっしゃいませ', 'unrecorded'],
        ['どうぞ', 'unrecorded'],
      ],
    );
  });

  it('shows nothing of other voices, not even live, with only our two voices on', async () => {
    const { solo, stt, of, words, captions } = soloSetup({ voices: printer });
    // Me: shown once there is enough of it to tell my voice.
    solo.sendAudio(sound(3, 1000));
    stt.last.hear('Where', ['en'], { start: 0, end: 1 });
    await settle();
    assert.deepEqual(captions(), [], 'too little to tell whose voice');
    stt.last.hear('Where is the', ['en', 'en', 'en'], { start: 0, end: 1.5 });
    await settle();
    stt.last.hear('Where is the station', ['en', 'en', 'en', 'en'], { start: 0, end: 2 });
    stt.last.say('Where is the station?', ['en', 'en', 'en', 'en'], { start: 0, end: 2.5 });
    await settle();
    assert.deepEqual(captions(), ['Where is the', 'Where is the station']);

    // Someone else, however long they talk.
    solo.sendAudio(sound(3, 3000));
    for (const end of [4, 4.5, 5, 5.5, 6]) {
      stt.last.hear('Somebody else', ['en', 'en'], { start: 3, end });
      await settle();
    }
    stt.last.say('Somebody else here', ['en', 'en', 'en'], { start: 3, end: 6 });
    await settle();
    assert.deepEqual(captions(), ['Where is the', 'Where is the station']);
    assert.deepEqual(of('skipped').map((m) => [words(m), m.reason]), [['Somebody else here', 'voice']]);

    // The other person: nothing either, until their voice is recorded.
    solo.sendAudio(sound(4, 2000));
    stt.last.hear('こんにちは', ['ja'], { start: 6, end: 7.5 });
    await settle();
    stt.last.say('こんにちは', ['ja'], { start: 6, end: 8 });
    await settle();
    assert.deepEqual(captions(), ['Where is the', 'Where is the station']);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Where is the station?'],
    );
    // Then they show, live too.
    solo.usePartner(print(2000));
    stt.last.hear('いい天気', ['ja'], { start: 8, end: 9.5 });
    await settle();
    assert.deepEqual(captions(), ['Where is the', 'Where is the station', 'いい天気']);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Where is the station?', 'こんにちは'],
    );
  });

  it('shows nothing live from where one of us sits until its voice is one of ours', async () => {
    const { solo, stt, of, words, captions } = soloSetup({ voices: printer, directions: true });
    solo.usePartner(print(2000));
    const lines: [string, string[], number, number][] = [
      ['Hello', ['en'], -5, 1000],
      ['こんにちは', ['ja'], 5, 2000],
      ['How are you?', ['en'], -5, 1000],
      ['元気です', ['ja'], 5, 2000],
    ];
    lines.forEach(([text, langs, delay, voice], i) => {
      sendFrom(solo, delay, { seconds: 2, voice });
      stt.last.say(text, langs, { start: i * 2, end: i * 2 + 2 });
    });
    await settle();
    // A stranger behind me, however long they talk.
    sendFrom(solo, -5, { seconds: 3, voice: 3000 });
    for (const end of [9.5, 10, 10.5, 11]) {
      stt.last.hear('Two coffees', ['en', 'en'], { start: 8, end });
      await settle();
    }
    stt.last.say('Two coffees please', ['en', 'en', 'en'], { start: 8, end: 11 });
    await settle();
    assert.deepEqual(captions(), []);
    // Me: shown once there is enough of it to tell my voice.
    sendFrom(solo, -5, { seconds: 2, voice: 1000 });
    stt.last.hear('Great', ['en'], { start: 11, end: 12 });
    await settle();
    assert.deepEqual(captions(), []);
    stt.last.hear('Great to hear', ['en', 'en', 'en'], { start: 11, end: 12.5 });
    await settle();
    assert.deepEqual(captions(), ['Great to hear']);
    stt.last.say('Great to hear', ['en', 'en', 'en'], { start: 11, end: 12.5 });
    await settle();
    assert.equal(of('utterance').at(-1)?.text, 'Great to hear');
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['Two coffees please', 'voice']],
    );
  });

  it('suggests holding a button to talk, once, when we barely stand out of the chatter', async () => {
    const { solo, stt, of } = soloSetup();
    solo.sendAudio(sound(10, 2000));
    for (let i = 0; i < 6; i++) {
      // 6 dB above the place.
      solo.sendAudio(sound(1, 4000));
      solo.sendAudio(sound(1, 2000));
      stt.last.say('Hello', ['en'], { start: 10 + 2 * i, end: 11 + 2 * i });
      await settle();
      assert.equal(of('loud').length, i < 3 ? 0 : 1, `after ${i + 1}`);
    }
    assert.equal(of('utterance').length, 6);

    /** Six things said, louder than the place around by `voice` over `place`. */
    const talk = (setup: ReturnType<typeof soloSetup>, place: number, voice: number) => {
      setup.solo.sendAudio(sound(10, place));
      for (let i = 0; i < 6; i++) {
        setup.solo.sendAudio(sound(1, voice));
        setup.solo.sendAudio(sound(1, place));
        setup.stt.last.say('Hello', ['en'], { start: 10 + 2 * i, end: 11 + 2 * i });
      }
    };
    // Not where we stand out enough, nor while whoever talks holds a button.
    const quieter = soloSetup();
    talk(quieter, 1000, 4000);
    const held = soloSetup();
    held.solo.setTalkMode('hold');
    talk(held, 2000, 4000);
    await settle();
    assert.deepEqual([...quieter.of('loud'), ...held.of('loud')], []);
    assert.equal(held.of('utterance').length, 6);
  });

  it('skips nothing while whoever talks holds a button, and shows it as it is heard', async () => {
    const { solo, stt, of, captions } = soloSetup({ nearbyOnly: true });
    solo.setTalkMode('hold');
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
      ['One', 'Two', 'Three', 'Far away'],
    );
    assert.deepEqual(captions(), ['Far']);
    assert.deepEqual(of('skipped'), []);
  });

  it('writes out held speech only in one of the two recorded voices', async () => {
    const { solo, stt, of, words, captions } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 3000)); // a stranger, or a song
    solo.sendAudio(sound(2, 1000)); // me
    solo.sendAudio(sound(2, 2000)); // them, not recorded yet
    stt.last.hear('Somebody', ['en'], { start: 0, end: 2 });
    stt.last.say('Somebody else', ['en'], { start: 0, end: 2 });
    stt.last.say('Hello', ['en'], { start: 2, end: 4 });
    stt.last.say('こんにちは', ['ja'], { start: 4, end: 6 });
    stt.last.say('One', ['en']); // untimed: whose voice it is can't be told
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [['me', 'Hello']],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Somebody else', 'voice'],
        ['こんにちは', 'unrecorded'],
        ['One', 'untimed'],
      ],
    );
    assert.deepEqual(captions(), []);

    // Theirs once their voice is known.
    solo.usePartner(print(2000));
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [
        ['me', 'Hello'],
        ['them', 'こんにちは'],
      ],
    );
    assert.deepEqual(of('error'), []);
  });

  it('reports each line, whose voice it sounds like piece by piece, and why it was skipped, when asked', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt } = soloSetup({ voices: printer, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 1000)); // me
    solo.sendAudio(sound(2, 3000)); // a stranger
    const words = [
      { text: 'Hello', start: 0, end: 1, language: 'en' },
      { text: 'there', start: 1, end: 2 },
    ];
    stt.last.say('Hello there', ['en'], { start: 0, end: 2, words });
    stt.last.say('Somebody else', ['en'], { start: 2, end: 4 });
    stt.last.say('One', ['en']); // untimed
    await settle();

    const lines = entries.filter((e) => e.type === 'line');
    assert.deepEqual(
      lines.map((l) => [l.id, l.text, l.held, l.outcome, l.reason]),
      [
        ['u1', 'Hello there', true, 'translated', undefined],
        ['u2', 'Somebody else', true, 'skipped', 'voice'],
        ['u3', 'One', true, 'skipped', 'untimed'],
      ],
    );
    const [mine, theirs, untimed] = lines;
    assert.deepEqual(mine!.words, words);
    assert.deepEqual(mine!.languages, { en: 1 });
    assert.deepEqual(mine!.voice, { mine: 1, mineHere: -1, partner: -1, partnerHere: -1 });
    assert.deepEqual(theirs!.voice, { mine: 0, mineHere: 0, partner: -1, partnerHere: -1 });
    assert.equal(untimed!.voice, undefined);
    assert.equal(untimed!.start, undefined);
    assert.ok(theirs!.level! > mine!.level!); // the stranger's sound is louder
    // In pieces of 1.5 s a second apart, plus the end, within the audio heard (4 s); shown
    // to 0.1 s, as audio is cut to samples.
    const tenths = (x: number) => Math.round(x * 10) / 10;
    assert.deepEqual(
      entries.filter((e) => e.type === 'windows').map((e) => [e.id, e.windows.map((w) => [tenths(w.start), tenths(w.end), w.voice.mine])]),
      [
        ['u1', [[0, 1.5, 1], [0.6, 2.1, 1]]],
        ['u2', [[1.9, 3.4, 0], [2.5, 4, 0]]],
      ],
    );
    assert.deepEqual(
      entries.filter((e) => e.type !== 'line' && e.type !== 'windows'),
      [
        { type: 'voices', partner: 'unknown' },
        { type: 'talk-mode', mode: 'hold' },
        { type: 'translation', id: 'u1', text: '[ja] Hello there' },
      ],
    );
  });
});

describe('recording their voice in a conversation', () => {
  /** The `voices` messages in short: how their voice is known, how a recording goes, what failed. */
  const voicesOf = (messages: ServerMessage[]) =>
    messages.flatMap((m) => {
      if (m.type !== 'voices') return [];
      const { recording, failed } = m;
      const progress = recording ? ` ${recording.seconds}/${recording.of}${recording.hint ? ` ${recording.hint}` : ''}` : '';
      return [`${m.partner}${progress}${failed ? ` failed: ${failed}` : ''}`];
    });

  it('tells the phone how their voice is known', async () => {
    const { solo, stt, messages } = soloSetup({ voices: printer });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('はい', ['ja'], { start: 0, end: 2 });
    await settle();
    assert.deepEqual(voicesOf(messages), ['unknown'], 'not from what they say');
    solo.usePartner(print(2000));
    assert.deepEqual(voicesOf(messages), ['unknown', 'recorded']);
    assert.deepEqual(soloSetup().of('voices'), [], 'not without voice prints');
  });

  it('records their voice, then translates what they said meanwhile, and nobody else', async () => {
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer });
    // Someone else spoke first.
    solo.sendAudio(sound(2, 3000));
    stt.last.say('すみません', ['ja'], { start: 0, end: 2 });
    await settle();
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 3, voice: 2000 });
    stt.last.say('はじめまして', ['ja'], { start: 3, end: 6 });
    await settle();
    assert.deepEqual(of('utterance'), [], 'not before their voice is recorded');
    sendFrom(solo, undefined, { seconds: 4, voice: 2000 });
    await settle();
    // Now only the recorded voice is theirs.
    solo.sendAudio(sound(2, 3000));
    stt.last.say('ちょっと', ['ja'], { start: 10, end: 12 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('よろしく', ['ja'], { start: 12, end: 14 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['はじめまして', 'よろしく'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['すみません', 'unrecorded'],
        ['はじめまして', 'unrecorded'],
        ['ちょっと', 'voice'],
      ],
    );
    assert.deepEqual(voicesOf(messages), [
      'unknown',
      'unknown 0/6',
      'unknown 1/6',
      'unknown 2/6',
      'unknown 3/6',
      'unknown 4/6',
      'unknown 5/6',
      'unknown 6/6',
      'recorded',
    ]);
  });

  it('translates nothing said before their voice was recorded when the recording is stopped', async () => {
    const { solo, stt, of } = soloSetup({ voices: printer });
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 3, voice: 2000 });
    stt.last.say('はじめまして', ['ja'], { start: 1, end: 4 });
    await settle();
    solo.stopRecording();
    sendFrom(solo, undefined, { seconds: 4, voice: 2000 });
    await settle();
    assert.deepEqual(of('utterance'), []);
    assert.equal(of('skipped').length, 1);
  });

  it('keeps what was known of their voice when the recording is stopped', async () => {
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer });
    solo.usePartner(print(2000));
    solo.sendAudio(sound(2, 2000));
    stt.last.say('はい', ['ja'], { start: 0, end: 2 });
    await settle();
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 2, voice: 3000 });
    solo.stopRecording();
    await settle();
    solo.sendAudio(sound(2, 3000));
    stt.last.say('いらっしゃいませ', ['ja'], { start: 5, end: 7 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('どうぞ', ['ja'], { start: 7, end: 9 });
    await settle();
    assert.deepEqual(voicesOf(messages), ['unknown', 'recorded', 'recorded 0/6', 'recorded 1/6', 'recorded 2/6', 'recorded']);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['はい', 'どうぞ'],
    );
    assert.deepEqual(of('skipped').map(words), ['いらっしゃいませ']);
  });

  it('keeps their recorded voice when a line in another is translated after all', async () => {
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer });
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 6, voice: 2000 });
    await settle();
    solo.sendAudio(sound(2, 3000));
    stt.last.say('いらっしゃいませ', ['ja'], { start: 7, end: 9 });
    await settle();
    solo.accept(of('skipped')[0]!.id);
    solo.sendAudio(sound(2, 3000));
    stt.last.say('こちらへ', ['ja'], { start: 9, end: 11 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('ありがとう', ['ja'], { start: 11, end: 13 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['いらっしゃいませ', 'ありがとう'],
    );
    assert.deepEqual(of('skipped').map(words), ['いらっしゃいませ', 'こちらへ']);
    assert.equal(voicesOf(messages).at(-1), 'recorded');
    assert.deepEqual([...solo.partnerPrint!], [0, 1, 0], 'to save it for the next talk');
  });

  it('uses their voice saved in an earlier talk', async () => {
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer });
    assert.equal(solo.usePartner(print(2000)), true);
    solo.sendAudio(sound(2, 3000));
    stt.last.say('いらっしゃいませ', ['ja'], { start: 0, end: 2 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('どうぞ', ['ja'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(voicesOf(messages), ['unknown', 'recorded']);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['どうぞ'],
    );
    assert.deepEqual(of('skipped').map(words), ['いらっしゃいませ']);
    assert.deepEqual([...solo.partnerPrint!], [0, 1, 0]);
  });

  it('translates what they said in the last minute once their saved voice is chosen, and only that', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('おはよう', ['ja'], { start: 0, end: 2 });
    await settle();
    solo.sendAudio(sound(61, 100));
    solo.sendAudio(sound(2, 2000));
    stt.last.say('はい', ['ja'], { start: 63, end: 65 });
    solo.sendAudio(sound(2, 3000));
    stt.last.say('いらっしゃいませ', ['ja'], { start: 65, end: 67 });
    await settle();
    assert.equal(solo.usePartner(print(2000)), true);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['はい'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['おはよう', 'unrecorded'],
        ['はい', 'unrecorded'],
        ['いらっしゃいませ', 'unrecorded'],
      ],
    );
    // What is left is still there to translate.
    solo.accept(of('skipped')[2]!.id);
    assert.equal(of('utterance').at(-1)?.text, 'いらっしゃいませ');
  });

  it('stops recording their voice when a saved one is chosen instead', async () => {
    const { solo, messages } = soloSetup({ voices: printer });
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 2, voice: 3000 });
    assert.equal(solo.usePartner(print(2000)), true);
    sendFrom(solo, undefined, { seconds: 6, voice: 3000 });
    await settle();
    assert.deepEqual(voicesOf(messages), ['unknown', 'unknown 0/6', 'unknown 1/6', 'unknown 2/6', 'recorded']);
    assert.deepEqual([...solo.partnerPrint!], [0, 1, 0]);
  });

  it('does not use a saved voice it cannot compare', () => {
    const { solo, messages } = soloSetup({ voices: printer });
    assert.equal(solo.usePartner(new Float32Array([0, 1])), false, 'from another speaker model');
    assert.deepEqual(voicesOf(messages), ['unknown']);
    assert.equal(solo.partnerPrint, undefined);
    assert.equal(soloSetup().solo.usePartner(print(2000)), false, 'without voice prints');
  });

  it('says when recording their voice did not work', async () => {
    const { solo, messages } = soloSetup({ voices: printer });
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 4, voice: 1000 }); // me, explaining what to do
    await settle();
    sendFrom(solo, undefined, { seconds: 25, voice: 100 });
    await settle();
    assert.deepEqual(voicesOf(messages), [
      'unknown',
      'unknown 0/6',
      'unknown 1/6',
      'unknown 2/6',
      'unknown 3/6',
      'unknown 4/6',
      'unknown 2/6 mine',
      'unknown 0/6 mine',
      'unknown failed: mine',
    ]);
    // Trying again starts afresh.
    solo.recordPartner();
    assert.equal(voicesOf(messages).at(-1), 'unknown 0/6');
  });
});
