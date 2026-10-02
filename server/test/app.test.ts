import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { silentLogger } from '../../shared/pipeline/log.ts';
import { CLOSE_SESSION_ENDED } from '../../shared/protocol.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { FakeSttProvider, FakeTranslator, eventually } from './fakes.ts';

describe('server app', () => {
  const stt = new FakeSttProvider();
  const translator = new FakeTranslator();
  let staticDir: string;
  let app: App;
  let host: string;

  before(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'earbridge-test-'));
    await mkdir(path.join(staticDir, 'assets'));
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>EarBridge</title>');
    await writeFile(path.join(staticDir, 'assets', 'app-1234.js'), 'console.log("hi");');
    app = createApp({ stt, translator, log: silentLogger, staticDir });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.close();
    await rm(staticDir, { recursive: true, force: true });
  });

  function get(pathname: string): Promise<Response> {
    return fetch(`http://${host}${pathname}`);
  }

  async function openSocket(origin = `http://${host}`) {
    const ws = new WebSocket(`ws://${host}/ws`, { origin });
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await once(ws, 'open');
    const of = <T extends ServerMessage['type']>(type: T) =>
      messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    return { ws, of, closed, hello: (hello: object) => ws.send(JSON.stringify({ type: 'hello', ...hello })) };
  }

  async function rejectedUpgrade(pathname: string, origin: string): Promise<number> {
    const ws = new WebSocket(`ws://${host}${pathname}`, { origin });
    ws.on('error', () => {});
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, IncomingMessage];
    res.resume();
    ws.terminate();
    return res.statusCode ?? 0;
  }

  it('serves the web app with security headers', async () => {
    const res = await get('/?room=ABC234');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self';/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await res.text(), /EarBridge/);
  });

  it('caches hashed assets, 404s missing files and refuses paths outside the app', async () => {
    const asset = await get('/assets/app-1234.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await asset.text(), 'console.log("hi");');

    const missing = await get('/missing.js');
    assert.equal(missing.status, 404);
    await missing.text();

    const outside = await get('/..%2f..%2fetc%2fpasswd');
    assert.equal(outside.status, 403);
    await outside.text();
  });

  it('runs a conversation over the WebSocket', async () => {
    const phone = await openSocket();
    phone.hello({ mode: 'solo', myLang: 'en-US', theirLang: 'es' });
    await eventually(() => phone.of('ready')[0]);

    const stream = stt.last;
    phone.ws.send(Buffer.alloc(3200));
    await eventually(() => stream.audio.length === 1);

    stream.say('¿Cuánto cuesta?', ['es', 'es']);
    const translation = await eventually(() => phone.of('translation').find((m) => m.done));
    assert.equal(translation.text, '[en-US] ¿Cuánto cuesta?');
    assert.equal(phone.of('utterance')[0]?.id, translation.id);

    // Hanging up frees the speech recognizer.
    phone.ws.close();
    await eventually(() => stream.closed);
  });

  it('closes with a "do not reconnect" code when the session ends on purpose', async () => {
    const phone = await openSocket();
    phone.hello({ mode: 'solo', myLang: 'en-US', theirLang: 'en-GB' });
    assert.equal(await phone.closed, CLOSE_SESSION_ENDED);
    assert.equal(phone.of('error')[0]?.fatal, true);
  });

  it('refuses WebSocket connections from other websites and on other paths', async () => {
    assert.equal(await rejectedUpgrade('/ws', 'https://evil.example'), 403);
    assert.equal(await rejectedUpgrade('/other', `http://${host}`), 404);
  });
});
