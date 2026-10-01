import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { LANGUAGES } from '../../shared/languages.ts';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { consoleLogger as log } from './log.ts';
import { DeepgramProvider } from './stt/deepgram.ts';
import { ClaudeTranslator } from './translate/claude.ts';
import { DeepInfraTranslator } from './translate/deepinfra.ts';
import type { Translator } from './translate/types.ts';
import { DEEPINFRA_VOICE_LANGUAGES, DeepInfraSpeech } from './voice/deepinfra.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const { translation, voice } = config;
if (translation.provider === 'claude' && !translation.hasApiKey) {
  log.warn('ANTHROPIC_API_KEY is not set; using your `ant auth login` profile if there is one.');
}
if (!config.accessToken) {
  log.info('No ACCESS_TOKEN set: anyone who can reach this server can use it. Set one before exposing it publicly.');
}

const app = createApp({
  stt: new DeepgramProvider({
    apiKey: config.deepgramApiKey,
    model: config.deepgramModel,
    fallbackModel: 'nova-2',
    url: config.deepgramUrl,
  }),
  translator: createTranslator(translation),
  synthesizer: voice.provider === 'deepinfra' ? new DeepInfraSpeech({ apiKey: voice.apiKey }) : undefined,
  log,
  staticDir: config.staticDir,
  accessToken: config.accessToken,
  allowedOrigins: config.allowedOrigins,
  tls: config.tls,
});

app.server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other process or set PORT in .env.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

app.server.listen(config.port, () => {
  const scheme = config.tls ? 'https' : 'http';
  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net!.address);

  log.info(`EarBridge server listening on ${scheme}://localhost:${config.port}`);
  log.info(`Speech recognition: Deepgram ${config.deepgramModel}`);
  log.info(
    translation.provider === 'deepinfra'
      ? `Translation: DeepInfra ${translation.model}`
      : `Translation: Claude ${translation.model} (effort ${translation.effort}, refusal fallbacks on)`,
  );
  log.info(
    voice.provider === 'deepinfra'
      ? `Voices: DeepInfra for ${DEEPINFRA_VOICE_LANGUAGES.length} of ${LANGUAGES.length} languages (the phone's own voice for the others)`
      : "Voices: each phone's own voice",
  );
  if (process.env['npm_lifecycle_event'] === 'dev:server') {
    log.info('Development mode: open the https://...:5173 address printed by Vite on your phone.');
  } else {
    for (const address of lanAddresses) log.info(`  On your phone (same Wi-Fi): ${scheme}://${address}:${config.port}`);
    if (!config.tls) {
      log.warn(
        'Phones only allow the microphone on HTTPS pages. Set TLS_CERT/TLS_KEY, put the server ' +
          'behind an HTTPS proxy, or use `npm run dev` for local testing. The EarBridge phone app needs no HTTPS.',
      );
    }
  }
  if (!config.tls) {
    for (const address of lanAddresses) log.info(`  Server address for the EarBridge phone app: ${address}:${config.port}`);
  }
});

function createTranslator(settings: Config['translation']): Translator {
  if (settings.provider === 'deepinfra') {
    return new DeepInfraTranslator({ apiKey: settings.apiKey, model: settings.model });
  }
  return new ClaudeTranslator({
    // A translation that takes this long is no longer useful in a live conversation.
    client: new Anthropic({ timeout: 60_000 }),
    model: settings.model,
    effort: settings.effort,
  });
}

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  log.info('Shutting down');
  setTimeout(() => process.exit(0), 3_000).unref();
  void app.close().then(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
