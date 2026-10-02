import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../shared/pipeline/translate/prompt.ts';
import { TranslationError, TranslationRefusedError } from '../../shared/pipeline/translate/types.ts';
import type { TranslationRequest } from '../../shared/pipeline/translate/types.ts';
import { ClaudeTranslator } from '../src/translate/claude.ts';

type Reply =
  | { kind: 'stream'; chunks: string[]; stopReason: string }
  | { kind: 'error'; status: number; type: string; message: string };

interface CapturedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** Answers like the Messages API: a server-sent event stream, or a JSON error. */
function startFakeApi(requests: CapturedRequest[], replyFor: () => Reply): Server {
  return createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const reply = replyFor();
      if (reply.kind === 'error') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', {
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      if (reply.chunks.length > 0) {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (const text of reply.chunks) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
        send('content_block_stop', { index: 0 });
      }
      send('message_delta', { delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
      send('message_stop', {});
      res.end();
    });
  });
}

const REQUEST: TranslationRequest = {
  text: 'Where is the station?',
  sourceLang: 'en-US',
  targetLang: 'es',
  context: [],
};

describe('ClaudeTranslator', () => {
  const requests: CapturedRequest[] = [];
  let reply: Reply = { kind: 'stream', chunks: [], stopReason: 'end_turn' };
  const server = startFakeApi(requests, () => reply);
  let translator: ClaudeTranslator;

  before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    translator = new ClaudeTranslator({
      client: new Anthropic({ apiKey: 'test-key', authToken: null, baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }),
      model: 'claude-opus-5',
      effort: 'low',
    });
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('streams the translation with refusal fallbacks enabled', async () => {
    reply = { kind: 'stream', chunks: ['¿Dónde ', 'está ', 'la estación?'], stopReason: 'end_turn' };
    const partials: string[] = [];
    const text = await translator.translate({ ...REQUEST, onPartial: (soFar) => partials.push(soFar) });

    assert.equal(text, '¿Dónde está la estación?');
    assert.deepEqual(partials, ['¿Dónde ', '¿Dónde está ', '¿Dónde está la estación?']);

    const request = requests.at(-1)!;
    assert.equal(request.url, '/v1/messages?beta=true');
    assert.equal(request.headers['x-api-key'], 'test-key');
    assert.equal(request.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.deepEqual(request.body, {
      model: 'claude-opus-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(REQUEST) }],
      stream: true,
    });
  });

  it('reports a refusal instead of returning a partial translation', async () => {
    reply = { kind: 'stream', chunks: [], stopReason: 'refusal' };
    await assert.rejects(translator.translate(REQUEST), TranslationRefusedError);

    reply = { kind: 'stream', chunks: ['¿Dónde '], stopReason: 'refusal' };
    await assert.rejects(translator.translate(REQUEST), TranslationRefusedError);
  });

  for (const [status, type, pattern] of [
    [401, 'authentication_error', /ANTHROPIC_API_KEY/],
    [404, 'not_found_error', /TRANSLATION_MODEL/],
    [429, 'rate_limit_error', /rate limit/],
    [529, 'overloaded_error', /HTTP 529/],
  ] as const) {
    it(`explains HTTP ${status} errors`, async () => {
      reply = { kind: 'error', status, type, message: 'nope' };
      await assert.rejects(
        translator.translate(REQUEST),
        (error: unknown) => error instanceof TranslationError && pattern.test(error.message),
      );
    });
  }

  it('explains when the API cannot be reached', async () => {
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const unreachable = new ClaudeTranslator({
      client: new Anthropic({ apiKey: 'test-key', authToken: null, baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }),
      model: 'claude-opus-5',
      effort: 'low',
    });
    await assert.rejects(unreachable.translate(REQUEST), {
      name: 'TranslationError',
      message: 'Could not reach the translation service.',
    });
  });

  it('passes cancellation through untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(translator.translate({ ...REQUEST, signal: controller.signal }), APIUserAbortError);
  });
});
