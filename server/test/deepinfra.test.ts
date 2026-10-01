import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { LANGUAGES } from '../../shared/languages.ts';
import { splitForSpeech } from '../../shared/speech-text.ts';
import { errorDetail } from '../src/deepinfra.ts';
import { DeepInfraTranslator } from '../src/translate/deepinfra.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/translate/prompt.ts';
import { TranslationError, TranslationRefusedError } from '../src/translate/types.ts';
import type { TranslationRequest } from '../src/translate/types.ts';
import { DEEPINFRA_VOICE_LANGUAGES, DeepInfraSpeech } from '../src/voice/deepinfra.ts';
import { SpeechError } from '../src/voice/types.ts';

interface CapturedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Handler = (request: CapturedRequest, res: ServerResponse) => void;

/** A stand-in for DeepInfra's API: captures each request and answers it with `handle`. */
function fakeApi() {
  const api = {
    url: '',
    requests: [] as CapturedRequest[],
    handle: ((_request, res) => res.end()) as Handler,
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const request = { url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      api.requests.push(request);
      api.handle(request, res);
    });
  });
  before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return api;
}

/** The address of a port nothing listens on. */
async function unreachableUrl(): Promise<string> {
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  return `http://127.0.0.1:${port}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Chat completion chunks, as server-sent events. */
function sendEvents(res: ServerResponse, events: Array<object | string>, newline = '\n'): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) {
    res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}${newline}${newline}`);
  }
  res.end();
}

const chunk = (delta: object, finishReason: string | null = null) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  model: 'google/gemma-4-31B-it-turbo',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const REQUEST: TranslationRequest = {
  text: 'Where is the station?',
  sourceLang: 'en-US',
  targetLang: 'es',
  context: [{ speaker: 'Person B', lang: 'es', text: 'Hola, ¿necesita ayuda?' }],
};

describe('DeepInfraTranslator', () => {
  const api = fakeApi();
  const translator = (options: { timeoutMs?: number; baseUrl?: string } = {}) =>
    new DeepInfraTranslator({ apiKey: 'test-key', model: 'google/gemma-4-31B-it-turbo', baseUrl: api.url, ...options });

  it('streams the translation from the chat API', async () => {
    api.handle = (_request, res) =>
      sendEvents(res, [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: '¿Dónde ' }),
        chunk({ content: 'está ' }),
        chunk({ content: 'la estación?' }),
        chunk({}, 'stop'),
        '[DONE]',
      ]);
    const partials: string[] = [];
    const text = await translator().translate({ ...REQUEST, onPartial: (soFar) => partials.push(soFar) });

    assert.equal(text, '¿Dónde está la estación?');
    assert.deepEqual(partials, ['¿Dónde ', '¿Dónde está ', '¿Dónde está la estación?']);
    const request = api.requests.at(-1)!;
    assert.equal(request.url, '/v1/openai/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.deepEqual(request.body, {
      model: 'google/gemma-4-31B-it-turbo',
      stream: true,
      max_tokens: 2000,
      temperature: 0.2,
      reasoning_effort: 'none',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(REQUEST) },
      ],
    });
  });

  it('skips reasoning, trims the translation and copes with any line ending', async () => {
    api.handle = (_request, res) =>
      sendEvents(res, [chunk({ reasoning_content: 'The user wants Spanish.' }), chunk({ content: ' Hola ' }), chunk({}, 'stop')], '\r\n');
    assert.equal(await translator().translate(REQUEST), 'Hola');

    // An event split across network packets, and a last line with no newline.
    api.handle = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = `data: ${JSON.stringify(chunk({ content: 'Adiós' }))}\n\n`;
      res.write(event.slice(0, 20));
      setTimeout(() => res.end(`${event.slice(20)}data: [DONE]`), 10);
    };
    assert.equal(await translator().translate(REQUEST), 'Adiós');
  });

  it('reports a refused translation', async () => {
    api.handle = (_request, res) => sendEvents(res, [chunk({ content: 'Lo siento' }, 'content_filter'), '[DONE]']);
    await assert.rejects(translator().translate(REQUEST), TranslationRefusedError);
  });

  it('reports an error in the middle of the stream', async () => {
    api.handle = (_request, res) =>
      sendEvents(res, [chunk({ content: '¿Dónde' }), { error: { message: 'Model crashed' } }]);
    await assert.rejects(
      translator().translate(REQUEST),
      (error: unknown) =>
        error instanceof TranslationError &&
        error.message === 'Translation failed.' &&
        (error.cause as Error).message === 'Model crashed',
    );
  });

  it('rejects an unreadable or empty answer', async () => {
    api.handle = (_request, res) => sendEvents(res, ['<html>Bad gateway</html>']);
    await assert.rejects(translator().translate(REQUEST), {
      name: 'TranslationError',
      message: 'Translation failed: the translation service sent an unreadable reply.',
    });

    api.handle = (_request, res) => sendEvents(res, [chunk({ content: '  ' }), chunk({}, 'stop'), '[DONE]']);
    await assert.rejects(translator().translate(REQUEST), {
      name: 'TranslationError',
      message: 'The translation service returned an empty translation.',
    });
  });

  for (const [status, pattern] of [
    [401, /DEEPINFRA_API_KEY/],
    [402, /balance/],
    [404, /"google\/gemma-4-31B-it-turbo" is not available.*TRANSLATION_MODEL/],
    [429, /rate limit/],
    [500, /HTTP 500/],
  ] as const) {
    it(`explains HTTP ${status} errors`, async () => {
      api.handle = (_request, res) =>
        sendJson(res, status, { error: { message: 'nope', type: 'invalid_request_error', param: null, code: null } });
      await assert.rejects(
        translator().translate(REQUEST),
        (error: unknown) =>
          error instanceof TranslationError && pattern.test(error.message) && (error.cause as Error).message === 'nope',
      );
    });
  }

  it('explains when DeepInfra cannot be reached', async () => {
    await assert.rejects(translator({ baseUrl: await unreachableUrl() }).translate(REQUEST), {
      name: 'TranslationError',
      message: 'Could not reach the translation service.',
    });
  });

  it('gives up on a translation that stalls', async () => {
    api.handle = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chunk({ content: '¿Dónde' }))}\n\n`);
    };
    const partials: string[] = [];
    await assert.rejects(translator({ timeoutMs: 100 }).translate({ ...REQUEST, onPartial: (soFar) => partials.push(soFar) }), {
      name: 'TranslationError',
      message: 'Translation took too long.',
    });
    assert.deepEqual(partials, ['¿Dónde']);
  });

  it('passes cancellation through untouched', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(translator().translate({ ...REQUEST, signal: aborted.signal }), { name: 'AbortError' });

    api.handle = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chunk({ content: '¿Dónde' }))}\n\n`);
    };
    const midway = new AbortController();
    await assert.rejects(
      translator().translate({ ...REQUEST, signal: midway.signal, onPartial: () => midway.abort() }),
      { name: 'AbortError' },
    );
  });
});

