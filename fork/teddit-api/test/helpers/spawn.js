// Runs run-cases.js in a child process (one Teddit tree per process) and
// returns its results.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEST_DIR = join(HERE, '..');

export function runCases(tedditDir) {
  const dir = mkdtempSync(join(tmpdir(), 'teddit-cases-'));
  const out = join(dir, 'out.json');
  try {
    const args = [join(HERE, 'run-cases.js'), '--out', out];
    if (tedditDir) args.push('--teddit', tedditDir);
    execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
