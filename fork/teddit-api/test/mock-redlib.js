// Stand-in for Redlib's /raw passthrough, serving recorded fixtures.
// Used by the tests and by fork/deploy/compose.test.yaml (offline stack).
//
//   node test/mock-redlib.js [port]     env: FIXTURES_DIR, REDLIB_RAW_TOKEN

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureKey } from '../src/redlib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURES = join(HERE, 'fixtures');

// 1x1 transparent PNG for any /raw/media request.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export function createMockRedlib({ fixturesDir = DEFAULT_FIXTURES, token = process.env.REDLIB_RAW_TOKEN || 'test-token' } = {}) {
  const indexPath = join(fixturesDir, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const seen = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    if (!url.pathname.startsWith('/raw/') || req.headers['x-raw-token'] !== token) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const path = url.pathname.slice('/raw'.length);
    if (path === '/media/slow.test/video.mp4') {
      // Trickles 10 chunks over ~1 s, to exercise long media streams.
      res.writeHead(200, { 'content-type': 'video/mp4' });
      let n = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(Buffer.alloc(1024, n));
        if (++n === 10) {
          clearInterval(t);
          res.end();
        }
      }, 100);
      return;
    }
    if (path.startsWith('/media/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PIXEL.length });
      return res.end(PIXEL);
    }
    const key = fixtureKey(path, url.searchParams);
    seen.push(key);
    const entry = index[key];
    if (!entry) {
      const body = JSON.stringify({ error: `no fixture for ${key}`, status: 404 });
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(body);
    }
    res.writeHead(entry.status, { 'content-type': 'application/json' });
    res.end(readFileSync(join(fixturesDir, entry.file)));
  });
  server.seen = seen;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  const server = createMockRedlib({ fixturesDir: process.env.FIXTURES_DIR || DEFAULT_FIXTURES });
  server.listen(port, '0.0.0.0', () => console.log(`mock redlib on :${port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
