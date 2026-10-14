// Copies recorded /raw fixtures from SRC to DST, dropping session-specific
// fields so re-recording produces minimal diffs.
//
//   node test/helpers/sanitize-fixtures.js SRC DST

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { deonionize } = createRequire(import.meta.url)('../../src/media.cjs');

const DROP = new Set(['modhash', 'websocket_url', 'user_reports', 'mod_reports', 'report_reasons']);

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (!DROP.has(k)) out[k] = scrub(val);
    return out;
  }
  return v;
}

const [src, dst] = process.argv.slice(2);
const index = JSON.parse(readFileSync(join(src, 'index.json'), 'utf8'));
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const { file } of Object.values(index)) {
  const raw = deonionize(readFileSync(join(src, file), 'utf8'));
  let body;
  try {
    body = JSON.stringify(scrub(JSON.parse(raw)));
  } catch {
    body = raw;
  }
  writeFileSync(join(dst, file), body + '\n');
}
writeFileSync(join(dst, 'index.json'), JSON.stringify(Object.fromEntries(Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + '\n');
console.log(`${Object.keys(index).length} fixtures → ${dst}`);
