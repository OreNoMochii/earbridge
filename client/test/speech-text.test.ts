import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitForSpeech } from '../../shared/speech-text.ts';
import { pickVoice } from '../src/speech-text.ts';
import type { VoiceInfo } from '../src/speech-text.ts';

function voice(name: string, lang: string, extra: Partial<VoiceInfo> = {}): VoiceInfo {
  return { name, lang, localService: true, default: false, ...extra };
}

describe('pickVoice', () => {
  it('prefers the exact regional voice, then the same language', () => {
    const voices = [voice('Daniel', 'en-GB'), voice('Samantha', 'en-US'), voice('Monica', 'es-ES')];
    assert.equal(pickVoice(voices, 'en-US')?.name, 'Samantha');
    assert.equal(pickVoice(voices, 'en-GB')?.name, 'Daniel');
    assert.equal(pickVoice(voices, 'es')?.name, 'Monica');
    assert.equal(pickVoice([voice('Luciana', 'pt-BR')], 'pt-PT')?.name, 'Luciana');
  });

  it('understands Android-style tags and legacy codes', () => {
    assert.equal(pickVoice([voice('a', 'fr_FR')], 'fr')?.name, 'a');
    assert.equal(pickVoice([voice('Nora', 'nb-NO')], 'no')?.name, 'Nora');
    assert.equal(pickVoice([voice('Damayanti', 'in-ID')], 'id')?.name, 'Damayanti');
  });

  it('prefers on-device, better-quality voices and avoids novelty ones', () => {
    const voices = [
      voice('Google US English', 'en-US', { localService: false }),
      voice('Zarvox', 'en-US'),
      voice('Ava (Premium)', 'en-US'),
      voice('Samantha', 'en-US', { default: true }),
    ];
    assert.equal(pickVoice(voices, 'en-US')?.name, 'Ava (Premium)');
    assert.notEqual(pickVoice([voice('Zarvox', 'en-US'), voice('Daniel', 'en-GB')], 'en-US')?.name, 'Zarvox');
  });

  it('reads Mandarin with a Mandarin voice rather than a Cantonese one', () => {
    const voices = [voice('Sinji', 'zh-HK'), voice('Meijia', 'zh-TW')];
    assert.equal(pickVoice(voices, 'zh-CN')?.name, 'Meijia');
  });

  it('returns nothing when no voice speaks the language', () => {
    assert.equal(pickVoice([voice('Samantha', 'en-US')], 'ko'), undefined);
    assert.equal(pickVoice([], 'en-US'), undefined);
  });
});

describe('splitForSpeech', () => {
  it('groups whole sentences into pieces that fit', () => {
    assert.deepEqual(splitForSpeech(' Yes. Sure! The train leaves at nine. '), ['Yes. Sure! The train leaves at nine.']);
    assert.deepEqual(splitForSpeech('The train leaves at nine. It is always on time. Please be there early.', 50), [
      'The train leaves at nine. It is always on time.',
      'Please be there early.',
    ]);
    assert.deepEqual(splitForSpeech('  '), []);
  });

  it('splits Chinese and Japanese text, which has no spaces', () => {
    const text = '我们明天早上九点在火车站见面吧。如果你迟到了，请给我打电话告诉我。谢谢！';
    assert.deepEqual(splitForSpeech(text, 20), [
      '我们明天早上九点在火车站见面吧。',
      '如果你迟到了，请给我打电话告诉我。',
      '谢谢！',
    ]);
    const unpunctuated = '今日はとても良い天気ですね'.repeat(4);
    const pieces = splitForSpeech(unpunctuated, 20);
    assert.equal(pieces.join(''), unpunctuated);
    for (const piece of pieces) assert.ok(piece.length <= 20, piece);
  });

  it('cuts long sentences at commas or spaces, never mid-word', () => {
    const text =
      'When you get to the station, take the second exit on the left, walk past the bakery and the ' +
      'flower shop, and then keep going straight for about ten minutes until you see the big church';
    const pieces = splitForSpeech(text, 60);
    assert.equal(pieces.join(' '), text);
    for (const piece of pieces) {
      assert.ok(piece.length <= 60, piece);
      assert.ok(text.includes(` ${piece} `) || text.startsWith(`${piece} `) || text.endsWith(` ${piece}`), piece);
    }
  });
});
