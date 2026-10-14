// Client for Redlib's token-gated /raw passthrough.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deonionize } = require('./media.cjs');

export class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Canonical fixture key for a /raw request: path plus sorted query. */
export function fixtureKey(path, params) {
  const sorted = [...new URLSearchParams(params)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = new URLSearchParams(sorted).toString();
  return q ? `${path}?${q}` : path;
}

export function fixtureFileName(key) {
  const slug = key.replace(/\?.*$/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 10);
  return `${slug || 'root'}-${hash}.json`;
}

/** Appends a recorded /raw response to `dir` (used by record-fixtures.sh). */
function record(dir, key, status, body) {
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const file = fixtureFileName(key);
  index[key] = { file, status };
  writeFileSync(join(dir, file), body);
  writeFileSync(indexPath, JSON.stringify(Object.fromEntries(Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + '\n');
}

export function createRedlibClient({
  baseUrl = process.env.REDLIB_URL || 'http://redlib:8080',
  token = process.env.REDLIB_RAW_TOKEN || '',
  timeoutMs = Number(process.env.REDLIB_TIMEOUT_MS || 60000),
  recordDir = process.env.RECORD_FIXTURES_DIR || '',
} = {}) {
  baseUrl = baseUrl.replace(/\/$/, '');
  const headers = { 'x-raw-token': token, accept: 'application/json' };

  /**
   * GET /raw{path}.json with `params` (object; undefined/null/'' values are dropped).
   * Resolves to parsed JSON; rejects with UpstreamError on non-200.
   */
  async function json(path, params = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const key = fixtureKey(path, clean);
    let res;
    try {
      res = await fetch(`${baseUrl}/raw${key}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new UpstreamError(502, `Redlib unreachable: ${err.cause?.code || err.name || err.message}`);
    }
    const body = deonionize(await res.text());
    if (recordDir) record(recordDir, key, res.status, body);
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new UpstreamError(res.status === 200 ? 502 : res.status, res.status === 404 ? 'Not found' : 'Invalid JSON from Redlib');
    }
    if (res.status !== 200) throw new UpstreamError(res.status, data.error || `Upstream status ${res.status}`);
    return data;
  }

  /** Streams /raw/media/{host}/{path}; returns the fetch Response. */
  function media(pathAndQuery, reqHeaders = {}) {
    const fwd = { 'x-raw-token': token };
    for (const h of ['range', 'if-modified-since', 'if-none-match', 'cache-control']) {
      if (reqHeaders[h]) fwd[h] = reqHeaders[h];
    }
    return fetch(`${baseUrl}/raw/media/${pathAndQuery}`, { headers: fwd, signal: AbortSignal.timeout(timeoutMs) });
  }

  /** Redlib liveness (robots.txt is outside the fingerprint gate). */
  async function ping() {
    const res = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  }

  return { json, media, ping };
}
