import WebSocket from 'ws';
import type { OpenDeepgramSocket } from '../../shared/pipeline/stt/deepgram.ts';

/** Connects to Deepgram with the `ws` package, which reports why a handshake failed. */
export const openDeepgramSocket: OpenDeepgramSocket = (url, apiKey, events) => {
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });
  let rejected = false;

  ws.on('open', () => events.open());

  ws.on('message', (data, isBinary) => {
    if (!isBinary) events.message(data.toString());
  });

  ws.on('unexpected-response', (_req, res) => {
    rejected = true;
    const detail = String(res.headers['dg-error'] ?? res.statusMessage ?? '');
    res.resume();
    ws.terminate();
    events.rejected(res.statusCode ?? 0, detail);
  });

  // A 'close' event always follows.
  ws.on('error', () => {});

  ws.on('close', (code, reason) => {
    if (!rejected) events.closed(code, reason.toString());
  });

  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (data) => ws.send(data),
    terminate: () => ws.terminate(),
  };
};
