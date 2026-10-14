import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server.js';
import { createRedlibClient, fixtureKey } from '../src/redlib.js';
import { parseCookies, userPreferences } from '../src/routes.js';
import { createMockRedlib } from './mock-redlib.js';

const require = createRequire(import.meta.url);
const { mediaPath, createDownloadAndSave, deonionize, legacyMediaRedirect } = require('../src/media.cjs');
const { loadTeddit } = require('../src/teddit.cjs');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('mediaPath maps Reddit media hosts under /media/', () => {
  assert.equal(mediaPath('https://i.redd.it/a.jpg'), '/media/i.redd.it/a.jpg');
  assert.equal(
    mediaPath('https://preview.redd.it/x.jpeg?width=108&s=abc'),
    '/media/preview.redd.it/x.jpeg?width=108&s=abc',
  );
  assert.equal(mediaPath('https://i.ytimg.com/vi/x/hqdefault.jpg'), 'https://i.ytimg.com/vi/x/hqdefault.jpg');
  assert.equal(mediaPath('not a url'), '');
});

test('downloadAndSave keeps Teddit semantics', async () => {
  const dl = createDownloadAndSave({ valid_media_domains: ['i.redd.it', 'v.redd.it', 'preview.redd.it'], video_enabled: true });
  assert.equal(await dl('self'), 'self');
  assert.equal(await dl('default'), 'self');
  assert.equal(await dl(undefined), 'self');
  assert.equal(await dl('https://evil.example/a.jpg'), '');
  assert.equal(await dl('https://preview.redd.it/a.jpg?width=1&amp;s=2'), '/media/preview.redd.it/a.jpg?width=1&s=2');
  assert.equal(await dl('https://v.redd.it/id/DASH_480.mp4?source=fallback'), '/media/v.redd.it/id/DASH_480.mp4?source=fallback');
  const novideo = createDownloadAndSave({ valid_media_domains: ['v.redd.it'], video_enabled: false });
  assert.equal(await novideo('https://v.redd.it/id/DASH_480.mp4'), '');
  assert.equal(await novideo('https://v.redd.it/id/DASH_480'), '');
});

test('deonionize maps Reddit onion hosts back to clearnet', () => {
  assert.equal(
    deonionize('https://preview.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion/a.jpg'),
    'https://preview.redd.it/a.jpg',
  );
  assert.equal(deonionize('https://www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion/r/x'), 'https://www.reddit.com/r/x');
  assert.equal(
    deonionize('https://b.thumbs.reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion/t.jpg'),
    'https://b.thumbs.redditmedia.com/t.jpg',
  );
  assert.equal(deonionize('no onions here'), 'no onions here');
});

test('legacy Teddit media URLs redirect to /media/', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(legacyMediaRedirect('/pics/w:null_abc.png', q('')), '/media/i.redd.it/abc.png');
  assert.equal(legacyMediaRedirect('/vids/abc123.mp4', q('')), '/media/v.redd.it/abc123/HLSPlaylist.m3u8');
  assert.equal(legacyMediaRedirect('/abc.png', q('teddit_proxy=i.redd.it')), '/media/i.redd.it/abc.png');
  assert.equal(legacyMediaRedirect('/abc.png', q('width=5&teddit_proxy=preview.redd.it')), '/media/preview.redd.it/abc.png?width=5');
  assert.equal(legacyMediaRedirect('/abc.png', q('teddit_proxy=evil.example')), null);
  assert.equal(legacyMediaRedirect('/r/rust', q('')), null);
});

test('cookies parse like cookie-parser', () => {
  const c = parseCookies('flairs=false; subbed_subreddits=j%3A%5B%22rust%22%2C%22linux%22%5D; theme=dark');
  assert.equal(c.flairs, 'false');
  assert.deepEqual(c.subbed_subreddits, ['rust', 'linux']);
  assert.equal(c.theme, 'dark');
  assert.deepEqual(parseCookies(''), {});
});

test('query parameters override preferences like overides.js', () => {
  const config = { theme: 'auto', post_media_max_heights: { medium: 600 }, show_upvoted_percentage: true };
  const p = userPreferences({ flairs: 'true' }, { flairs: 'false', nsfw_enabled: 'false', domain_youtube: 'yt.example' }, config);
  assert.equal(p.flairs, 'false');
  assert.equal(p.nsfw_enabled, 'false');
  assert.equal(p.domain_youtube, 'yt.example');
  assert.equal(p.theme, 'auto');
  assert.equal(p.show_upvoted_percentage, 'true');
});

test('fixture keys sort the query', () => {
  assert.equal(fixtureKey('/r/x.json', { t: 'day', after: 'a' }), '/r/x.json?after=a&t=day');
  assert.equal(fixtureKey('/r/x.json', {}), '/r/x.json');
});

test('server: health, media, legacy redirects, non-API and errors', async (t) => {
  const mock = createMockRedlib({ token: 'tok' });
  const mockUrl = `http://127.0.0.1:${await listen(mock)}`;
  const teddit = loadTeddit(undefined, { publicBaseUrl: 'https://teddit.example' });
  const app = createApp({ redlib: createRedlibClient({ baseUrl: mockUrl, token: 'tok' }), teddit, log: () => {} });
  const base = `http://127.0.0.1:${await listen(app)}`;
  const bad = createApp({ redlib: createRedlibClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', timeoutMs: 2000 }), teddit, log: () => {} });
  const badBase = `http://127.0.0.1:${await listen(bad)}`;
  t.after(() => {
    app.close();
    bad.close();
    mock.close();
  });

  let r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok', redlib: 'ok', reddit: 'unchecked' });

  r = await fetch(`${badBase}/healthz`);
  assert.equal(r.status, 503);

  r = await fetch(`${base}/media/i.redd.it/x.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok((await r.arrayBuffer()).byteLength > 0);

  r = await fetch(`${base}/pics/w:null_x.png`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/media/i.redd.it/x.png');

  r = await fetch(`${base}/r/rust`);
  assert.equal(r.status, 404);

  r = await fetch(`${base}/r/rust?api`, { method: 'POST' });
  assert.equal(r.status, 405);

  r = await fetch(`${badBase}/r/rust?api`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Redlib unreachable/);

  r = await fetch(`${base}/r/rust/wiki/index?api`);
  assert.equal(r.status, 404);
});
