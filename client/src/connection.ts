// The WebSocket to the relay server. Phones lose their connection all the time (screen
// locked, Wi-Fi to mobile data), so it reconnects on its own and says hello again.

import { CLOSE_SESSION_ENDED } from '../../shared/protocol.ts';
import type { ClientMessage, ErrorCode, ServerMessage } from '../../shared/protocol.ts';

/** connecting: not connected yet. ready: the server accepted our hello. */
export type ConnectionState = 'connecting' | 'ready' | 'reconnecting';

export interface EndReason {
  message: string;
  code?: ErrorCode | undefined;
}

export interface ConnectionOptions {
  /** The hello message, asked for again on every (re)connection. */
  hello(): ClientMessage;
  /** Every server message except fatal errors, which end the connection instead. */
  onMessage(message: ServerMessage): void;
  onStateChange(state: ConnectionState): void;
  /** The server ended the session, or it could not be reached. Not called after stop(). */
  onEnded(reason: EndReason): void;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
/** Give up if the very first connection keeps failing (server down, wrong address). */
const MAX_INITIAL_FAILURES = 5;
/** About 8 seconds of audio: the network has stalled, so start over on a new connection. */
const MAX_BUFFERED_BYTES = 256 * 1024;

export class Connection {
  private readonly options: ConnectionOptions;
  private ws: WebSocket | undefined;
  private ready = false;
  private everReady = false;
  private failures = 0;
  private retryTimer: number | undefined;
  private stopped = false;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    window.addEventListener('online', this.retryNow);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.connect();
  }

  send(message: ClientMessage): void {
    if (this.ready) this.ws?.send(JSON.stringify(message));
  }

  sendAudio(pcm: Int16Array<ArrayBuffer>): void {
    const ws = this.ws;
    if (!this.ready || !ws) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.drop();
      return;
    }
    ws.send(pcm);
  }

  /** The user ended the session. */
  stop(): void {
    this.shutDown();
  }

  private connect(): void {
    if (this.stopped) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}${import.meta.env.BASE_URL}ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws === ws) ws.send(JSON.stringify(this.options.hello()));
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws === ws) this.closed(event.code);
    };
  }

  private handle(message: ServerMessage): void {
    if (message.type === 'error' && message.fatal) {
      this.end({ message: message.message, code: message.code });
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      this.everReady = true;
      this.failures = 0;
      this.options.onMessage(message);
      this.options.onStateChange('ready');
      return;
    }
    this.options.onMessage(message);
  }

  private closed(code: number): void {
    this.ws = undefined;
    this.ready = false;
    if (this.stopped) return;
    if (code === CLOSE_SESSION_ENDED) {
      this.end({ message: 'The server ended the session.' });
      return;
    }
    this.failures += 1;
    if (!this.everReady && this.failures >= MAX_INITIAL_FAILURES) {
      this.end({ message: 'Could not connect to the server. Check your connection and try again.' });
      return;
    }
    this.options.onStateChange(this.everReady ? 'reconnecting' : 'connecting');
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1]!;
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  /** Abandons the current socket and reconnects. */
  private drop(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null;
    ws.close();
    this.closed(1006);
  }

  /** While waiting to reconnect, try again at once (the phone is back online or awake). */
  private readonly retryNow = (): void => {
    if (this.retryTimer !== undefined) this.connect();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') this.retryNow();
  };

  private end(reason: EndReason): void {
    if (this.stopped) return;
    this.shutDown();
    this.options.onEnded(reason);
  }

  private shutDown(): void {
    this.stopped = true;
    this.ready = false;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    window.removeEventListener('online', this.retryNow);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.close(1000);
    }
  }
}
