// Deepgram's streaming socket, opened by the phone itself with the user's own key.
// Unlike browsers, React Native's WebSocket can send the key in a header.

import type { OpenDeepgramSocket } from '../../../shared/pipeline/stt/deepgram.ts';

/** React Native's WebSocket constructor, which also takes headers. */
type HeaderWebSocket = new (
  url: string,
  protocols: string | string[] | null,
  options: { headers: Record<string, string> },
) => WebSocket;

export const openDeepgramSocket: OpenDeepgramSocket = (url, apiKey, events) => {
  const ws = new (WebSocket as unknown as HeaderWebSocket)(url, null, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  ws.binaryType = 'arraybuffer';
  let opened = false;
  let done = false;
  let failure = '';

  ws.onopen = () => {
    // Closing a socket that is still connecting does nothing on Android.
    if (done) {
      ws.close();
      return;
    }
    opened = true;
    events.open();
  };

  ws.onmessage = (event: WebSocketMessageEvent) => {
    if (!done && typeof event.data === 'string') events.message(event.data);
  };

  // A close follows; a refused handshake only says why here or in the close reason,
  // e.g. "Expected HTTP 101 response but was '401 Unauthorized'".
  ws.onerror = (event: Event) => {
    const message = (event as Event & { message?: unknown }).message;
    if (typeof message === 'string') failure = message;
  };

  ws.onclose = (event: WebSocketCloseEvent) => {
    if (done) return;
    done = true;
    const reason = event.reason ?? '';
    const status = opened ? undefined : /response\D*(\d{3})/i.exec(`${reason} ${failure}`)?.[1];
    if (status) events.rejected(Number(status), '');
    else events.closed(event.code ?? 1006, reason || failure);
  };

  return {
    get isOpen() {
      return opened && !done && ws.readyState === WebSocket.OPEN;
    },
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    terminate() {
      if (done) return;
      done = true;
      ws.close();
    },
  };
};
