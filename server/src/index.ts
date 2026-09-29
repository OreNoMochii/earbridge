import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { consoleLogger as log } from './log.ts';
import { DeepgramProvider } from './stt/deepgram.ts';
import { ClaudeTranslator } from './translate/claude.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

if (!config.hasAnthropicKey) {
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
  translator: new ClaudeTranslator({
    // A translation that takes this long is no longer useful in a live conversation.
    client: new Anthropic({ timeout: 60_000 }),
    model: config.translationModel,
    effort: config.translationEffort,
  }),
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
  log.info(
    `Translation: ${config.translationModel} (effort ${config.translationEffort}, refusal fallbacks on) · ` +
      `Speech recognition: Deepgram ${config.deepgramModel}`,
  );
  if (process.env['npm_lifecycle_event'] === 'dev:server') {
    log.info('Development mode: open the https://...:5173 address printed by Vite on your phone.');
  } else {
    for (const address of lanAddresses) log.info(`  On your phone (same Wi-Fi): ${scheme}://${address}:${config.port}`);
    if (!config.tls) {
      log.warn(
        'Phones only allow the microphone on HTTPS pages. Set TLS_CERT/TLS_KEY, put the server ' +
          'behind an HTTPS proxy, or use `npm run dev` for local testing.',
      );
    }
  }
});

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
