// The WebSocket to the EarBridge server: sends the hello, reconnects with backoff, and
// tells apart a session the server ended from a dropped connection. A port of the web
// app's client/src/connection.ts.

import { AppState } from 'react-native';
import type { NativeEventSubscription } from 'react-native';

import { CLOSE_SESSION_ENDED } from '../../shared/protocol.ts';
import type { ClientMessage, ErrorCode, ServerMessage } from '../../shared/protocol.ts';

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting';

export interface EndReason {
  message: string;
  /** From the server, or 'unreachable' when the server could not be reached at all. */
  code?: ErrorCode | 'unreachable' | undefined;
}

export interface ConnectionOptions {
  /** The WebSocket address, e.g. ws://192.168.1.20:8787/ws. */
  url: string;
  /** The server's address as shown to the user, for the error when it cannot be reached. */
  serverLabel: string;
  /** The first message on every (re)connection. */
  hello(): ClientMessage;
  onMessage(message: ServerMessage): void;
  onStateChange(state: ConnectionState): void;
  /** The session is over and will not reconnect. */
  onEnded(reason: EndReason): void;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
/** Give up if the very first connection keeps failing (e.g. a wrong address). */
const MAX_INITIAL_FAILURES = 5;

export class Connection {
  private readonly options: ConnectionOptions;
  private ws: WebSocket | undefined;
  private ready = false;
  private everReady = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private appState: NativeEventSubscription | undefined;
  private stopped = false;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    // Back in the app: no need to wait for the next retry.
    this.appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') this.retryNow();
    });
    this.connect();
  }

  send(message: ClientMessage): void {
    if (this.ready) this.ws?.send(JSON.stringify(message));
  }

  /**
   * 16 kHz mono PCM16. Unlike browsers, React Native does not report how much is still
   * waiting to be sent; on a stalled network the socket fails and reconnects instead.
   */
  sendAudio(pcm: ArrayBuffer): void {
    if (this.ready) this.ws?.send(pcm);
  }

  stop(): void {
    this.shutDown();
  }

  private connect(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const ws = new WebSocket(this.options.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) ws.send(JSON.stringify(this.options.hello()));
    };
    ws.onmessage = (event: WebSocketMessageEvent) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };
    ws.onclose = (event: WebSocketCloseEvent) => {
      if (this.ws === ws) this.closed(event.code ?? 1006);
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
      this.end({
        message:
          `Could not reach the server at ${this.options.serverLabel}. Check the address under Advanced, ` +
          'that the server is running, and that this phone is on the same network.',
        code: 'unreachable',
      });
      return;
    }
    this.options.onStateChange(this.everReady ? 'reconnecting' : 'connecting');
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1]!;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private retryNow(): void {
    if (this.retryTimer !== undefined) this.connect();
  }

  private end(reason: EndReason): void {
    if (this.stopped) return;
    this.shutDown();
    this.options.onEnded(reason);
  }

  private shutDown(): void {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.appState?.remove();
    this.appState = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close(1000);
    }
  }
}
