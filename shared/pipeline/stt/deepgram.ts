import { AUDIO_SAMPLE_RATE } from '../../protocol.ts';
import { baseLanguage } from '../../languages.ts';
import type { SttEvents, SttProvider, SttResult, SttStream, SttStreamOptions } from './types.ts';

// Deepgram live streaming: https://developers.deepgram.com/docs/live-streaming-audio
// Raw WebSocket instead of the SDK keeps the dependency surface small and the wire
// protocol explicit. The server and the phone app open the socket in their own way.

const KEEPALIVE_MS = 4_000; // Deepgram closes idle streams after ~10 s without audio
const BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * 2;
const MAX_BUFFERED_BYTES = BYTES_PER_SECOND * 10; // 10 s of audio while (re)connecting
const MAX_RECONNECTS = 5;
const CLOSE_GRACE_MS = 3_000;

/** What a socket reports. After `rejected` or `closed` it reports nothing more. */
export interface DeepgramSocketEvents {
  open(): void;
  message(text: string): void;
  /** Deepgram refused the connection, e.g. 401 for a bad key or 400 for an unsupported language. */
  rejected(status: number, detail: string): void;
  /** The connection closed, or could not be made. */
  closed(code: number, reason: string): void;
}

export interface DeepgramSocket {
  readonly isOpen: boolean;
  send(data: string | Uint8Array): void;
  /** Drops the connection at once. */
  terminate(): void;
}

/** Connects to `url`, sending `apiKey` as the Authorization header. */
export type OpenDeepgramSocket = (url: string, apiKey: string, events: DeepgramSocketEvents) => DeepgramSocket;

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  /** Tried once when `model` rejects a language (e.g. nova-2 covers more languages). */
  fallbackModel?: string;
  url?: string;
  openSocket: OpenDeepgramSocket;
  /** Where to fix a rejected key, e.g. "Check DEEPGRAM_API_KEY on the server." */
  keyHint?: string;
}

export class DeepgramProvider implements SttProvider {
  private readonly options: DeepgramOptions;

  constructor(options: DeepgramOptions) {
    this.options = options;
  }

  open(options: SttStreamOptions, events: SttEvents): SttStream {
    const stream = new DeepgramStream(this.options, options.language, events);
    stream.connect();
    return stream;
  }
}

interface DeepgramWord {
  language?: string;
  /** Seconds since the start of the connection's audio. */
  start?: number;
  end?: number;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string; words?: DeepgramWord[]; languages?: string[] }>;
  };
}

