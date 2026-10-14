// Runs every case in test/cases.json through the sidecar and prints the
// results as JSON. One Teddit tree per process (Teddit uses globals).
//
//   node test/helpers/run-cases.js [--teddit DIR] [--redlib URL] [--out FILE] [--update-goldens]
//
// Without --redlib, a mock Redlib serves test/fixtures. With --redlib and
// RECORD_FIXTURES_DIR set, the /raw responses are recorded (record-fixtures.sh).

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createRedlibClient } from '../../src/redlib.js';
import { createMockRedlib } from '../mock-redlib.js';

const require = createRequire(import.meta.url);
const { loadTeddit } = require('../../src/teddit.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEST_DIR = join(HERE, '..');
export const PUBLIC_BASE_URL = 'https://teddit.example';
const TOKEN = 'test-token';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const isPassthrough = (url) => /[?&](target=reddit|raw=true)(&|$)/.test(url);

export function goldenName(name) {
  return join(TEST_DIR, 'golden', `${name}.json`);
}

async function main() {
  const cases = JSON.parse(readFileSync(join(TEST_DIR, 'cases.json'), 'utf8'));
  let redlibUrl = arg('--redlib');
  let mock;
  if (!redlibUrl) {
    mock = createMockRedlib({ token: TOKEN });
    redlibUrl = `http://127.0.0.1:${await listen(mock)}`;
  }
  const teddit = loadTeddit(arg('--teddit'), { publicBaseUrl: PUBLIC_BASE_URL });
  const redlib = createRedlibClient({ baseUrl: redlibUrl, token: mock ? TOKEN : process.env.REDLIB_RAW_TOKEN });
  const app = createApp({ redlib, teddit, log: () => {} });
  const base = `http://127.0.0.1:${await listen(app)}`;

  const results = {};
  for (const c of cases) {
    let url = c.url;
    if (c.after_from) {
      const prev = JSON.parse(results[c.after_from].body);
      url = url.replace('{after}', encodeURIComponent(prev.info?.after ?? prev.data?.after ?? prev.after ?? ''));
    }
    const res = await fetch(base + url);
    results[c.name] = { url, status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
  }
  app.close();
  mock?.close();

  if (process.argv.includes('--update-goldens')) {
    rmSync(join(TEST_DIR, 'golden'), { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'golden'), { recursive: true });
    for (const [name, r] of Object.entries(results)) {
      // Raw passthrough bodies duplicate the fixtures; keep only a digest.
      const golden = isPassthrough(r.url)
        ? { ...r, body: undefined, sha256: sha256(r.body) }
        : { ...r, body: r.contentType?.includes('json') ? JSON.parse(r.body) : r.body };
      writeFileSync(goldenName(name), JSON.stringify(golden, null, 2) + '\n');
    }
  }
  const out = JSON.stringify(results);
  const outFile = arg('--out');
  if (outFile) writeFileSync(outFile, out);
  else if (!process.argv.includes('--update-goldens')) process.stdout.write(out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
