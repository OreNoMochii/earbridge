import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EFFORTS } from './translate/claude.ts';
import type { Effort } from './translate/claude.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type TranslationConfig =
  | { provider: 'deepinfra'; apiKey: string; model: string }
  | {
      provider: 'claude';
      model: string;
      effort: Effort;
      /** False when relying on an `ant auth login` profile instead of an API key. */
      hasApiKey: boolean;
    };

/** Who reads translations aloud: natural voices from DeepInfra, or each phone's own voice. */
export type VoiceConfig = { provider: 'deepinfra'; apiKey: string } | { provider: 'phone' };

const TRANSLATION_PROVIDERS = ['deepinfra', 'claude'] as const;
const VOICE_PROVIDERS = ['deepinfra', 'phone'] as const;

export interface Config {
  port: number;
  deepgramApiKey: string;
  deepgramModel: string;
  /** Override for self-hosted or regional Deepgram endpoints. */
  deepgramUrl: string | undefined;
  translation: TranslationConfig;
  voice: VoiceConfig;
  accessToken: string | undefined;
  /** Extra origins allowed to open the WebSocket, e.g. behind a proxy that rewrites Host. */
  allowedOrigins: string[];
  tls: { cert: Buffer; key: Buffer } | undefined;
  staticDir: string;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** The value of a setting that takes one of a few words, if it is set. */
function readChoice<T extends string>(env: NodeJS.ProcessEnv, name: string, choices: readonly T[]): T | undefined {
  const value = read(env, name);
  if (value === undefined) return undefined;
  const choice = choices.find((candidate) => candidate === value.toLowerCase());
  if (!choice) throw new ConfigError(`${name} must be one of ${choices.join(', ')} (got "${value}").`);
  return choice;
}

const DEEPINFRA_KEYS_URL = 'https://deepinfra.com/dash/api_keys';

function readTranslation(env: NodeJS.ProcessEnv, deepinfraApiKey: string | undefined): TranslationConfig {
  const hasAnthropicKey = Boolean(read(env, 'ANTHROPIC_API_KEY') ?? read(env, 'ANTHROPIC_AUTH_TOKEN'));
  let provider = readChoice(env, 'TRANSLATION_PROVIDER', TRANSLATION_PROVIDERS);
  if (!provider && deepinfraApiKey) provider = 'deepinfra';
  if (!provider && hasAnthropicKey) provider = 'claude';
  if (!provider) {
    throw new ConfigError(
      `No translation service is set up. Add DEEPINFRA_API_KEY to .env (${DEEPINFRA_KEYS_URL}). ` +
        'To translate with Claude instead, set ANTHROPIC_API_KEY, or TRANSLATION_PROVIDER=claude after ' +
        '`ant auth login`.',
    );
  }

  const model = read(env, 'TRANSLATION_MODEL');
  if (provider === 'deepinfra') {
    if (!deepinfraApiKey) {
      throw new ConfigError(`TRANSLATION_PROVIDER is deepinfra, but DEEPINFRA_API_KEY is not set (${DEEPINFRA_KEYS_URL}).`);
    }
    return { provider, apiKey: deepinfraApiKey, model: model ?? 'google/gemma-4-31B-it' };
  }
  const effort = readChoice(env, 'TRANSLATION_EFFORT', EFFORTS) ?? 'low';
  return { provider, model: model ?? 'claude-opus-5', effort, hasApiKey: hasAnthropicKey };
}

function readVoice(env: NodeJS.ProcessEnv, deepinfraApiKey: string | undefined): VoiceConfig {
  const provider = readChoice(env, 'VOICE', VOICE_PROVIDERS) ?? (deepinfraApiKey ? 'deepinfra' : 'phone');
  if (provider === 'phone') return { provider };
  if (!deepinfraApiKey) {
    throw new ConfigError(
      `VOICE is deepinfra, but DEEPINFRA_API_KEY is not set (${DEEPINFRA_KEYS_URL}). ` +
        'Set VOICE=phone to have phones read translations with their own voice.',
    );
  }
  return { provider, apiKey: deepinfraApiKey };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deepgramApiKey = read(env, 'DEEPGRAM_API_KEY');
  if (!deepgramApiKey) {
    throw new ConfigError(
      'DEEPGRAM_API_KEY is not set. Copy .env.example to .env and add your Deepgram key ' +
        '(https://console.deepgram.com).',
    );
  }

  const portText = read(env, 'PORT') ?? '8787';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a number between 1 and 65535 (got "${portText}").`);
  }

  const deepinfraApiKey = read(env, 'DEEPINFRA_API_KEY');
  const translation = readTranslation(env, deepinfraApiKey);
  const voice = readVoice(env, deepinfraApiKey);

  const certPath = read(env, 'TLS_CERT');
  const keyPath = read(env, 'TLS_KEY');
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new ConfigError('Set both TLS_CERT and TLS_KEY to serve HTTPS, or neither.');
  }
  let tls: Config['tls'];
  if (certPath && keyPath) {
    try {
      tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    } catch (error) {
      throw new ConfigError(`Could not read TLS_CERT / TLS_KEY: ${(error as Error).message}`);
    }
  }

  const allowedOrigins = (read(env, 'ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new ConfigError(`ALLOWED_ORIGINS contains an invalid origin: "${origin}".`);
      }
    });

  return {
    port,
    deepgramApiKey,
    deepgramModel: read(env, 'DEEPGRAM_MODEL') ?? 'nova-3',
    deepgramUrl: read(env, 'DEEPGRAM_URL'),
    translation,
    voice,
    accessToken: read(env, 'ACCESS_TOKEN'),
    allowedOrigins,
    tls,
    staticDir: path.resolve(import.meta.dirname, '../../client/dist'),
  };
}
