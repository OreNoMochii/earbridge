import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrderedSpeechQueue } from '../src/speech-queue.ts';
import type { SpeechItem } from '../src/speech-queue.ts';

/** A queue with a fake clock and a fake speech engine whose utterances the test finishes. */
function setup(options: { maxWaitMs?: number } = {}) {
  let now = 0;
  let timers: Array<{ at: number; run: () => void }> = [];
  const spoken: string[] = [];
  const speakingChanges: boolean[] = [];
  let finishCurrent: (() => void) | undefined;
  let failNext: 'throw' | 'reject' | undefined;

  const queue = new OrderedSpeechQueue({
    speak: (item: SpeechItem) => {
      spoken.push(item.text);
      if (failNext === 'throw') {
        failNext = undefined;
        throw new Error('engine broke');
      }
      if (failNext === 'reject') {
        failNext = undefined;
        return Promise.reject(new Error('engine broke'));
      }
      return new Promise<void>((resolve) => (finishCurrent = resolve));
    },
    onSpeakingChange: (speaking) => speakingChanges.push(speaking),
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => (timers = timers.filter((t) => t !== timer));
    },
    ...options,
  });

  return {
    queue,
    spoken,
    speakingChanges,
    item: (id: string, text = id): SpeechItem => ({ id, text, lang: 'en-US' }),
    /** Finishes the utterance being spoken and lets the queue react. */
    async finish() {
      const finish = finishCurrent;
      finishCurrent = undefined;
      assert.ok(finish, 'nothing is being spoken');
      finish();
      await settle();
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const timer of due) timer.run();
    },
    failNext(how: 'throw' | 'reject') {
      failNext = how;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('OrderedSpeechQueue', () => {
  it('speaks translations in the order the utterances were heard', async () => {
    const { queue, spoken, item, finish } = setup();
    queue.expect('a');
    queue.expect('b');
    queue.ready(item('b'));
    assert.deepEqual(spoken, [], 'b waits for a');
    queue.ready(item('a'));
    assert.deepEqual(spoken, ['a']);
    await finish();
    assert.deepEqual(spoken, ['a', 'b']);
  });

  it('speaks one item at a time', async () => {
    const { queue, spoken, item, finish } = setup();
    queue.ready(item('a'));
    queue.ready(item('b'));
    assert.deepEqual(spoken, ['a']);
    await finish();
    assert.deepEqual(spoken, ['a', 'b']);
  });

  it('stops waiting for a slow translation and speaks it when it arrives', async () => {
    const { queue, spoken, item, advance, finish } = setup({ maxWaitMs: 8_000 });
    queue.expect('slow');
    queue.expect('fast');
    queue.ready(item('fast'));
    advance(7_999);
    assert.deepEqual(spoken, []);
    advance(1);
    assert.deepEqual(spoken, ['fast']);
    queue.ready(item('slow'));
    await finish();
    assert.deepEqual(spoken, ['fast', 'slow']);
  });

  it('moves on when a translation is skipped', () => {
    const { queue, spoken, item } = setup();
    queue.expect('failed');
    queue.expect('ok');
    queue.ready(item('ok'));
    queue.skip('failed');
    assert.deepEqual(spoken, ['ok']);
    queue.skip('unknown'); // harmless
  });

  it('can give up on everything still pending, e.g. after a disconnect', async () => {
    const { queue, spoken, item } = setup();
    queue.expect('a');
    queue.expect('b');
    queue.expect('c');
    queue.ready(item('c'));
    queue.skipPending();
    assert.deepEqual(spoken, ['c']);
  });

  it('reports speaking once per stretch of speech, for muting the microphone', async () => {
    const { queue, speakingChanges, item, finish } = setup();
    queue.ready(item('a'));
    queue.ready(item('b'));
    await finish();
    assert.deepEqual(speakingChanges, [true], 'no gap between consecutive items');
    await finish();
    assert.deepEqual(speakingChanges, [true, false]);
  });

  it('forgets everything on clear, including the item being spoken', async () => {
    const { queue, spoken, speakingChanges, item, finish } = setup();
    queue.ready(item('a'));
    queue.ready(item('b'));
    queue.expect('c');
    queue.clear();
    assert.deepEqual(speakingChanges, [true, false]);
    await finish(); // the engine reports the cancelled item as finished
    assert.deepEqual(spoken, ['a']);
    queue.ready(item('d'));
    assert.deepEqual(spoken, ['a', 'd']);
  });

  it('holds everything back while paused', async () => {
    const { queue, spoken, speakingChanges, item, advance, finish } = setup({ maxWaitMs: 8_000 });
    queue.ready(item('a'));
    queue.setPaused(true);
    queue.ready(item('b'));
    queue.expect('c');
    await finish(); // the caller cut 'a' short
    advance(60_000);
    assert.deepEqual(spoken, ['a']);
    assert.deepEqual(speakingChanges, [true, false]);
    queue.setPaused(false);
    assert.deepEqual(spoken, ['a', 'b']);
    await finish();
    assert.deepEqual(spoken, ['a', 'b'], "c's translation never came");
  });

  it('keeps going when the speech engine fails', async () => {
    const { queue, spoken, item, failNext } = setup();
    failNext('throw');
    queue.ready(item('a'));
    queue.ready(item('b'));
    await settle();
    assert.deepEqual(spoken, ['a', 'b']);

    const second = setup();
    second.failNext('reject');
    second.queue.ready(second.item('a'));
    second.queue.ready(second.item('b'));
    await settle();
    assert.deepEqual(second.spoken, ['a', 'b']);
  });
});
