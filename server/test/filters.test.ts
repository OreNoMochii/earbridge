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
  11000: [0.38, 0.8167, 0.4343],
  12000: [0.38, 0.8167, -0.4343],
  13000: [0.1, 0.95, 0.2956],
  14000: [0.376, 0.5, -0.78],
  15000: [0.15, 0, 0.9887],
  16000: [0, 0.3, -0.954],
};
const printer = {
  mine: new Float32Array(VOICES[1000]!),
  print: async (samples: Int16Array) => {
    const print = VOICES[samples[Math.floor(samples.length / 2)]!];
    return print && new Float32Array(print);
  },
};
/** Like `printer`, but a piece of sound is in the voice heard most in it, silence not counting: for pieces the gate judges as they come. */
const gatePrinter = {
  mine: printer.mine,
  print: async (samples: Int16Array) => {
    const heard = new Map<number, number>();
    for (const value of samples) if (value !== 0) heard.set(value, (heard.get(value) ?? 0) + 1);
    const most = [...heard.entries()].sort((a, b) => b[1] - a[1])[0];
    const print = most && VOICES[most[0]];
    return print && new Float32Array(print);
  },
};
const print = (value: number) => new Float32Array(VOICES[value]!);
/** A voice print to 3 decimals: learned ones are normalized, which moves them by a hair. */
const rounded = (print: Float32Array) => [...print].map((value) => Number(value.toFixed(3)));

