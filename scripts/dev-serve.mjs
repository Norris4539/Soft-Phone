#!/usr/bin/env node
/**
 * Serves the built web app and proxies /api to the control server.
 *
 * This is nginx's stand-in for running the stack without Docker — see
 * docs/TESTING.md.  It is deliberately not used in production: nginx does this
 * better, with caching, compression and the security headers.
 *
 *   node scripts/dev-serve.mjs [--port 8090] [--api http://127.0.0.1:4000]
 */

import { connect } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(arg('port', '8090'));
const API = new URL(arg('api', 'http://127.0.0.1:4000'));
const DIST = resolve(arg('dist', join(ROOT, 'web', 'dist')));

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No build found at ${DIST}\nRun:  npm --prefix web run build`);
  process.exit(1);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api')) {
    const upstream = httpRequest(
      {
        host: API.hostname,
        port: API.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: API.host },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      // Almost always "the control server is not running yet".
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `cannot reach ${API.origin}: ${err.message}` }));
    });
    req.pipe(upstream);
    return;
  }

  const path = normalize(decodeURIComponent(req.url.split('?')[0] ?? '/'));
  // normalize() collapses `..`, but a leading `../` survives it; refuse
  // anything that escapes the build directory.
  const file = resolve(join(DIST, path === '/' ? 'index.html' : path));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    // Single-page app: an unknown path is a route, not a missing file.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(DIST, 'index.html')));
  }
});

// The dashboard's live feed is a WebSocket, so the upgrade must be tunnelled
// rather than proxied as an ordinary request.
server.on('upgrade', (req, socket, head) => {
  const upstream = connect(Number(API.port), API.hostname, () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('');
    upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`web    http://localhost:${PORT}`);
  console.log(`api    proxied to ${API.origin}`);
});
