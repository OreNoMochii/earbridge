import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { languageLabel, nativeLanguageName, shortLanguageLabel } from '../src/language-names.ts';
import { defaultSettings, loadSettings, matchLanguage, saveSettings, voiceLanguages } from '../src/settings.ts';
import type { KeyValueStore } from '../src/settings.ts';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const brokenStore: KeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('matchLanguage', () => {
  it('maps browser language tags to the languages the app offers', () => {
    assert.equal(matchLanguage('fr-FR'), 'fr');
    assert.equal(matchLanguage('pt-PT'), 'pt-PT');
    assert.equal(matchLanguage('pt'), 'pt-BR');
    assert.equal(matchLanguage('en-us'), 'en-US');
    assert.equal(matchLanguage('en-AU'), 'en-GB');
    assert.equal(matchLanguage('en'), 'en-US');
    assert.equal(matchLanguage('zh-Hant-HK'), 'zh-TW');
    assert.equal(matchLanguage('zh'), 'zh-CN');
    assert.equal(matchLanguage('nb-NO'), 'no');
    assert.equal(matchLanguage('es_MX'), 'es');
    assert.equal(matchLanguage('xx'), undefined);
  });
});

describe('settings', () => {
  it('defaults to the browser languages', () => {
    const french = defaultSettings(['fr-FR', 'fr', 'en-US']);
    assert.equal(french.myLang, 'fr');
    assert.equal(french.theirLang, 'en-US');
    assert.equal(defaultSettings(['en-GB']).theirLang, 'es');
    assert.equal(defaultSettings(['de-DE']).theirLang, 'en-US');
    assert.equal(defaultSettings(['xx', 'ja']).myLang, 'ja');
    assert.equal(defaultSettings([]).myLang, 'en-US');
    assert.deepEqual(
      { ...defaultSettings(['en-US']), myLang: undefined, theirLang: undefined },
      {
        mode: 'solo',
        myLang: undefined,
        theirLang: undefined,
        name: '',
        talkMode: 'handsfree',
        nearbyOnly: true,
        output: 'earphones',
        voice: 'natural',
        micId: '',
        token: '',
      },
    );
  });

  it('remembers what was saved', () => {
    const store = memoryStore();
    const settings = {
      ...defaultSettings(['en-US']),
      mode: 'room' as const,
      theirLang: 'ja',
      name: 'Sam',
      talkMode: 'hold' as const,
      nearbyOnly: false,
      output: 'speaker' as const,
      voice: 'phone' as const,
      micId: 'abc',
      token: 'secret',
    };
    saveSettings(store, settings);
    assert.deepEqual(loadSettings(store, ['de-DE']), settings);
  });

  it('replaces anything invalid with defaults', () => {
    const store = memoryStore({
      'earbridge.settings': JSON.stringify({
        mode: 'party',
        myLang: 'fr',
        theirLang: 'fr',
        name: 'x'.repeat(100),
        talkMode: 42,
        nearbyOnly: 'no',
        output: null,
        voice: 'robot',
      }),
    });
    const settings = loadSettings(store, ['fr-FR', 'it-IT']);
    assert.equal(settings.mode, 'solo');
    assert.equal(settings.myLang, 'fr');
    assert.equal(settings.theirLang, 'it', 'the two languages must differ');
    assert.equal(settings.name.length, 40);
    assert.equal(settings.talkMode, 'handsfree');
    assert.equal(settings.nearbyOnly, true);
    assert.equal(settings.output, 'earphones');
    assert.equal(settings.voice, 'natural');

    assert.deepEqual(loadSettings(memoryStore({ 'earbridge.settings': '{oops' }), ['en-US']), defaultSettings(['en-US']));
    assert.deepEqual(loadSettings(memoryStore({ 'earbridge.settings': '[]' }), ['en-US']), defaultSettings(['en-US']));
  });

  it('asks for natural voices in the languages this phone reads aloud', () => {
    const solo = { ...defaultSettings(['en-US']), myLang: 'en-US', theirLang: 'es' };
    assert.deepEqual(voiceLanguages(solo), ['en-US']);
    assert.deepEqual(voiceLanguages({ ...solo, output: 'speaker' }), ['en-US', 'es']);
    assert.deepEqual(voiceLanguages({ ...solo, mode: 'room', output: 'speaker' }), ['en-US']);
    assert.deepEqual(voiceLanguages({ ...solo, output: 'speaker', voice: 'phone' }), []);
  });

  it('works without storage', () => {
    assert.deepEqual(loadSettings(undefined, ['en-US']), defaultSettings(['en-US']));
    assert.deepEqual(loadSettings(brokenStore, ['en-US']), defaultSettings(['en-US']));
    saveSettings(brokenStore, defaultSettings(['en-US'])); // does not throw
  });
});

describe('language labels', () => {
  it('shows native names next to the English ones', () => {
    assert.equal(nativeLanguageName('es'), 'Español');
    assert.equal(languageLabel('de'), 'German · Deutsch');
    assert.equal(languageLabel('en-GB'), 'English (UK)');
    assert.equal(shortLanguageLabel('pt-BR'), 'PT');
  });
});
