// Differential test: the same cases, replayed through an untouched Teddit
// checkout (TEDDIT_REF_DIR) and through our vendored copy, must produce
// identical output. Both runs use the same media shim (downloadAndSave →
// /media/ URLs) and config; that shim is the only documented rewrite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_DIR, runCases } from './helpers/spawn.js';

const REF_DIR = process.env.TEDDIT_REF_DIR || join(TEST_DIR, '..', '..', '..', '..', 'refs', 'teddit');
const PINNED = '3d5fb4bb92f1a214f4990289a7a6e003d1bb2477';

test('reference Teddit checkout is present at the pinned commit', () => {
  assert.ok(
    existsSync(join(REF_DIR, 'inc', 'processJsonPost.js')),
    `Teddit reference not found at ${REF_DIR}; set TEDDIT_REF_DIR (fork/scripts/check.sh fetches it)`,
  );
  const head = join(REF_DIR, '.git', 'HEAD');
  if (existsSync(head)) {
    const ref = readFileSync(head, 'utf8').trim();
    const sha = ref.startsWith('ref: ') ? readFileSync(join(REF_DIR, '.git', ref.slice(5)), 'utf8').trim() : ref;
    assert.equal(sha, PINNED, 'reference checkout is not at the pinned commit');
  }
});

test('vendored Teddit output equals unmodified Teddit output for every case', { skip: !existsSync(REF_DIR) && 'no reference' }, () => {
  const ours = runCases();
  const theirs = runCases(REF_DIR);
  assert.deepEqual(Object.keys(ours), Object.keys(theirs));
  for (const name of Object.keys(ours)) {
    assert.equal(ours[name].status, theirs[name].status, name);
    assert.equal(ours[name].contentType, theirs[name].contentType, name);
    if (ours[name].contentType?.includes('json')) {
      assert.deepEqual(JSON.parse(ours[name].body), JSON.parse(theirs[name].body), name);
    } else {
      assert.equal(ours[name].body, theirs[name].body, name);
    }
  }
});
