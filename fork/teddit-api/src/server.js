// Teddit-compatible API sidecar for Redlib. See ../API_SURFACE.md.

import http from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRedlibClient, UpstreamError } from './redlib.js';
import { handleApi, parseCookies } from './routes.js';

const require = createRequire(import.meta.url);
const { loadTeddit } = require('./teddit.cjs');
const { legacyMediaRedirect } = require('./media.cjs');

const MEDIA_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'last-modified',
  'etag',
  'expires',
];

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createApp({ redlib = createRedlibClient(), teddit, publicBaseUrl, log = console.log } = {}) {
  teddit ||= loadTeddit(undefined, { publicBaseUrl });

  async function route(req, res) {
    const url = new URL(req.url, 'http://internal');

    if (url.pathname === '/healthz') {
      const deep = url.searchParams.has('deep');
      try {
        if (!(await redlib.ping())) throw new Error('Redlib did not answer');
        if (deep) await redlib.json('/r/popular/hot.json', { limit: 1 });
        return sendJson(res, 200, { status: 'ok', redlib: 'ok', reddit: deep ? 'ok' : 'unchecked' });
      } catch (err) {
        return sendJson(res, 503, { status: 'error', error: err.message });
      }
    }

    if (url.pathname.startsWith('/media/')) {
      const upstream = await redlib.media(url.pathname.slice('/media/'.length) + url.search, req.headers);
      const headers = {};
      for (const h of MEDIA_RESPONSE_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      // fetch() already decoded the body; the length no longer matches if it was compressed.
      if (upstream.headers.get('content-encoding')) delete headers['content-length'];
      res.writeHead(upstream.status, headers);
      if (!upstream.body || req.method === 'HEAD') return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    }

    const legacy = legacyMediaRedirect(url.pathname, url.searchParams);
    if (legacy) {
      res.writeHead(302, { location: legacy });
      return res.end();
    }

    if (!url.searchParams.has('api')) return sendJson(res, 404, { error: 'Not found', status: 404 });

    const out = await handleApi(url, parseCookies(req.headers.cookie), { teddit, redlib });
    const headers = { ...out.headers };
    headers['content-length'] = Buffer.byteLength(out.body);
    res.writeHead(out.status, headers);
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }

  return http.createServer(async (req, res) => {
    const started = Date.now();
    res.on('finish', () => log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed', status: 405 });
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 500;
      if (!(err instanceof UpstreamError)) log(`error: ${err.stack || err}`);
      else if (status >= 500) log(`upstream ${status}: ${err.message}`);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: err.message || 'Internal error', status });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!process.env.REDLIB_RAW_TOKEN) {
    console.error('REDLIB_RAW_TOKEN is required');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  const server = createApp({ publicBaseUrl: process.env.PUBLIC_BASE_URL });
  server.listen(port, '0.0.0.0', () => console.log(`teddit-api listening on :${port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
