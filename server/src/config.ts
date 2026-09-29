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

export interface Config {
  port: number;
  deepgramApiKey: string;
  deepgramModel: string;
  /** Override for self-hosted or regional Deepgram endpoints. */
  deepgramUrl: string | undefined;
  translationModel: string;
  translationEffort: Effort;
  /** False when relying on an `ant auth login` profile instead of an API key. */
  hasAnthropicKey: boolean;
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

  const effort = read(env, 'TRANSLATION_EFFORT') ?? 'low';
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new ConfigError(`TRANSLATION_EFFORT must be one of ${EFFORTS.join(', ')} (got "${effort}").`);
  }

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
    translationModel: read(env, 'TRANSLATION_MODEL') ?? 'claude-opus-5',
    translationEffort: effort as Effort,
    hasAnthropicKey: Boolean(read(env, 'ANTHROPIC_API_KEY') ?? read(env, 'ANTHROPIC_AUTH_TOKEN')),
    accessToken: read(env, 'ACCESS_TOKEN'),
    allowedOrigins,
    tls,
    staticDir: path.resolve(import.meta.dirname, '../../client/dist'),
  };
}
