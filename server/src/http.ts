import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Logger } from '../../shared/pipeline/log.ts';

// Serves the built web app (client/dist). During development Vite serves it instead.

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const NOT_BUILT = `The web app has not been built yet.

  Development:  npm run dev    then open the https://...:5173 address it prints
  Production:   npm run build  then npm start
`;

export function createRequestHandler(staticDir: string, log: Logger) {
  const root = path.resolve(staticDir);
  return (req: IncomingMessage, res: ServerResponse): void => {
    serve(root, req, res).catch((error: unknown) => {
      log.error(`http ${req.method} ${req.url}`, error);
      if (res.headersSent) res.destroy();
      else sendText(res, 500, 'Internal server error');
    });
  };
}

async function serve(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setSecurityHeaders(req, res);
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method not allowed');
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }
  let file = path.resolve(root, `.${pathname}`);
  if (pathname.includes('\0') || (file !== root && !file.startsWith(root + path.sep))) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let info = await statIfExists(file);
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html');
    info = await statIfExists(file);
  }
  if (!info?.isFile()) {
    if (path.extname(pathname)) {
      sendText(res, 404, 'Not found');
      return;
    }
    // App routes such as /?room=ABC123 all load the single-page app.
    file = path.join(root, 'index.html');
    info = await statIfExists(file);
    if (!info?.isFile()) {
      sendText(res, 404, NOT_BUILT);
      return;
    }
  }

  const hashedAsset = path.relative(root, file).startsWith(`assets${path.sep}`);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

async function statIfExists(file: string): Promise<Stats | undefined> {
  try {
    return await stat(file);
  } catch {
    return undefined;
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function setSecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
  // Older Safari versions do not match ws:/wss: against 'self', so name the host too.
  const host = req.headers.host ?? '';
  const socketSources = /^[a-z0-9.:[\]-]+$/i.test(host) ? ` wss://${host} ws://${host}` : '';
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self'${socketSources}`,
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Room codes appear in URLs (?room=...); never leak them to other sites.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}
