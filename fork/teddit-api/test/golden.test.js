// Every case in cases.json, replayed against the recorded fixtures, must match
// its golden output. Regenerate with fork/scripts/record-fixtures.sh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { TEST_DIR, runCases } from './helpers/spawn.js';

const { rewriteMediaUrls } = createRequire(import.meta.url)('../src/media.cjs');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const cases = JSON.parse(readFileSync(join(TEST_DIR, 'cases.json'), 'utf8'));
const results = runCases();

const fixtureDir = join(TEST_DIR, 'fixtures');
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8')))
  // target=reddit output is the fixture with media URLs pointed at /media/.
  .map((j) => rewriteMediaUrls(j, 'https://teddit.example'));

for (const c of cases) {
  test(`golden: ${c.name}`, () => {
    const golden = JSON.parse(readFileSync(join(TEST_DIR, 'golden', `${c.name}.json`), 'utf8'));
    const r = results[c.name];
    assert.equal(r.url, golden.url);
    assert.equal(r.status, golden.status);
    assert.equal(r.contentType, golden.contentType);
    if (golden.sha256) {
      assert.equal(sha256(r.body), golden.sha256);
    } else if (r.contentType?.includes('json')) {
      assert.deepEqual(JSON.parse(r.body), golden.body);
    } else {
      assert.equal(r.body, golden.body);
    }
  });
}

test('target=reddit returns the upstream JSON, media URLs proxied', () => {
  for (const c of cases.filter((c) => /[?&](target=reddit|raw=true)/.test(c.url) && !c.name.startsWith('error_'))) {
    const body = JSON.parse(results[c.name].body);
    // Teddit attaches suggested_subreddits to search results even in raw mode.
    delete body.suggested_subreddits;
    if (body.about && body.overview) {
      // User routes combine two Reddit responses, exactly as Teddit does.
      assert.ok(fixtures.some((f) => JSON.stringify(f) === JSON.stringify(body.about)), c.name);
      assert.ok(fixtures.some((f) => JSON.stringify(f) === JSON.stringify(body.overview)), c.name);
    } else {
      assert.ok(fixtures.some((f) => JSON.stringify(f) === JSON.stringify(body)), c.name);
    }
  }
});

test('target=reddit never points clients at Reddit media hosts', () => {
  const media = /"https?:\/\/(i|v|preview|external-preview)\.redd\.it\/|"https?:\/\/[ab]\.thumbs\.redditmedia\.com\/|"https?:\/\/(styles|emoji)\.redditmedia\.com\//;
  for (const c of cases.filter((c) => c.name.startsWith('stealth_'))) {
    assert.doesNotMatch(results[c.name].body, media, c.name);
  }
  const post = JSON.parse(results.post_gallery_reddit.body)[0].data.children[0].data;
  assert.equal(post.domain, 'reddit.com');
  assert.match(post.url, /^https:\/\/www\.reddit\.com\/gallery\//);
  const item = Object.values(post.media_metadata)[0];
  assert.match(item.s.u, /^https:\/\/teddit\.example\/media\/preview\.redd\.it\//);
});

test('Stealth request shapes all succeed', () => {
  for (const c of cases.filter((c) => c.name.startsWith('stealth_'))) {
    assert.equal(results[c.name].status, 200, c.name);
    assert.match(results[c.name].contentType, /application\/json/, c.name);
  }
});

test('API URLs and media point at the public base URL or /media/', () => {
  const pics = JSON.parse(results.sub_pics.body);
  const withThumb = pics.links.filter((l) => l.images && l.images.thumb !== 'self');
  assert.ok(withThumb.length > 0);
  for (const l of withThumb) {
    assert.match(l.permalink, /^https:\/\/teddit\.example\/r\/pics\/comments\//);
    assert.match(l.images.thumb, /^https:\/\/teddit\.example\/media\/(preview|external-preview|i)\.redd\.it\/|^https:\/\/teddit\.example\/media\/[ab]\.thumbs\.redditmedia\.com\//);
  }
  // No onion hostnames leak into any output.
  for (const r of Object.values(results)) assert.doesNotMatch(r.body, /\.onion/);
});
