import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UtteranceSegmenter } from '../src/stt/segmenter.ts';
import type { SttResult } from '../src/stt/types.ts';

function setup(maxWords?: number) {
  const interims: Array<[string, string | undefined]> = [];
  const utterances: Array<[string, string | undefined]> = [];
  const segmenter = new UtteranceSegmenter(
    {
      interim: (text, lang) => interims.push([text, lang]),
      utterance: (text, lang) => utterances.push([text, lang]),
    },
    maxWords,
  );
  return { segmenter, interims, utterances };
}

function result(text: string, flags: Partial<SttResult> = {}): SttResult {
  return { text, isFinal: false, speechFinal: false, fromFinalize: false, wordLanguages: [], ...flags };
}

describe('UtteranceSegmenter', () => {
  it('shows interim text on top of the finals heard so far', () => {
    const { segmenter, interims, utterances } = setup();
    segmenter.handleResult(result('Where is'));
    segmenter.handleResult(result('Where is the station', { isFinal: true }));
    segmenter.handleResult(result('please'));
    assert.deepEqual(
      interims.map(([text]) => text),
      ['Where is', 'Where is the station', 'Where is the station please'],
    );
    assert.equal(utterances.length, 0);
  });

  it('emits one utterance when the speaker finishes', () => {
    const { segmenter, utterances } = setup();
    segmenter.handleResult(result('Where is the station', { isFinal: true }));
    segmenter.handleResult(result('please?', { isFinal: true, speechFinal: true }));
    assert.deepEqual(utterances, [['Where is the station please?', undefined]]);
  });

  it('flushes on utterance end and on finalize, but never emits empty utterances', () => {
    const { segmenter, utterances } = setup();
    segmenter.handleUtteranceEnd();
    segmenter.handleResult(result('Thank you', { isFinal: true }));
    segmenter.handleUtteranceEnd();
    segmenter.handleResult(result('Bye', { isFinal: true, fromFinalize: true }));
    segmenter.handleResult(result('', { isFinal: true, speechFinal: true }));
    assert.deepEqual(
      utterances.map(([text]) => text),
      ['Thank you', 'Bye'],
    );
  });

  it('cuts long monologues so listeners are not kept waiting', () => {
    const { segmenter, utterances } = setup(5);
    segmenter.handleResult(result('one two three', { isFinal: true }));
    assert.equal(utterances.length, 0);
    segmenter.handleResult(result('four five six', { isFinal: true }));
    assert.deepEqual(utterances, [['one two three four five six', undefined]]);
  });

  it('also cuts long speech in languages written without spaces', () => {
    const { segmenter, utterances } = setup(3); // cap: 3 words or 18 characters
    segmenter.handleResult(result('今日はとても良い天気ですね', { isFinal: true }));
    assert.equal(utterances.length, 0);
    segmenter.handleResult(result('散歩に行きましょうか', { isFinal: true }));
    assert.equal(utterances.length, 1);
  });

  it('reports the language most words were tagged with', () => {
    const { segmenter, interims, utterances } = setup();
    segmenter.handleResult(result('Hola amigo', { isFinal: true, wordLanguages: ['es', 'es'] }));
    segmenter.handleResult(result('OK', { wordLanguages: ['en'] }));
    assert.equal(interims.at(-1)?.[1], 'es');
    segmenter.handleResult(
      result('OK vamos', { isFinal: true, speechFinal: true, wordLanguages: ['en', 'es'] }),
    );
    assert.deepEqual(utterances, [['Hola amigo OK vamos', 'es']]);
  });
});