describe('DeepInfraSpeech', () => {
  const api = fakeApi();
  const speech = (options: { timeoutMs?: number; baseUrl?: string } = {}) =>
    new DeepInfraSpeech({ apiKey: 'test-key', baseUrl: api.url, ...options });
  /** Answers like DeepInfra's inference API, with the request's text as the "audio". */
  const sendAudio = (request: CapturedRequest, res: ServerResponse) =>
    sendJson(res, 200, { audio: `data:audio/mp3;base64,${Buffer.from(`mp3:${String(request.body['text'])}`).toString('base64')}` });

  it('reads with Kokoro where it has a voice for the language', async () => {
    api.handle = sendAudio;
    const clips = await speech().synthesize({ text: 'Where is the station?', lang: 'en-US' });

    assert.deepEqual(clips.map(String), ['mp3:Where is the station?']);
    const request = api.requests.at(-1)!;
    assert.equal(request.url, '/v1/inference/hexgrad/Kokoro-82M');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.deepEqual(request.body, {
      text: 'Where is the station?',
      preset_voice: ['af_heart'],
      output_format: 'mp3',
      service_tier: 'priority',
    });
  });

  it('reads with Chatterbox in the right language for the others', async () => {
    api.handle = sendAudio;
    await speech().synthesize({ text: 'Onde fica a estação?', lang: 'pt-PT' });

    const request = api.requests.at(-1)!;
    assert.equal(request.url, '/v1/inference/ResembleAI/chatterbox-multilingual');
    assert.deepEqual(request.body, { text: 'Onde fica a estação?', language_id: 'pt', response_format: 'mp3' });
  });

  it('gives Mandarin ASCII punctuation, which Kokoro reads to the end', async () => {
    api.handle = sendAudio;
    await speech().synthesize({ text: '你好，我是小明。很高兴认识你！', lang: 'zh-CN' });
    assert.equal(api.requests.at(-1)?.body['text'], '你好, 我是小明. 很高兴认识你!');
  });

  it('has a voice for most of the languages the app offers', async () => {
    const offered = LANGUAGES.map((language) => language.code);
    assert.equal(DEEPINFRA_VOICE_LANGUAGES.length, 24);
    for (const lang of DEEPINFRA_VOICE_LANGUAGES) assert.ok(offered.includes(lang), lang);
    assert.equal(speech().supports('fr'), true);
    assert.equal(speech().supports('uk'), false);

    const before = api.requests.length;
    await assert.rejects(speech().synthesize({ text: 'Привіт', lang: 'uk' }), {
      name: 'SpeechError',
      message: 'There is no natural voice for uk.',
    });
    assert.equal(api.requests.length, before);
  });

  it('reads long text as pieces made in parallel, and keeps them in order', async () => {
    const text =
      'Guten Morgen, ich hoffe, Sie hatten eine gute Reise. Der Zug nach München fährt heute leider ' +
      'erst um zehn Uhr ab, weil es eine Störung auf der Strecke gibt. Wir können in der Zwischenzeit ' +
      'gerne einen Kaffee trinken gehen. Das Café am Bahnhof ist sehr gemütlich und nicht teuer.';
    const pieces = splitForSpeech(text, 200);
    assert.ok(pieces.length >= 2);

    const waiting: Array<[CapturedRequest, ServerResponse]> = [];
    api.handle = (request, res) => {
      waiting.push([request, res]);
      if (waiting.length < pieces.length) return;
      // Every piece was asked for before any was answered. Answer the last first.
      waiting.reverse().forEach(([request, res], index) => setTimeout(() => sendAudio(request, res), index * 20));
    };
    const clips = await speech().synthesize({ text, lang: 'de' });
    assert.deepEqual(clips.map(String), pieces.map((piece) => `mp3:${piece}`));
  });

  it('refuses text too long to read and reads nothing for empty text', async () => {
    const before = api.requests.length;
    await assert.rejects(speech().synthesize({ text: 'Bonjour. '.repeat(120), lang: 'fr' }), {
      name: 'SpeechError',
      message: 'This translation is too long for the natural voice.',
    });
    assert.deepEqual(await speech().synthesize({ text: '  ', lang: 'fr' }), []);
    assert.equal(api.requests.length, before);
  });

  for (const [status, message] of [
    [401, 'DeepInfra rejected the API key. Check DEEPINFRA_API_KEY on the server.'],
    [402, 'DeepInfra wants payment (HTTP 402). Check the balance of the DeepInfra account.'],
    [429, 'The voice service is busy.'],
    [500, 'The voice failed (HTTP 500).'],
  ] as const) {
    it(`explains HTTP ${status} errors`, async () => {
      api.handle = (_request, res) => sendJson(res, status, { detail: 'nope' });
      await assert.rejects(
        speech().synthesize({ text: 'Bonjour', lang: 'fr' }),
        (error: unknown) =>
          error instanceof SpeechError && error.message === message && (error.cause as Error).message === 'nope',
      );
    });
  }

  it('stops at the first piece that fails', async () => {
    const text = `${'Das ist ein ziemlich langer Satz, der nicht in ein einziges Stück passt. '.repeat(6)}`;
    const pieces = splitForSpeech(text, 200);
    api.handle = (request, res) => {
      if (request.body['text'] === pieces[0]) sendJson(res, 500, { detail: 'GPU fell over' });
      // The other pieces never finish.
    };
    const started = Date.now();
    await assert.rejects(speech({ timeoutMs: 5_000 }).synthesize({ text, lang: 'de' }), {
      name: 'SpeechError',
      message: 'The voice failed (HTTP 500).',
    });
    assert.ok(Date.now() - started < 1_000, 'did not wait for the other pieces');
  });

  it('rejects an answer without audio', async () => {
    api.handle = (_request, res) => sendJson(res, 200, { audio: null });
    await assert.rejects(speech().synthesize({ text: 'Bonjour', lang: 'fr' }), {
      name: 'SpeechError',
      message: 'The voice returned no audio.',
    });

    api.handle = (_request, res) => sendJson(res, 200, '<html>Bad gateway</html>');
    await assert.rejects(speech().synthesize({ text: 'Bonjour', lang: 'fr' }), {
      name: 'SpeechError',
      message: 'The voice service sent an unreadable reply.',
    });
  });

  it('gives up on a voice that takes too long', async () => {
    api.handle = () => {};
    await assert.rejects(speech({ timeoutMs: 100 }).synthesize({ text: 'Bonjour', lang: 'fr' }), {
      name: 'SpeechError',
      message: 'The voice took too long.',
    });
  });

  it('explains when DeepInfra cannot be reached', async () => {
    await assert.rejects(speech({ baseUrl: await unreachableUrl() }).synthesize({ text: 'Bonjour', lang: 'fr' }), {
      name: 'SpeechError',
      message: 'Could not reach the voice service.',
    });
  });

  it('passes cancellation through untouched', async () => {
    api.handle = () => {};
    const controller = new AbortController();
    const pending = speech().synthesize({ text: 'Bonjour', lang: 'fr', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, { name: 'AbortError' });
  });
});

describe('errorDetail', () => {
  it('keeps the plain messages DeepInfra sends', () => {
    assert.equal(errorDetail({ error: { message: 'The model `x` does not exist', code: 'model_not_found' } }), 'The model `x` does not exist');
    assert.equal(errorDetail({ detail: 'User is not authorized to access this resource' }), 'User is not authorized to access this resource');
    assert.equal(errorDetail({ detail: { error: 'Model is not available' } }), 'Model is not available');
    assert.equal(errorDetail({ detail: 'x'.repeat(500) })?.length, 200);
  });

  it('leaves out validation errors, which repeat what people said', () => {
    assert.equal(
      errorDetail({ detail: [{ type: 'string_too_long', loc: ['text'], msg: 'Too long', input: 'Where is the station?' }] }),
      undefined,
    );
    assert.equal(errorDetail('Internal Server Error'), undefined);
    assert.equal(errorDetail(null), undefined);
  });
});
