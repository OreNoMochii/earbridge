import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UtteranceSegmenter } from '../../shared/pipeline/stt/segmenter.ts';
import type { SpeechDetails } from '../../shared/pipeline/stt/segmenter.ts';
import type { SttResult } from '../../shared/pipeline/stt/types.ts';

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

  it('reports every language heard and when the speech was, utterance by utterance', () => {
    const details: SpeechDetails[] = [];
    const segmenter = new UtteranceSegmenter({
      interim: (_text, _lang, speech) => details.push(speech),
      utterance: (_text, _lang, speech) => details.push(speech),
    });
    segmenter.handleResult(result('Hola amigo', { isFinal: true, wordLanguages: ['es', 'es'], start: 1.2, end: 2 }));
    segmenter.handleResult(result('OK', { wordLanguages: ['en'], start: 2.1, end: 2.4 }));
    segmenter.handleResult(result('OK', { isFinal: true, speechFinal: true, wordLanguages: ['en'], start: 2.1, end: 2.5 }));
    segmenter.handleResult(result('Thanks', { isFinal: true, speechFinal: true }));
    assert.deepEqual(details, [
      { languages: new Map([['es', 2]]), start: 1.2, end: 2 },
      { languages: new Map([['es', 2], ['en', 1]]), start: 1.2, end: 2.4 },
      { languages: new Map([['es', 2], ['en', 1]]), start: 1.2, end: 2.5 },
      { languages: new Map() },
    ]);
  });
});