describe('voices', () => {
  it('lets whatever is said for them through until their voice is known, and learns theirs from it', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.admits('me', print(1000), 2), true);
    assert.equal(voices.admits('me', print(3000), 2), false, 'what is said for me is in my voice');
    assert.equal(voices.partner, 'unknown');
    // Someone else now and then, and them again and again.
    assert.equal(voices.admits('them', print(3000), 2), true);
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.admits('them', print(2000), 1), true, 'too short to learn from');
    assert.equal(voices.admits('them', print(8000), 2), true, 'theirs, sounding a little different');
    assert.equal(voices.partner, 'unknown', 'not yet as long as a recording of it');
    assert.equal(voices.recognizes(print(2000)), false);
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.partner, 'learned');
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.admits('them', print(4000), 2), true, 'a similar voice');
    assert.equal(voices.admits('them', print(3000), 2), false);
    assert.equal(voices.admits('them', print(1000), 2), true, 'mine, still');
    assert.equal(voices.admits('me', print(2000), 2), false, 'what is said for me is in my voice');
    assert.equal(voices.recognizes(print(2000)), true);
    assert.equal(voices.recognizes(print(2000), 'me'), false);
  });

  it('takes no voice for theirs while another is heard about as much', () => {
    const voices = new VoiceFilter(printer);
    for (let i = 0; i < 4; i++) {
      assert.equal(voices.admits('them', print(2000), 2), true);
      assert.equal(voices.admits('them', print(3000), 2), true);
    }
    assert.equal(voices.partner, 'unknown');
  });

  it('learns their voice when it is rather like mine, but never takes mine for theirs', () => {
    const voices = new VoiceFilter(printer);
    for (let i = 0; i < 3; i++) assert.equal(voices.admits('them', print(5000), 2), true);
    assert.equal(voices.partner, 'learned');
    assert.equal(voices.recognizes(print(5000), 'them'), true);
    assert.equal(voices.admits('them', print(2000), 2), false);

    // Mine, said for them in a loud place: each time too unclear to tell, but all together clearly mine.
    const loud = new VoiceFilter(printer);
    for (const value of [11000, 12000, 11000, 12000]) assert.equal(loud.admits('them', print(value), 2), true);
    assert.equal(loud.partner, 'unknown');
  });

  it('learns their voice among many others, each heard now and then', () => {
    // Voices nothing like each other: mine is the first.
    const voice = (i: number) => Float32Array.from({ length: 12 }, (_, j) => (i === j ? 1 : 0));
    const voices = new VoiceFilter({ mine: voice(0), print: async () => undefined });
    // Strangers, each saying something once, and them now and then.
    for (let i = 2; i < 12; i++) {
      assert.equal(voices.admits('them', voice(i), 2), i <= 9, `the stranger ${i}`);
      if (i % 3 === 0) assert.equal(voices.admits('them', voice(1), 2), true);
      assert.equal(voices.partner, i < 9 ? 'unknown' : 'learned', `after the stranger ${i}`);
    }
    assert.deepEqual([...voices.partnerPrint!], [...voice(1)]);
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

  it('learns their voice as heard here from what was translated after all', () => {
    const voices = new VoiceFilter(printer);
    voices.setPartner(print(3000));
    // Nothing like their recording: someone else, translated only to see what they said.
    voices.translated('them', print(2000), 2);
    assert.equal(voices.admits('them', print(2000), 2), false);
    assert.equal(voices.partner, 'recorded', 'a recording stays');
    // Rather like it: them, sounding different here.
    voices.translated('them', print(8000), 2);
    assert.equal(voices.admits('them', print(2000), 2), true);
  });

  it('takes a voice translated after all for theirs, when the one learned was another', () => {
    const voices = new VoiceFilter(printer);
    // The radio, before they said anything.
    for (let i = 0; i < 3; i++) voices.admits('them', print(3000), 2);
    assert.equal(voices.partner, 'learned');
    assert.equal(voices.admits('them', print(2000), 2), false);
    voices.translated('them', print(2000), 1);
    assert.equal(voices.admits('them', print(2000), 2), false, 'too short to tell');
    voices.translated('them', print(2000), 2);
    assert.equal(voices.partner, 'learned');
    assert.deepEqual([...voices.partnerPrint!], [0, 1, 0]);
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.admits('them', print(3000), 2), false);

    // Even one rather like the one learned.
    const close = new VoiceFilter(printer);
    for (let i = 0; i < 3; i++) close.admits('them', print(3000), 2);
    assert.equal(close.admits('them', print(8000), 2), false);
    close.translated('them', print(8000), 2);
    assert.equal(close.admits('them', print(8000), 2), true);
    assert.equal(close.admits('them', print(3000), 2), false);

    // Theirs rather like mine, but never mine.
    const like = new VoiceFilter(printer);
    for (let i = 0; i < 3; i++) like.admits('them', print(2000), 2);
    like.translated('them', print(7000), 2);
    assert.deepEqual([...like.partnerPrint!], [0, 1, 0]);
    assert.equal(like.admits('them', print(5000), 2), false);
    like.translated('them', print(5000), 2);
    assert.equal(like.admits('them', print(5000), 2), true);
    assert.equal(like.admits('them', print(2000), 2), false);

    // Until it is known, what was translated after all counts like the rest.
    const unknown = new VoiceFilter(printer);
    unknown.translated('them', print(2000), 2);
    unknown.admits('them', print(2000), 2);
    assert.equal(unknown.partner, 'unknown');
    unknown.translated('them', print(2000), 2);
    assert.equal(unknown.partner, 'learned');
  });

  it('forgets the voice learned when told it was someone else’s, skips it from then on, and learns theirs from any other', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.rejectPartner(), false, 'nothing learned yet');
    // The radio, before they said anything.
    for (let i = 0; i < 3; i++) voices.admits('them', print(3000), 2);
    assert.equal(voices.partner, 'learned');
    assert.equal(voices.admits('them', print(2000), 2), false);
    assert.equal(voices.rejectPartner(), true);
    assert.equal(voices.partner, 'unknown');
    assert.equal(voices.partnerPrint, undefined);
    assert.equal(voices.admits('them', print(3000), 2), false, 'the radio, from now on');
    assert.equal(voices.admits('them', print(4000), 2), false, 'rather like it');
    assert.equal(voices.admits('them', print(1000), 2), true, 'mine, still');
    assert.equal(voices.admits('them', print(2000), 2), true, 'anyone else, until theirs is learned');
    // The radio going on and on does not keep theirs from being learned.
    for (let i = 0; i < 6; i++) assert.equal(voices.admits('them', print(3000), 2), false);
    assert.equal(voices.partner, 'unknown');
    for (let i = 0; i < 2; i++) assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.partner, 'learned');
    assert.deepEqual([...voices.partnerPrint!], [0, 1, 0]);
    assert.equal(voices.admits('them', print(3000), 2), false);

    // A recorded voice is replaced by recording it again, or picking them: not forgotten.
    const recorded = new VoiceFilter(printer);
    recorded.setPartner(print(2000));
    assert.equal(recorded.rejectPartner(), false);
    assert.equal(recorded.partner, 'recorded');
  });

  it('takes a voice it was told was not theirs for theirs after all, once something in it is translated after all', () => {
    const voices = new VoiceFilter(printer);
    for (let i = 0; i < 3; i++) voices.admits('them', print(3000), 2);
    voices.rejectPartner();
    assert.equal(voices.admits('them', print(3000), 2), false);
    voices.translated('them', print(3000), 2);
    assert.equal(voices.admits('them', print(3000), 2), true);
    assert.equal(voices.partner, 'unknown', 'learned afresh, like any other voice');
    voices.admits('them', print(3000), 2);
    assert.equal(voices.partner, 'learned');
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

  it('takes speech vouched for, by whoever holds the button, for that side’s when it is only somewhat like their voice', () => {
    const voices = new VoiceFilter(printer);
    // Mine, only somewhat like my recording, which was made somewhere else.
    assert.equal(voices.admits('me', print(5000), 2), false, 'not clearly mine');
    assert.equal(voices.admits('me', print(2000), 2, true), false, 'nothing like my voice, vouched for or not');
    assert.equal(voices.admits('me', print(5000), 2, true), true);
    assert.equal(voices.admits('me', print(5000), 2), true, 'learned as my voice here');
    assert.equal(voices.recognizes(print(5000)), true);
    assert.deepEqual(rounded(voices.printHere('me')!), [0.3, 0, 0.954]);
    // Someone else, nothing like my recording but a little like my voice here: not mine, vouched for or not.
    assert.equal(voices.admits('me', print(13000), 2, true), false);
    assert.deepEqual(rounded(voices.printHere('me')!), [0.3, 0, 0.954], 'nothing learned from it');
    assert.equal(voices.printHere('them'), undefined);

    // Theirs as recorded, only somewhat like their voice here.
    const theirs = new VoiceFilter(printer);
    theirs.setPartner(print(3000));
    assert.equal(theirs.printHere('them'), undefined);
    assert.equal(theirs.admits('them', print(8000), 2), false, 'not clearly theirs');
    assert.equal(theirs.admits('them', print(2000), 2, true), false, 'nothing like their voice');
    assert.equal(theirs.admits('them', print(8000), 2, true), true);
    assert.equal(theirs.admits('them', print(8000), 2), true, 'learned as their voice here');
    assert.deepEqual(rounded(theirs.printHere('them')!), [0, 0.95, 0.312]);
    // Someone else, a little like their voice here but nothing like it as recorded: not theirs.
    assert.equal(theirs.admits('them', print(14000), 2, true), false);
    assert.deepEqual(rounded(theirs.printHere('them')!), [0, 0.95, 0.312], 'nothing learned from it');
    // Said for me, somewhat like my voice but clearly theirs: not mine, vouched for or not.
    assert.equal(theirs.admits('me', print(11000), 2, true), false);

    // Until their voice is known, what is said for them is let through anyway, and theirs learned from it.
    const unknown = new VoiceFilter(printer);
    assert.equal(unknown.admits('them', print(2000), 2, true), true);
    assert.equal(unknown.partner, 'unknown');
  });

  it('learns my voice here from what was said holding the button and translated after all, however unlike my recording', () => {
    const voices = new VoiceFilter(printer);
    // Me through earphones in a crowd: nothing like my recording, made somewhere else.
    assert.equal(voices.admits('me', print(2000), 2, true), false);
    voices.translated('me', print(2000), 1, true);
    assert.equal(voices.printHere('me'), undefined, 'too short to tell');
    voices.translated('me', print(2000), 2);
    assert.equal(voices.printHere('me'), undefined, 'not said holding the button');
    voices.translated('me', print(2000), 2, true);
    assert.deepEqual(rounded(voices.printHere('me')!), [0, 1, 0]);
    assert.equal(voices.admits('me', print(2000), 2, true), true);
    assert.equal(voices.admits('me', print(13000), 2), true, 'clearly like my voice here');
    assert.equal(voices.judge(['me'], print(3000)), 'other', 'someone else, now that my voice here is known');

    // Clearly theirs: not mine, held or not.
    const theirs = new VoiceFilter(printer);
    theirs.setPartner(print(3000));
    theirs.translated('me', print(3000), 2, true);
    assert.equal(theirs.printHere('me'), undefined);
  });

  it('takes up my voice as heard here in an earlier conversation, and learns it further from there', () => {
    const before = new VoiceFilter(printer);
    assert.equal(before.myVoiceHere, undefined);
    before.translated('me', print(2000), 2, true);
    before.translated('me', print(13000), 2, true);
    const learned = before.myVoiceHere!;
    assert.deepEqual([rounded(learned.sum), learned.count], [[0.1, 1.95, 0.296], 2]);
    learned.sum.fill(0);
    assert.deepEqual(rounded(before.myVoiceHere!.sum), [0.1, 1.95, 0.296], 'a copy');

    const after = new VoiceFilter(printer);
    assert.equal(after.admits('me', print(2000), 2, true), false, 'nothing like my recording');
    assert.equal(after.useMyVoiceHere(before.myVoiceHere), true);
    assert.deepEqual(rounded(after.printHere('me')!), rounded(before.printHere('me')!));
    assert.equal(after.admits('me', print(2000), 2, true), true);
    // As if it had been learned in this conversation.
    before.translated('me', print(8000), 2, true);
    after.translated('me', print(8000), 2, true);
    assert.deepEqual(rounded(after.printHere('me')!), rounded(before.printHere('me')!));
    assert.equal(after.myVoiceHere!.count, 3);
    // Prints from another speaker model, which can't be compared: what was learned stays.
    assert.equal(after.useMyVoiceHere({ sum: new Float32Array(4), count: 1 }), false);
    assert.deepEqual(rounded(after.printHere('me')!), rounded(before.printHere('me')!));
    // Never from more prints than it remembers.
    assert.equal(after.useMyVoiceHere({ sum: print(2000), count: 50 }), true);
    assert.equal(after.myVoiceHere!.count, 10);
    // Another microphone, with nothing learned through it: learned afresh.
    assert.equal(after.useMyVoiceHere(undefined), true);
    assert.equal(after.printHere('me'), undefined);
    assert.equal(after.myVoiceHere, undefined);
  });

  it('tells the gate whose voice a piece of sound is in, once the voices to keep out are known', () => {
    const voices = new VoiceFilter(printer);
    assert.equal(voices.judge(['me'], print(1000)), 'ours');
    assert.equal(voices.judge(['me'], print(5000)), 'ours', 'somewhat like my recording');
    assert.equal(voices.judge(['me'], print(2000)), 'maybe', 'my voice here is not known yet');
    assert.equal(voices.judge(['them'], print(2000)), 'maybe', 'their voice is not known yet');
    assert.equal(voices.judge(['me', 'them'], print(2000)), 'maybe');
    // My voice here, learned from what I said holding the button: only somewhat like my recording.
    assert.equal(voices.admits('me', print(5000), 2, true), true);
    assert.equal(voices.judge(['me'], print(2000)), 'other');
    assert.equal(voices.judge(['me'], print(15000)), 'ours', 'clearly like my voice here, though hardly like my recording');
    assert.equal(voices.judge(['me'], print(13000)), 'other', 'a little like my voice here, nothing like my recording');
    assert.equal(voices.judge(['them'], print(2000)), 'maybe', 'their voice is still not known');
    assert.equal(voices.judge(['me', 'them'], print(2000)), 'maybe');
    // Theirs, learned from what they said.
    for (let i = 0; i < 3; i++) assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.partner, 'learned');
    assert.equal(voices.judge(['them'], print(2000)), 'ours');
    assert.equal(voices.judge(['them'], print(16000)), 'ours', 'somewhat like theirs');
    assert.equal(voices.judge(['them'], print(1000)), 'ours', 'mine, said for them');
    assert.equal(voices.judge(['them'], print(6000)), 'maybe', 'their voice here is not known yet');
    assert.equal(voices.admits('them', print(2000), 2), true);
    assert.equal(voices.judge(['them'], print(6000)), 'other');
    assert.equal(voices.judge(['me', 'them'], print(6000)), 'other');
    assert.equal(voices.judge(['me'], print(2000)), 'other', 'theirs, said for me');
    // The voice learned for them was someone else's, the user says: kept out, and theirs unknown again.
    assert.equal(voices.rejectPartner(), true);
    assert.equal(voices.judge(['them'], print(2000)), 'other');
    assert.equal(voices.judge(['them'], print(6000)), 'maybe');
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

/** Some seconds of a voice in 100 ms chunks, each given time to be judged by the gate (see `SpeechGate`). */
async function hearIn(solo: SoloConversation, seconds: number, value: number): Promise<void> {
  for (let i = 0; i < Math.round(seconds * 10); i++) {
    solo.sendAudio(sound(0.1, value));
    await settle();
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

  it('leaves out of a held line what someone else said over it, when the recognizer tells talkers apart', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, of, words } = soloSetup({ voices: printer, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    assert.equal(stt.last.speakers, true, 'asked to tell the talkers apart');
    solo.sendAudio(sound(2, 1000)); // me
    solo.sendAudio(sound(2, 3000)); // someone else, over me
    solo.sendAudio(sound(2, 1000)); // me again
    const word = (text: string, start: number, speaker: string) => ({ text, start, end: start + 0.5, speaker });
    const said = [word('Hello', 0.2, '0'), word('there.', 1.2, '0'), word('Hey', 2.2, '1'), word('you.', 3.2, '1'), word('Where', 4.2, '0'), word('is', 4.7, '0'), word('it?', 5.2, '0')];
    stt.last.say('Hello there. Hey you. Where is it?', ['en', 'en', 'en', 'en', 'en', 'en', 'en'], { start: 0.2, end: 5.7, words: said });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.id, m.speakerId, m.text]),
      [['u1', 'me', 'Hello there. Where is it?']],
    );
    assert.deepEqual(of('skipped'), [{ type: 'skipped', id: 'u2', speakerId: 'me', lang: 'en-US', reason: 'voice' }]);
    assert.equal(words(of('skipped')[0]!), undefined, 'not a line of its own to the recognizer');
    const line = entries.find((e) => e.type === 'line');
    assert.equal(line?.type === 'line' && line.kept, 'Hello there. Where is it?');
    assert.deepEqual(
      entries
        .filter((e) => e.type === 'parts')
        .map((e) => e.type === 'parts' && e.parts.map((part) => [part.speaker, part.text, Math.round(part.seconds * 10) / 10, part.kept, part.id])),
      [
        [
          ['0', 'Hello there. Where is it?', 3.4, true, undefined],
          ['1', 'Hey you.', 1.7, false, 'u2'],
        ],
      ],
    );
    // What was left out can still be asked for.
    solo.accept('u2');
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.id, m.text]),
      [
        ['u1', 'Hello there. Where is it?'],
        ['u2', 'Hey you.'],
      ],
    );
  });

  it('keeps a held line whole when the recognizer tells one voice as two, or no part of it is clearly mine', async () => {
    const { solo, stt, of } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 7000)); // me, as heard here
    solo.sendAudio(sound(2, 3000)); // much the same voice, though nothing like my recording: told apart wrongly
    const word = (text: string, start: number, speaker: string) => ({ text, start, end: start + 0.5, speaker });
    stt.last.say('One two three four', ['en', 'en', 'en', 'en'], {
      start: 0.2,
      end: 3.7,
      words: [word('One', 0.2, '0'), word('two', 1.2, '0'), word('three', 2.2, '1'), word('four', 3.2, '1')],
    });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One two three four'],
      'the second voice goes with the first, which is clearly mine',
    );
    assert.deepEqual(of('skipped'), []);

    const next = soloSetup({ voices: printer });
    next.solo.setTalkMode('hold');
    next.solo.sendAudio(sound(3, 5000)); // me, only somewhat like my recording
    next.solo.sendAudio(sound(1, 15000)); // and a voice the recognizer told apart, somewhat like it too
    next.stt.last.say('One two three four', ['en', 'en', 'en', 'en'], {
      start: 0.2,
      end: 3.7,
      words: [word('One', 0.2, '0'), word('two', 1.2, '0'), word('three', 2.2, '0'), word('four', 3.2, '1')],
    });
    await settle();
    assert.deepEqual(
      next.of('utterance').map((m) => m.text),
      ['One two three four'],
      'judged as a whole, as no part is clearly mine',
    );
    assert.deepEqual(next.of('skipped'), []);
  });

  it('judges a long turn within a part by its own voice, once my voice here is settled', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, of } = soloSetup({ voices: printer, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    const word = (text: string, start: number, speaker: string, end = start + 0.5) => ({ text, start, end, speaker });
    // Three lines in my voice as heard here settle it.
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 7000));
      stt.last.say('Yes.', ['en'], { start: i * 2, end: i * 2 + 2 });
    }
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text), ['Yes.', 'Yes.', 'Yes.']);

    // Someone talks over me, and the recognizer gives most of their words to my part.
    solo.sendAudio(sound(2.5, 7000)); // 6–8.5 s: me
    solo.sendAudio(sound(2.5, 2000)); // 8.5–11 s: someone else
    solo.sendAudio(sound(2, 7000)); // 11–13 s: me
    stt.last.say('Hello there friend. Hey you listen to me. Where is it?', Array(10).fill('en'), {
      start: 6.2,
      end: 12.8,
      words: [
        word('Hello', 6.2, '0'),
        word('there', 7.0, '0'),
        word('friend.', 7.8, '0'),
        word('Hey', 8.6, '1', 9.0),
        word('you', 9.1, '0'),
        word('listen', 9.6, '0'),
        word('to', 10.0, '0', 10.3),
        word('me.', 10.4, '0', 10.9),
        word('Where', 11.2, '1'),
        word('is', 11.8, '1'),
        word('it?', 12.3, '1'),
      ],
    });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text).slice(3),
      ['Hello there friend. Hey Where is it?'],
      'their long turn is left out, their short word cannot be told',
    );
    assert.deepEqual(
      of('skipped').map((m) => [m.id, m.reason]),
      [['u5', 'voice']],
    );

    // The other way round: my long turn among their words is kept.
    solo.sendAudio(sound(2.5, 2000)); // 13–15.5 s: someone else
    solo.sendAudio(sound(2, 7000)); // 15.5–17.5 s: me
    solo.sendAudio(sound(0.5, 2000)); // 17.5–18 s: someone else
    stt.last.say('Listen to me now. Yes. I am right here.', Array(9).fill('en'), {
      start: 13.2,
      end: 17.5,
      words: [
        word('Listen', 13.2, '0'),
        word('to', 13.8, '0'),
        word('me', 14.3, '0'),
        word('now.', 14.8, '0', 15.3),
        word('Yes.', 15.6, '1', 15.9),
        word('I', 16.0, '0', 16.3),
        word('am', 16.4, '0', 16.7),
        word('right', 16.8, '0', 17.0),
        word('here.', 17.1, '0', 17.5),
      ],
    });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(4), ['Yes. I am right here.']);
    assert.deepEqual(
      of('skipped').map((m) => [m.id, m.reason]).slice(1),
      [['u7', 'voice']],
    );
    solo.accept('u5');
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(5), ['you listen to me.'], 'what was left out can still be asked for');
    assert.deepEqual(
      entries.filter((e) => e.type === 'parts').map((e) => e.type === 'parts' && e.parts.map((part) => [part.speaker, part.text, part.kept, part.apart ?? false, part.id])),
      [
        [
          ['0', 'Hello there friend.', true, false, undefined],
          ['1', 'Hey Where is it?', true, false, undefined],
          ['0', 'you listen to me.', false, true, 'u5'],
        ],
        [
          ['0', 'Listen to me now.', false, false, 'u7'],
          ['1', 'Yes.', true, false, undefined],
          ['0', 'I am right here.', true, true, undefined],
        ],
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

  it('translates whatever is said for them until their voice is known, which it learns from what they say', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    const lines: [string, string[], number][] = [
      ['こんにちは', ['ja'], 2000],
      // Someone else now and then, translated too while their voice is not known.
      ['いらっしゃいませ', ['ja'], 3000],
      ['駅はどこですか', ['ja'], 2000],
      ['Somebody else', ['en'], 3000],
      ['まっすぐです', ['ja'], 2000],
      // Their voice is known by now.
      ['どうぞ', ['ja'], 3000],
      ['ありがとう', ['ja'], 2000],
    ];
    for (const [i, [text, langs, voice]] of lines.entries()) {
      solo.sendAudio(sound(2, voice));
      stt.last.say(text, langs, { start: i * 2, end: i * 2 + 2 });
      await settle();
    }
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [
        ['them', 'こんにちは'],
        ['them', 'いらっしゃいませ'],
        ['them', '駅はどこですか'],
        ['them', 'まっすぐです'],
        ['them', 'ありがとう'],
      ],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Somebody else', 'voice'],
        ['どうぞ', 'voice'],
      ],
    );
    assert.deepEqual(
      of('voices').map((m) => m.partner),
      ['unknown', 'learned'],
    );
  });

  it('translates what is said for them too short to tell whose voice it is, or untimed, until their voice is known', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('こんにちは', ['ja'], { start: 0, end: 2 });
    solo.sendAudio(sound(0.4, 2000));
    stt.last.say('はい', ['ja'], { start: 2.1, end: 2.3 });
    stt.last.say('ええ', ['ja']);
    stt.last.say('So', ['en']);
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['こんにちは', 'はい', 'ええ'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['So', 'untimed']],
    );
  });

  it('skips speech from the sides of the phone while their voice is not known, and learns nothing from it', async () => {
    const { solo, stt, of, words, captions } = soloSetup({ voices: printer, directions: true });
    const say = (i: number, text: string, langs: string[], delay: number, voice: number) => {
      sendFrom(solo, delay, { seconds: 2, voice });
      stt.last.say(text, langs, { start: i * 2, end: i * 2 + 2 });
    };
    say(0, 'Hello', ['en'], -5, 1000);
    say(1, 'こんにちは', ['ja'], 5, 2000);
    say(2, 'How are you?', ['en'], -5, 1000);
    say(3, '元気です', ['ja'], 5, 2000);
    await settle();
    // A stranger beside the phone, on and on: not shown, even live.
    for (let i = 4; i < 7; i++) {
      sendFrom(solo, 0, { seconds: 2, voice: 3000 });
      stt.last.hear('いらっしゃい', ['ja'], { start: i * 2, end: i * 2 + 1 });
      stt.last.say('いらっしゃいませ', ['ja'], { start: i * 2, end: i * 2 + 2 });
      await settle();
    }
    assert.deepEqual(captions(), []);
    assert.deepEqual(
      of('voices').map((m) => m.partner),
      ['unknown'],
    );
    say(7, 'ありがとう', ['ja'], 5, 2000);
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Hello', 'こんにちは', 'How are you?', '元気です', 'ありがとう'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['いらっしゃいませ', 'direction'],
        ['いらっしゃいませ', 'direction'],
        ['いらっしゃいませ', 'direction'],
      ],
    );
    assert.deepEqual(
      of('voices').map((m) => m.partner),
      ['unknown', 'learned'],
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

    // The other person: shown at once while their voice is not known, as all said for them is translated.
    solo.sendAudio(sound(2, 2000));
    stt.last.hear('こんにちは', ['ja'], { start: 6, end: 6.5 });
    await settle();
    stt.last.say('こんにちは', ['ja'], { start: 6, end: 8 });
    await settle();
    assert.deepEqual(captions(), ['Where is the', 'Where is the station', 'こんにちは']);

    // Once it is known, someone else talking for them shows nothing either, however long;
    // they show once there is enough of it to tell their voice.
    solo.usePartner(print(2000));
    solo.sendAudio(sound(3, 3000));
    for (const end of [9.5, 10, 10.5, 11]) {
      stt.last.hear('いらっしゃいませ', ['ja'], { start: 8, end });
      await settle();
    }
    stt.last.say('いらっしゃいませ', ['ja'], { start: 8, end: 11 });
    await settle();
    solo.sendAudio(sound(2, 2000));
    stt.last.hear('いい', ['ja'], { start: 11, end: 12 });
    await settle();
    stt.last.hear('いい天気', ['ja'], { start: 11, end: 12.5 });
    await settle();
    assert.deepEqual(captions(), ['Where is the', 'Where is the station', 'こんにちは', 'いい天気']);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['Where is the station?', 'こんにちは'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Somebody else here', 'voice'],
        ['いらっしゃいませ', 'voice'],
      ],
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

  it('writes out held speech only in one of the two voices', async () => {
    const { solo, stt, of, words, captions } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 3000)); // a stranger, or a song
    solo.sendAudio(sound(2, 1000)); // me
    stt.last.hear('Somebody', ['en'], { start: 0, end: 2 });
    stt.last.say('Somebody else', ['en'], { start: 0, end: 2 });
    stt.last.say('Hello', ['en'], { start: 2, end: 4 });
    await settle();
    // Them, shown as they are heard while their voice is not known: all said for them is translated.
    solo.sendAudio(sound(6, 2000));
    solo.sendAudio(sound(2, 3000)); // the stranger, once their voice is known
    stt.last.hear('こんにちは', ['ja'], { start: 4, end: 5 });
    stt.last.say('こんにちは', ['ja'], { start: 4, end: 6 });
    stt.last.say('駅はどこですか', ['ja'], { start: 6, end: 8 });
    stt.last.say('遠いですか', ['ja'], { start: 8, end: 10 });
    stt.last.say('いらっしゃいませ', ['ja'], { start: 10, end: 12 });
    stt.last.say('One', ['en']); // untimed: whose voice it is can't be told
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [
        ['me', 'Hello'],
        ['them', 'こんにちは'],
        ['them', '駅はどこですか'],
        ['them', '遠いですか'],
      ],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['Somebody else', 'voice'],
        ['いらっしゃいませ', 'voice'],
        ['One', 'untimed'],
      ],
    );
    assert.deepEqual(captions(), ['こんにちは']);
    assert.deepEqual(of('error'), []);
  });

  it('learns my voice here from held speech only somewhat like my recording just until it is known', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 1000)); // me, as recorded
    solo.sendAudio(sound(2, 5000)); // somewhat like my recording: me, or someone talking over me
    solo.sendAudio(sound(2, 3000)); // like neither my recording nor my voice here, but like that last voice
    stt.last.say('One', ['en'], { start: 0, end: 2 });
    stt.last.say('Two', ['en'], { start: 2, end: 4 });
    stt.last.say('Three', ['en'], { start: 4, end: 6 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One', 'Two'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['Three', 'voice']],
      'not learned from the second voice, so the third is not taken for mine',
    );

    // While nothing is known of my voice here, such speech is where to start.
    const next = soloSetup({ voices: printer });
    next.solo.setTalkMode('hold');
    next.solo.sendAudio(sound(2, 5000));
    next.solo.sendAudio(sound(2, 15000)); // like that, but hardly like my recording
    next.stt.last.say('One', ['en'], { start: 0, end: 2 });
    next.stt.last.say('Two', ['en'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(
      next.of('utterance').map((m) => m.text),
      ['One', 'Two'],
    );
    assert.deepEqual(next.of('skipped'), []);
  });

  it('skips held speech somewhat like my recording but unlike my voice here, once that is settled', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 7000)); // me, as heard here
    solo.sendAudio(sound(2, 10000)); // someone else, somewhat like my recording and nothing like my voice here
    stt.last.say('One', ['en'], { start: 0, end: 2 });
    stt.last.say('Two', ['en'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One', 'Two'],
      'passes while my voice here is known from one line only',
    );
    solo.sendAudio(sound(2, 7000));
    solo.sendAudio(sound(2, 7000));
    solo.sendAudio(sound(2, 10000));
    stt.last.say('Three', ['en'], { start: 4, end: 6 });
    stt.last.say('Four', ['en'], { start: 6, end: 8 });
    stt.last.say('Five', ['en'], { start: 8, end: 10 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One', 'Two', 'Three', 'Four'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['Five', 'voice']],
      'my voice here is settled from three lines, and this is nothing like it',
    );
    // Clearly my recording still passes whatever my voice here says.
    solo.sendAudio(sound(2, 1000));
    stt.last.say('Six', ['en'], { start: 10, end: 12 });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(-1), ['Six']);
    // What was skipped can still be asked for.
    solo.accept(of('skipped')[0]!.id);
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(-1), ['Five']);
  });

  it('settles my voice here from two lines long enough, as from three', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(9, 7000)); // me, as heard here, at length
    solo.sendAudio(sound(2, 10000)); // someone else, somewhat like my recording and nothing like my voice here
    stt.last.say('One', ['en'], { start: 0, end: 9 });
    stt.last.say('Two', ['en'], { start: 9, end: 11 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['One', 'Two'],
      'passes while my voice here is known from one line only, however long',
    );
    solo.sendAudio(sound(2, 7000));
    solo.sendAudio(sound(2, 10000));
    stt.last.say('Three', ['en'], { start: 11, end: 13 });
    stt.last.say('Four', ['en'], { start: 13, end: 15 });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text), ['One', 'Two', 'Three']);
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['Four', 'voice']],
      'my voice here is settled from two lines of 8 seconds in all, and this is nothing like it',
    );
  });

  it('takes held speech for mine when it is only somewhat like my voice, and says once when it is nothing like it', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, of, words } = soloSetup({ voices: printer, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(2, 5000)); // me, only somewhat like my recording
    for (let i = 0; i < 3; i++) solo.sendAudio(sound(2, 2000)); // someone else, while I hold the button
    stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    stt.last.say('One', ['en'], { start: 2, end: 4 });
    stt.last.say('Two', ['en'], { start: 4, end: 6 });
    stt.last.say('Three', ['en'], { start: 6, end: 8 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [['me', 'Hello']],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['One', 'voice'],
        ['Two', 'voice'],
        ['Three', 'voice'],
      ],
    );
    assert.deepEqual(
      of('error').map((m) => [m.fatal, m.message]),
      [[false, 'Your voice sounds unlike your recording of it here: tap the lines that are yours, or record it again in Settings.']],
    );
    assert.deepEqual(
      entries.filter((e) => e.type === 'unlike-recording'),
      [{ type: 'unlike-recording' }],
    );
  });

  it('learns my voice here from held lines translated after all, and takes it up in the next conversation', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    solo.setTalkMode('hold');
    solo.sendAudio(sound(4, 2000)); // me through earphones in a crowd: nothing like my recording
    stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    await settle();
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [['Hello', 'voice']],
    );
    solo.accept(of('skipped')[0]!.id);
    stt.last.say('Where is the station', ['en'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [
        ['me', 'Hello'],
        ['me', 'Where is the station'],
      ],
    );
    assert.equal(of('skipped').length, 1);
    assert.deepEqual([rounded(solo.myVoiceHere!.sum), solo.myVoiceHere!.count], [[0, 1, 0], 1]);

    // Through the same microphone, the next time.
    const entries: TalkReportEntry[] = [];
    const next = soloSetup({ voices: printer, report: (entry) => entries.push(entry) });
    assert.equal(next.solo.useMyVoiceHere(solo.myVoiceHere), true);
    next.solo.setTalkMode('hold');
    next.solo.sendAudio(sound(2, 13000));
    next.stt.last.say('Good morning', ['en'], { start: 0, end: 2 });
    await settle();
    assert.deepEqual(
      next.of('utterance').map((m) => [m.speakerId, m.text]),
      [['me', 'Good morning']],
    );
    assert.deepEqual(
      entries.filter((e) => e.type === 'my-voice-here'),
      [{ type: 'my-voice-here', prints: 1 }],
    );
    assert.equal(soloSetup().solo.useMyVoiceHere(solo.myVoiceHere), false, 'voices not checked');

    // Hands-free, nobody says whose a line is: translating it after all teaches nothing of a voice so unlike mine.
    const free = soloSetup({ voices: printer });
    free.solo.sendAudio(sound(4, 2000));
    free.stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    await settle();
    free.solo.accept(free.of('skipped')[0]!.id);
    free.stt.last.say('Where is the station', ['en'], { start: 2, end: 4 });
    await settle();
    assert.deepEqual(
      free.of('skipped').map((m) => [free.words(m), m.reason]),
      [
        ['Hello', 'voice'],
        ['Where is the station', 'voice'],
      ],
    );
    assert.equal(free.solo.myVoiceHere, undefined);
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

describe('one phone with a recognizer paid by the second', () => {
  const tenths = (x: number) => Math.round(x * 10) / 10;

  it('keeps other voices and silence from the recognizer, once my voice has been heard here', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, of } = soloSetup({ voices: gatePrinter, metered: true, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    solo.setSpeaker('me');
    const sent = () => stt.last.audio.length;
    // Me, in my voice as recorded: let through.
    await hearIn(solo, 2, 1000);
    assert.equal(sent(), 20);
    stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    await settle();
    // A stranger: kept back after a few pieces in a row in another voice.
    await hearIn(solo, 3, 3000);
    assert.equal(sent(), 40);
    // Silence after them: nothing.
    await hearIn(solo, 1, 0);
    assert.equal(sent(), 40);
    // Me again: let through from a little before the first piece in my voice.
    await hearIn(solo, 2, 1000);
    assert.equal(sent(), 73);
    // The recognizer times what it heard on its own clock: 6 s to 8 s of the conversation were its 5.3 s to 7.3 s.
    stt.last.say('Hello again', ['en'], { start: 5.3, end: 7.3 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => [m.speakerId, m.text]),
      [
        ['me', 'Hello'],
        ['me', 'Hello again'],
      ],
    );
    assert.deepEqual(of('skipped'), []);
    const lines = entries.filter((e) => e.type === 'line');
    assert.equal(lines.length, 2);
    const again = lines[1]!;
    assert.ok(Math.abs(again.start! - 5.9) < 0.15 && Math.abs(again.end! - 8.1) < 0.15, `${again.start} - ${again.end}`);
    assert.deepEqual(
      entries.filter((e) => e.type === 'gate').map((e) => [tenths(e.start), tenths(e.end), e.verdict, e.open]),
      [
        [0, 1.5, 'ours', true],
        [0.5, 2, 'ours', true],
        [1, 2.5, 'ours', true],
        [1.5, 3, 'other', true],
        [2, 3.5, 'other', true],
        [2.5, 4, 'other', false],
        [3, 4.5, 'other', false],
        [3.5, 5, 'other', false],
        [4, 5.5, 'other', false],
        [4.5, 6, 'other', false],
        [5, 6.5, 'ours', true],
        [5.5, 7, 'ours', true],
        [6, 7.5, 'ours', true],
        [6.5, 8, 'ours', true],
      ],
    );
    assert.deepEqual(entries.filter((e) => e.type === 'gate')[0]?.voice, { mine: 1, mineHere: -1, partner: -1, partnerHere: -1 });
    solo.close();
    const [report] = entries.filter((e) => e.type === 'sent');
    assert.deepEqual([tenths(report!.heard), tenths(report!.sent)], [8, 7.3]);
  });

  it('leaves out words said over mine in a voice unlike mine here, by the pieces the gate judged, when the recognizer heard one talker', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, of } = soloSetup({ voices: gatePrinter, metered: true, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    solo.setSpeaker('me');
    // The gate opens on the first piece of sound, which is in my voice, from its start: the recognizer's clock is the conversation's.
    const word = (text: string, start: number, end = start + 0.4) => ({ text, start, end });
    // Three lines in my voice as heard here settle it.
    await hearIn(solo, 2, 7000);
    for (let i = 1; i <= 3; i++) {
      await hearIn(solo, 2, 7000);
      stt.last.say('Yes.', ['en'], { start: i * 2, end: i * 2 + 2 });
      await settle();
    }
    assert.deepEqual(of('utterance').map((m) => m.text), ['Yes.', 'Yes.', 'Yes.']);

    // Someone somewhat like my recording, but unlike my voice here, talks over me: the gate lets them through, and the recognizer hears one talker.
    await hearIn(solo, 2.5, 7000); // 8–10.5 s: me
    await hearIn(solo, 2, 10000); // 10.5–12.5 s: someone else
    await hearIn(solo, 2, 7000); // 12.5–14.5 s: me
    stt.last.say('Hello there friend. Hey you listen now. Where is it?', Array(10).fill('en'), {
      start: 8.2,
      end: 14,
      words: [
        word('Hello', 8.2),
        word('there', 8.8),
        word('friend.', 9.6),
        word('Hey', 10.6),
        word('you', 11.1),
        word('listen', 11.6),
        word('now.', 12.1, 12.4),
        word('Where', 12.6),
        word('is', 13.1),
        word('it?', 13.6),
      ],
    });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(3), ['Hello there friend. Where is it?']);
    assert.deepEqual(
      of('skipped').map((m) => [m.id, m.reason]),
      [['u5', 'voice']],
    );
    // A few words of theirs, too short to judge by their own sound: by the pieces over them.
    await hearIn(solo, 2, 7000); // 14.5–16.5 s: me
    await hearIn(solo, 1.4, 10000); // 16.5–17.9 s: someone else
    await hearIn(solo, 2, 7000); // 17.9–19.9 s: me
    stt.last.say('So friend. Hey you two. Where now?', Array(7).fill('en'), {
      start: 14.7,
      end: 19,
      words: [word('So', 14.7), word('friend.', 16.0), word('Hey', 16.6), word('you', 17.1), word('two.', 17.6, 17.8), word('Where', 18.0), word('now?', 18.6)],
    });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(4), ['So friend. Where now?']);
    assert.deepEqual(
      of('skipped').map((m) => [m.id, m.reason]),
      [
        ['u5', 'voice'],
        ['u7', 'voice'],
      ],
    );
    solo.accept('u5');
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(5), ['Hey you listen now.'], 'what was left out can still be asked for');
    assert.deepEqual(
      entries.filter((e) => e.type === 'parts').map((e) => e.type === 'parts' && e.parts.map((part) => [part.text, part.kept, part.apart ?? false, part.id, part.voice !== undefined])),
      [
        [
          ['Hello there friend. Where is it?', true, false, undefined, true],
          ['Hey you listen now.', false, true, 'u5', true],
        ],
        [
          ['So friend. Where now?', true, false, undefined, true],
          ['Hey you two.', false, true, 'u7', false],
        ],
      ],
    );
    const line = entries.find((e) => e.type === 'line' && e.id === 'u4');
    assert.equal(line && line.type === 'line' && line.kept, 'Hello there friend. Where is it?');
  });

  it('judges a part too short for a voice print by the pieces the gate judged over it', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, of } = soloSetup({ voices: gatePrinter, metered: true, report: (entry) => entries.push(entry) });
    solo.setTalkMode('hold');
    solo.setSpeaker('me');
    const word = (text: string, start: number, speaker: string, end = start + 0.4) => ({ text, start, end, speaker });
    // Three lines in my voice as heard here settle it.
    await hearIn(solo, 2, 7000);
    for (let i = 1; i <= 3; i++) {
      await hearIn(solo, 2, 7000);
      stt.last.say('Yes.', ['en'], { start: i * 2, end: i * 2 + 2 });
      await settle();
    }
    assert.deepEqual(of('utterance').map((m) => m.text), ['Yes.', 'Yes.', 'Yes.']);

    // Someone else's last word gets a label of its own, too short to print: the pieces over it are in their voice.
    await hearIn(solo, 2, 7000); // 8–10 s: me
    await hearIn(solo, 2, 10000); // 10–12 s: someone else
    await hearIn(solo, 2, 7000); // 12–14 s: me
    stt.last.say('Hello there friend. Hey you listen. Now. Where is it?', Array(10).fill('en'), {
      start: 8.2,
      end: 13.9,
      words: [
        word('Hello', 8.2, '0'),
        word('there', 8.7, '0'),
        word('friend.', 9.2, '0', 9.8),
        word('Hey', 10.1, '1'),
        word('you', 10.6, '1'),
        word('listen.', 11.0, '1', 11.4),
        word('Now.', 11.5, '2', 11.8),
        word('Where', 12.3, '0'),
        word('is', 12.8, '0'),
        word('it?', 13.3, '0', 13.9),
      ],
    });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(3), ['Hello there friend. Where is it?']);
    assert.deepEqual(
      of('skipped').map((m) => [m.id, m.reason]),
      [
        ['u5', 'voice'],
        ['u6', 'voice'],
      ],
    );

    // A short word of mine with a label of its own, among my words: the pieces over it are in my voice.
    await hearIn(solo, 2, 7000); // 14–16 s: me
    await hearIn(solo, 2, 7000); // 16–18 s: me
    stt.last.say('So. Where is it?', Array(4).fill('en'), {
      start: 14.2,
      end: 16.8,
      words: [word('So.', 14.2, '2', 14.5), word('Where', 15.0, '0'), word('is', 15.6, '0'), word('it?', 16.2, '0', 16.8)],
    });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text).slice(4), ['So. Where is it?']);
    assert.equal(of('skipped').length, 2);
    assert.deepEqual(
      entries.filter((e) => e.type === 'parts').map((e) => e.type === 'parts' && e.parts.map((part) => [part.text, part.kept, part.id])),
      [
        [
          ['Hello there friend. Where is it?', true, undefined],
          ['Hey you listen.', false, 'u5'],
          ['Now.', false, 'u6'],
        ],
        [
          ['So.', true, undefined],
          ['Where is it?', true, undefined],
        ],
      ],
    );
  });

  it('sends on what was heard but not judged yet when a turn ends, so that no short line is lost', async () => {
    const { solo, stt, of } = soloSetup({ voices: gatePrinter, metered: true });
    solo.setTalkMode('hold');
    solo.setSpeaker('me');
    const sent = () => stt.last.audio.length;
    // A short line, let go of before any piece of it was judged.
    await hearIn(solo, 1.2, 1000);
    assert.equal(sent(), 0);
    solo.flush();
    await settle();
    assert.equal(sent(), 12);
    assert.equal(stt.last.finalized, 1);
    // My voice here, learned from what I say holding the button.
    await hearIn(solo, 2, 1000);
    assert.equal(sent(), 32);
    stt.last.say('Hello', ['en'], { start: 1.2, end: 3.2 });
    await settle();
    assert.deepEqual(of('utterance').map((m) => m.text), ['Hello']);
    // A stranger, let go of right after the gate closed on them: only what was not judged yet is sent on, in case it was the end of a line.
    await hearIn(solo, 3.3, 3000);
    assert.equal(sent(), 52);
    solo.flush();
    await settle();
    assert.equal(sent(), 55);
    assert.equal(stt.last.finalized, 2);
    // Let go of as a piece is being judged: the turn ends once the verdict is in, and sound heard meanwhile is the next turn's.
    for (let i = 0; i < 15; i++) solo.sendAudio(sound(0.1, 1000));
    solo.flush();
    solo.sendAudio(sound(0.1, 3000));
    await settle();
    assert.equal(sent(), 70);
    assert.equal(stt.last.finalized, 3);
    await hearIn(solo, 1.4, 3000);
    assert.equal(sent(), 70, 'the next turn, in another voice, judged on its own');
  });

  it('keeps the voice the user said was not theirs from the recognizer, and no other until theirs is known', async () => {
    const { solo, stt, of } = soloSetup({ voices: gatePrinter, metered: true });
    solo.setTalkMode('hold');
    solo.setSpeaker('them');
    const sent = () => stt.last.audio.length;
    // Whatever is said for them is let through until their voice is known, and theirs learned from it.
    for (let i = 0; i < 3; i++) {
      await hearIn(solo, 2, 2000);
      stt.last.say('こんにちは', ['ja'], { start: i * 2, end: i * 2 + 2 });
      await settle();
    }
    assert.equal(sent(), 60);
    assert.equal(of('voices').at(-1)?.partner, 'learned');
    // Their voice here is not known yet: a stranger is let through.
    await hearIn(solo, 2, 3000);
    assert.equal(sent(), 80);
    // Them again: their voice here is learned from it.
    await hearIn(solo, 2, 2000);
    stt.last.say('駅はどこですか', ['ja'], { start: 8, end: 10 });
    await settle();
    assert.equal(sent(), 100);
    // Hands-free, either of us may talk: nothing is kept out until my voice has been heard here too.
    // (Choosing who talks opens a new recognizer stream, which counts from nothing.)
    solo.setSpeaker('auto');
    await hearIn(solo, 3, 3000);
    assert.equal(sent(), 30);
    // For them: a stranger is kept out after a few pieces.
    solo.setSpeaker('them');
    await hearIn(solo, 3, 3000);
    assert.equal(sent(), 15);
    // The voice learned for them was someone else's, the user says: kept out from then on, and theirs unknown again,
    // so that anyone else may be them: the stranger's last words are let through on the way.
    solo.forgetPartner();
    assert.equal(of('voices').at(-1)?.partner, 'unknown');
    await hearIn(solo, 3, 2000);
    assert.equal(sent(), 48);
    await hearIn(solo, 2, 3000);
    assert.equal(sent(), 76);
  });

  it('keeps nothing from the recognizer while their voice is recorded', async () => {
    const { solo, stt } = soloSetup({ voices: gatePrinter, metered: true });
    solo.setTalkMode('hold');
    solo.setSpeaker('me');
    const sent = () => stt.last.audio.length;
    await hearIn(solo, 2, 1000);
    stt.last.say('Hello', ['en'], { start: 0, end: 2 });
    await settle();
    solo.recordPartner();
    await hearIn(solo, 3, 3000);
    assert.equal(sent(), 50);
    solo.stopRecording();
    await hearIn(solo, 3, 3000);
    assert.equal(sent(), 65);
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
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 2000));
      stt.last.say('はい', ['ja'], { start: i * 2, end: i * 2 + 2 });
      await settle();
      assert.deepEqual(voicesOf(messages), i < 2 ? ['unknown'] : ['unknown', 'learned'], `after ${i + 1}`);
    }
    solo.usePartner(print(2000));
    assert.deepEqual(voicesOf(messages), ['unknown', 'learned', 'recorded']);
    assert.deepEqual(soloSetup().of('voices'), [], 'not without voice prints');
  });

  it('records their voice, then translates what they said lately that the voice learned left out', async () => {
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer });
    // Someone else spoke first, long enough for their voice to be taken for theirs.
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 3000));
      stt.last.say('すみません', ['ja'], { start: i * 2, end: i * 2 + 2 });
    }
    solo.sendAudio(sound(2, 2000));
    stt.last.say('こんにちは', ['ja'], { start: 6, end: 8 });
    await settle();
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 3, voice: 2000 });
    stt.last.say('はじめまして', ['ja'], { start: 9, end: 12 });
    await settle();
    assert.deepEqual(of('skipped').map(words), ['こんにちは', 'はじめまして'], 'not before their voice is recorded');
    sendFrom(solo, undefined, { seconds: 4, voice: 2000 });
    await settle();
    // Now only the recorded voice is theirs.
    solo.sendAudio(sound(2, 3000));
    stt.last.say('ちょっと', ['ja'], { start: 16, end: 18 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('よろしく', ['ja'], { start: 18, end: 20 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['すみません', 'すみません', 'すみません', 'こんにちは', 'はじめまして', 'よろしく'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['こんにちは', 'voice'],
        ['はじめまして', 'voice'],
        ['ちょっと', 'voice'],
      ],
    );
    assert.deepEqual(voicesOf(messages), [
      'unknown',
      'learned',
      'learned 0/6',
      'learned 1/6',
      'learned 2/6',
      'learned 3/6',
      'learned 4/6',
      'learned 5/6',
      'learned 6/6',
      'recorded',
    ]);
  });

  it('records their voice while all said for them is translated, until it is known', async () => {
    const { solo, stt, messages, of } = soloSetup({ voices: printer });
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 3, voice: 2000 });
    stt.last.say('はじめまして', ['ja'], { start: 1, end: 4 });
    await settle();
    sendFrom(solo, undefined, { seconds: 4, voice: 2000 });
    await settle();
    solo.sendAudio(sound(2, 3000));
    stt.last.say('ちょっと', ['ja'], { start: 8, end: 10 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['はじめまして'],
    );
    assert.equal(voicesOf(messages).at(-1), 'recorded');
  });

  it('translates nothing it left out when the recording of their voice is stopped', async () => {
    const { solo, stt, of, words } = soloSetup({ voices: printer });
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 3000));
      stt.last.say('すみません', ['ja'], { start: i * 2, end: i * 2 + 2 });
    }
    await settle();
    solo.recordPartner();
    sendFrom(solo, undefined, { voice: 100 });
    sendFrom(solo, undefined, { seconds: 3, voice: 2000 });
    stt.last.say('はじめまして', ['ja'], { start: 7, end: 10 });
    await settle();
    solo.stopRecording();
    sendFrom(solo, undefined, { seconds: 4, voice: 2000 });
    await settle();
    assert.equal(of('utterance').length, 3);
    assert.deepEqual(of('skipped').map(words), ['はじめまして']);
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

  it('takes a line translated after all for theirs when the voice learned was nothing like it, and what they said lately in it', async () => {
    const entries: TalkReportEntry[] = [];
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer, report: (entry) => entries.push(entry) });
    // The radio, before they said anything.
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 3000));
      stt.last.say('ニュースです', ['ja'], { start: i * 2, end: i * 2 + 2 });
    }
    solo.sendAudio(sound(2, 2000));
    stt.last.say('こんにちは', ['ja'], { start: 6, end: 8 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('すみません', ['ja'], { start: 8, end: 10 });
    await settle();
    assert.deepEqual(of('skipped').map(words), ['こんにちは', 'すみません']);
    solo.accept(of('skipped')[1]!.id);
    solo.sendAudio(sound(2, 3000));
    stt.last.say('天気予報です', ['ja'], { start: 10, end: 12 });
    solo.sendAudio(sound(2, 2000));
    stt.last.say('駅はどこですか', ['ja'], { start: 12, end: 14 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['ニュースです', 'ニュースです', 'ニュースです', 'すみません', 'こんにちは', '駅はどこですか'],
    );
    assert.deepEqual(of('skipped').map(words), ['こんにちは', 'すみません', '天気予報です']);
    assert.deepEqual(voicesOf(messages), ['unknown', 'learned', 'learned'], 'told again, as their voice was learned afresh');
    assert.deepEqual(
      entries.filter((e) => e.type === 'translated-after-all'),
      [
        { type: 'translated-after-all', id: 'u5', why: 'asked' },
        { type: 'translated-after-all', id: 'u4', why: 'learned' },
      ],
    );
  });

  it('forgets the voice learned for them when the phone says it was someone else’s, and learns theirs afresh', async () => {
    const { solo, stt, messages, of, words } = soloSetup({ voices: printer });
    // The radio, before they said anything.
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 3000));
      stt.last.say('ニュースです', ['ja'], { start: i * 2, end: i * 2 + 2 });
    }
    solo.sendAudio(sound(2, 2000));
    stt.last.say('こんにちは', ['ja'], { start: 6, end: 8 });
    await settle();
    assert.deepEqual(of('skipped').map(words), ['こんにちは']);
    solo.forgetPartner();
    assert.deepEqual(voicesOf(messages), ['unknown', 'learned', 'unknown']);
    solo.forgetPartner();
    assert.deepEqual(voicesOf(messages), ['unknown', 'learned', 'unknown'], 'nothing learned to forget');
    // The radio is skipped from now on, and theirs learned from what else is said for them.
    solo.sendAudio(sound(2, 3000));
    stt.last.say('天気予報です', ['ja'], { start: 8, end: 10 });
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 2000));
      stt.last.say('駅はどこですか', ['ja'], { start: 10 + i * 2, end: 12 + i * 2 });
    }
    solo.sendAudio(sound(2, 3000));
    stt.last.say('以上です', ['ja'], { start: 16, end: 18 });
    await settle();
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['ニュースです', 'ニュースです', 'ニュースです', '駅はどこですか', '駅はどこですか', '駅はどこですか'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['こんにちは', 'voice'],
        ['天気予報です', 'voice'],
        ['以上です', 'voice'],
      ],
    );
    assert.deepEqual(voicesOf(messages), ['unknown', 'learned', 'unknown', 'learned']);
    assert.deepEqual([...solo.partnerPrint!], [0, 1, 0]);
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
    // A voice taken for theirs that was not.
    for (let i = 0; i < 3; i++) {
      solo.sendAudio(sound(2, 3000));
      stt.last.say('すみません', ['ja'], { start: i * 2, end: i * 2 + 2 });
    }
    solo.sendAudio(sound(2, 2000));
    stt.last.say('おはよう', ['ja'], { start: 6, end: 8 });
    await settle();
    solo.sendAudio(sound(61, 100));
    solo.sendAudio(sound(2, 2000));
    stt.last.say('はい', ['ja'], { start: 69, end: 71 });
    solo.sendAudio(sound(2, 6000));
    stt.last.say('いらっしゃいませ', ['ja'], { start: 71, end: 73 });
    await settle();
    assert.equal(solo.usePartner(print(2000)), true);
    assert.deepEqual(
      of('utterance').map((m) => m.text),
      ['すみません', 'すみません', 'すみません', 'はい'],
    );
    assert.deepEqual(
      of('skipped').map((m) => [words(m), m.reason]),
      [
        ['おはよう', 'voice'],
        ['はい', 'voice'],
        ['いらっしゃいませ', 'voice'],
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
