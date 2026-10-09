import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';

const base = { DEEPGRAM_API_KEY: 'dg-key' };

describe('loadConfig', () => {
  it('translates and reads aloud with DeepInfra when its key is set', () => {
    const config = loadConfig({ ...base, DEEPINFRA_API_KEY: 'di-key', ANTHROPIC_API_KEY: 'sk-ant' });
    assert.deepEqual(config.translation, { provider: 'deepinfra', apiKey: 'di-key', model: 'google/gemma-4-31B-it' });
    assert.deepEqual(config.voice, { provider: 'deepinfra', apiKey: 'di-key' });
  });

  it('translates with Claude when only an Anthropic key is set, and phones read aloud', () => {
    const config = loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant' });
    assert.deepEqual(config.translation, { provider: 'claude', model: 'claude-opus-5', effort: 'low', hasApiKey: true });
    assert.deepEqual(config.voice, { provider: 'phone' });
  });

  it('follows TRANSLATION_PROVIDER, TRANSLATION_MODEL and VOICE', () => {
    const claude = loadConfig({
      ...base,
      DEEPINFRA_API_KEY: 'di-key',
      TRANSLATION_PROVIDER: 'Claude',
      TRANSLATION_MODEL: 'claude-sonnet-5',
      TRANSLATION_EFFORT: 'medium',
    });
    // An `ant auth login` profile instead of a key.
    assert.deepEqual(claude.translation, { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium', hasApiKey: false });
    assert.equal(claude.voice.provider, 'deepinfra');

    const phone = loadConfig({ ...base, DEEPINFRA_API_KEY: 'di-key', TRANSLATION_MODEL: 'Qwen/Qwen3-32B', VOICE: 'phone' });
    assert.deepEqual(phone.translation, { provider: 'deepinfra', apiKey: 'di-key', model: 'Qwen/Qwen3-32B' });
    assert.deepEqual(phone.voice, { provider: 'phone' });
  });

  for (const [label, env, pattern] of [
    ['no Deepgram key', { DEEPINFRA_API_KEY: 'di-key' }, /DEEPGRAM_API_KEY is not set/],
    ['no translation service', base, /No translation service is set up\. Add DEEPINFRA_API_KEY/],
    ['DeepInfra translation without its key', { ...base, ANTHROPIC_API_KEY: 'sk-ant', TRANSLATION_PROVIDER: 'deepinfra' }, /DEEPINFRA_API_KEY is not set/],
    ['DeepInfra voices without its key', { ...base, ANTHROPIC_API_KEY: 'sk-ant', VOICE: 'deepinfra' }, /VOICE=phone/],
    ['an unknown provider', { ...base, DEEPINFRA_API_KEY: 'di-key', TRANSLATION_PROVIDER: 'openai' }, /TRANSLATION_PROVIDER must be one of deepinfra, claude \(got "openai"\)/],
    ['an unknown voice', { ...base, DEEPINFRA_API_KEY: 'di-key', VOICE: 'robot' }, /VOICE must be one of deepinfra, phone/],
    ['an unknown Claude effort', { ...base, ANTHROPIC_API_KEY: 'sk-ant', TRANSLATION_EFFORT: 'extreme' }, /TRANSLATION_EFFORT must be one of/],
  ] as const) {
    it(`refuses to start with ${label}`, () => {
      assert.throws(() => loadConfig(env), (error: unknown) => error instanceof ConfigError && pattern.test(error.message));
    });
  }
});
