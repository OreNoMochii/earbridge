import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { Logger } from '../../shared/pipeline/log.ts';
import type { SttProvider } from '../../shared/pipeline/stt/types.ts';
import type { Translator } from '../../shared/pipeline/translate/types.ts';
import type { SpeechSynthesizer } from '../../shared/pipeline/voice/types.ts';
import { CLOSE_SESSION_ENDED } from '../../shared/protocol.ts';
import { createRequestHandler } from './http.ts';
import { RoomRegistry } from './rooms.ts';
import { ClientSession } from './session.ts';

export interface AppOptions {
  stt: SttProvider;
  translator: Translator;
  /** Natural voices; without one, phones read translations with their own voice. */
  synthesizer?: SpeechSynthesizer | undefined;
  log: Logger;
  staticDir: string;
  accessToken?: string | undefined;
  allowedOrigins?: readonly string[];
  tls?: { cert: Buffer; key: Buffer } | undefined;
  heartbeatMs?: number;
}

export interface App {
  server: Server;
  close(): Promise<void>;
}

const MAX_MESSAGE_BYTES = 256 * 1024;

/** HTTP server for the web app plus the /ws endpoint phones stream audio to. */
export function createApp(options: AppOptions): App {
  const { log } = options;
  const handler = createRequestHandler(options.staticDir, log);
  // https.Server extends tls.Server rather than http.Server, but offers the same API here.
  const server: Server = options.tls
    ? (createHttpsServer(options.tls, handler) as unknown as Server)
    : createHttpServer(handler);
  const rooms = new RoomRegistry({ translator: options.translator, synthesizer: options.synthesizer, log });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const heartbeatMs = options.heartbeatMs ?? 30_000;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
    } else if (!originAllowed(req, allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const session = new ClientSession(
      {
        send: (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
        close: () => ws.close(CLOSE_SESSION_ENDED, 'Session ended'),
      },
      {
        stt: options.stt,
        translator: options.translator,
        synthesizer: options.synthesizer,
        rooms,
        accessToken: options.accessToken,
        log,
      },
    );

    // Mobile networks drop connections silently; ping to notice and free resources.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, heartbeatMs);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) session.handleAudio(toBuffer(data));
      else session.handleText(toBuffer(data).toString('utf8'));
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      session.close();
    });
    ws.on('error', (error) => log.warn('websocket error', error));
  });

  return {
    server,
    close: async () => {
      // 1001 tells phones to reconnect, so they come back when the server restarts.
      for (const client of wss.clients) client.close(1001, 'Server shutting down');
      rooms.close();
      const stragglers = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, 1_000);
      await new Promise<void>((resolve) => {
        wss.close(() => resolve()); // waits until every client is gone
      });
      clearTimeout(stragglers);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Browsers always send Origin on WebSocket requests; only same-origin pages (plus any
 * configured extras) may connect, so other websites cannot use this server through
 * their visitors' browsers.
 */
function originAllowed(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // not a browser
  if (allowed.has(origin)) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