class DeepgramStream implements SttStream {
  private readonly options: DeepgramOptions;
  private readonly language: string;
  private readonly events: SttEvents;
  private model: string;
  private socket: DeepgramSocket | undefined;
  /** Audio waiting for a connection, with where each chunk starts on the stream's clock. */
  private pending: Array<{ chunk: Uint8Array; at: number }> = [];
  private pendingBytes = 0;
  /** Bytes of audio given to sendAudio so far: the stream's clock. */
  private received = 0;
  /** Where the current connection's audio starts on that clock: Deepgram's timings count from there. */
  private origin = 0;
  private finalizeWhenOpen = false;
  private lastSentAt = 0;
  private reconnects = 0;
  private closing = false;
  private finished = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DeepgramOptions, language: string, events: SttEvents) {
    this.options = options;
    this.language = language;
    this.events = events;
    this.model = options.model;
  }

  connect(): void {
    if (this.reconnects === 0) this.events.onStatus('connecting'); // else scheduleReconnect reported it
    const socket: DeepgramSocket = this.options.openSocket(this.url(), this.options.apiKey, {
      open: () => {
        if (socket !== this.socket) return;
        this.reconnects = 0;
        this.events.onStatus('live');
        this.origin = this.pending[0]?.at ?? this.received;
        for (const { chunk } of this.pending) socket.send(chunk);
        this.pending = [];
        this.pendingBytes = 0;
        if (this.finalizeWhenOpen) {
          this.finalizeWhenOpen = false;
          this.sendControl('Finalize');
        }
        this.lastSentAt = Date.now();
        this.keepAliveTimer = setInterval(() => {
          if (Date.now() - this.lastSentAt >= KEEPALIVE_MS) this.sendControl('KeepAlive');
        }, KEEPALIVE_MS / 2);
        if (this.closing) this.sendControl('CloseStream');
      },

      message: (text) => {
        if (socket === this.socket) this.handleMessage(text);
      },

      rejected: (status, detail) => {
        if (socket !== this.socket) return;
        this.socket = undefined;
        this.handleHandshakeFailure(status, detail);
      },

      closed: (code, reason) => {
        if (socket !== this.socket) return;
        this.socket = undefined;
        clearInterval(this.keepAliveTimer);
        if (this.closing) {
          this.finish();
        } else {
          this.scheduleReconnect(`closed with ${code} ${reason}`.trim());
        }
      },
    });
    this.socket = socket;
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.closing || this.finished) return;
    const at = this.received;
    this.received += chunk.byteLength;
    if (this.socket?.isOpen) {
      this.socket.send(chunk);
      this.lastSentAt = Date.now();
      return;
    }
    this.pending.push({ chunk, at });
    this.pendingBytes += chunk.byteLength;
    while (this.pendingBytes > MAX_BUFFERED_BYTES) {
      this.pendingBytes -= this.pending.shift()!.chunk.byteLength;
    }
  }

  finalize(): void {
    if (this.closing || this.finished) return;
    if (this.socket?.isOpen) this.sendControl('Finalize');
    // e.g. a short push-to-talk turn that ended before the connection was up: the
    // buffered audio is sent on open and must still be finalized.
    else this.finalizeWhenOpen = true;
  }

  close(): void {
    if (this.closing || this.finished) return;
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    if (!this.socket) {
      this.finish();
      return;
    }
    // Ask Deepgram to flush its final results; if it was still connecting, the
    // 'open' handler sends the buffered audio followed by CloseStream.
    this.sendControl('CloseStream');
    this.closeTimer = setTimeout(() => {
      const socket = this.socket;
      this.socket = undefined;
      socket?.terminate();
      this.finish();
    }, CLOSE_GRACE_MS);
  }

  private url(): string {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      encoding: 'linear16',
      sample_rate: String(AUDIO_SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    return `${this.options.url ?? 'wss://api.deepgram.com/v1/listen'}?${params}`;
  }

  private handleMessage(raw: string): void {
    let message: DeepgramMessage;
    try {
      message = JSON.parse(raw) as DeepgramMessage;
    } catch {
      return;
    }

    if (message.type === 'UtteranceEnd') {
      this.events.onUtteranceEnd();
      return;
    }
    if (message.type !== 'Results') return;

    const alternative = message.channel?.alternatives?.[0];
    if (!alternative) return;
    const text = alternative.transcript ?? '';
    const words = alternative.words ?? [];

    let wordLanguages = words
      .map((word) => word.language)
      .filter((lang): lang is string => typeof lang === 'string')
      .map(baseLanguage);
    const segmentLanguage = alternative.languages?.[0];
    if (wordLanguages.length === 0 && text && typeof segmentLanguage === 'string') {
      wordLanguages = [baseLanguage(segmentLanguage)];
    }

    const result: SttResult = {
      text,
      isFinal: message.is_final === true,
      speechFinal: message.speech_final === true,
      fromFinalize: message.from_finalize === true,
      wordLanguages,
    };
    const starts = words.map((word) => word.start).filter(isNumber);
    const ends = words.map((word) => word.end).filter(isNumber);
    if (starts.length > 0 && ends.length > 0) {
      // Each connection counts from its own first byte; audio lost between connections
      // would otherwise shift everything after a reconnection.
      const offset = this.origin / BYTES_PER_SECOND;
      result.start = offset + Math.min(...starts);
      result.end = offset + Math.max(...ends);
    }
    this.events.onResult(result);
  }

  private handleHandshakeFailure(status: number, detail: string): void {
    if (this.closing) {
      this.finish();
    } else if (status === 401 || status === 403) {
      const hint = this.options.keyHint ? ` ${this.options.keyHint}` : '';
      this.fail(new Error(`Deepgram rejected the API key.${hint}`));
    } else if (status === 400 && this.options.fallbackModel && this.model !== this.options.fallbackModel) {
      this.model = this.options.fallbackModel;
      this.connect();
    } else if (status === 400) {
      this.fail(
        new Error(`Speech recognition does not support "${this.language}" (${detail || 'HTTP 400'}).`),
      );
    } else {
      this.scheduleReconnect(`handshake failed with HTTP ${status} ${detail}`.trim());
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closing) {
      this.finish();
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.fail(new Error(`Lost connection to speech recognition (${reason}).`));
      return;
    }
    this.reconnects += 1;
    this.events.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), 500 * 2 ** (this.reconnects - 1));
  }

  private sendControl(type: 'KeepAlive' | 'Finalize' | 'CloseStream'): void {
    if (this.socket?.isOpen) this.socket.send(JSON.stringify({ type }));
  }

  private fail(error: Error): void {
    this.finish();
    this.events.onError(error, true);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.closing = true;
    this.pending = [];
    this.pendingBytes = 0;
    clearInterval(this.keepAliveTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.closeTimer);
    this.events.onClosed();
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
