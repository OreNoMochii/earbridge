import WebSocket from 'ws';
import { AUDIO_SAMPLE_RATE } from '../../../shared/protocol.ts';
import { baseLanguage } from '../../../shared/languages.ts';
import type { SttEvents, SttProvider, SttStream, SttStreamOptions } from './types.ts';

// Deepgram live streaming: https://developers.deepgram.com/docs/live-streaming-audio
// Raw WebSocket instead of the SDK keeps the dependency surface small and the wire
// protocol explicit.

const KEEPALIVE_MS = 4_000; // Deepgram closes idle streams after ~10 s without audio
const MAX_BUFFERED_BYTES = AUDIO_SAMPLE_RATE * 2 * 10; // 10 s of audio while (re)connecting
const MAX_RECONNECTS = 5;
const CLOSE_GRACE_MS = 3_000;

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  /** Tried once when `model` rejects a language (e.g. nova-2 covers more languages). */
  fallbackModel?: string;
  url?: string;
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
  private ws: WebSocket | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private finalizeWhenOpen = false;
  private lastSentAt = 0;
  private reconnects = 0;
  private closing = false;
  private finished = false;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closeTimer: NodeJS.Timeout | undefined;

  constructor(options: DeepgramOptions, language: string, events: SttEvents) {
    this.options = options;
    this.language = language;
    this.events = events;
    this.model = options.model;
  }

  connect(): void {
    if (this.reconnects === 0) this.events.onStatus('connecting'); // else scheduleReconnect reported it
    const ws = new WebSocket(this.url(), {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      if (ws !== this.ws) return;
      this.reconnects = 0;
      this.events.onStatus('live');
      for (const chunk of this.pending) ws.send(chunk);
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
    });

    ws.on('message', (data, isBinary) => {
      if (ws !== this.ws || isBinary) return;
      this.handleMessage(data.toString());
    });

    ws.on('unexpected-response', (_req, res) => {
      if (ws !== this.ws) return;
      this.ws = undefined;
      const detail = String(res.headers['dg-error'] ?? res.statusMessage ?? '');
      res.resume();
      ws.terminate();
      this.handleHandshakeFailure(res.statusCode ?? 0, detail);
    });

    // A 'close' event always follows; reconnection is handled there.
    ws.on('error', () => {});

    ws.on('close', (code, reason) => {
      if (ws !== this.ws) return;
      this.ws = undefined;
      clearInterval(this.keepAliveTimer);
      if (this.closing) {
        this.finish();
      } else {
        this.scheduleReconnect(`closed with ${code} ${reason.toString()}`.trim());
      }
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.closing || this.finished) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
      this.lastSentAt = Date.now();
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    while (this.pendingBytes > MAX_BUFFERED_BYTES) {
      this.pendingBytes -= this.pending.shift()!.length;
    }
  }

  finalize(): void {
    if (this.closing || this.finished) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendControl('Finalize');
    // e.g. a short push-to-talk turn that ended before the connection was up: the
    // buffered audio is sent on open and must still be finalized.
    else this.finalizeWhenOpen = true;
  }

  close(): void {
    if (this.closing || this.finished) return;
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    if (!this.ws) {
      this.finish();
      return;
    }
    // Ask Deepgram to flush its final results; if it was still connecting, the
    // 'open' handler sends the buffered audio followed by CloseStream.
    this.sendControl('CloseStream');
    this.closeTimer = setTimeout(() => {
      const ws = this.ws;
      this.ws = undefined;
      ws?.terminate();
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

    let wordLanguages = (alternative.words ?? [])
      .map((word) => word.language)
      .filter((lang): lang is string => typeof lang === 'string')
      .map(baseLanguage);
    const segmentLanguage = alternative.languages?.[0];
    if (wordLanguages.length === 0 && text && typeof segmentLanguage === 'string') {
      wordLanguages = [baseLanguage(segmentLanguage)];
    }

    this.events.onResult({
      text,
      isFinal: message.is_final === true,
      speechFinal: message.speech_final === true,
      fromFinalize: message.from_finalize === true,
      wordLanguages,
    });
  }

  private handleHandshakeFailure(status: number, detail: string): void {
    if (this.closing) {
      this.finish();
    } else if (status === 401 || status === 403) {
      this.fail(new Error('Deepgram rejected the API key. Check DEEPGRAM_API_KEY on the server.'));
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type }));
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
