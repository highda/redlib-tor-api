// Teddit API routes. Each mirrors the `api` branch of the matching handler in
// Teddit's routes/*.js: same defaults and validation, same Reddit request, then
// the unmodified Teddit API handler builds the response. Deviations are
// listed in API_SURFACE.md.

import { createRequire } from 'node:module';
import { UpstreamError } from './redlib.js';

const { rewriteMediaUrls } = createRequire(import.meta.url)('./media.cjs');

const LISTING_SORTS = ['new', 'rising', 'controversial', 'top', 'gilded', 'hot'];
const PASTS = ['hour', 'day', 'week', 'month', 'year', 'all'];
const COMMENT_SORTS = ['confidence', 'top', 'new', 'controversial', 'old', 'qa', 'random'];
const USER_SORTS = ['hot', 'new', 'controversial', 'top'];
const SUBREDDITS_SORTS = ['', 'popular', 'new', 'default'];
const MEDIA_EXTS = ['.jpg', '.png', '.jpeg', '.mp4', '.gif', '.gifv'];

class BadRequest extends UpstreamError {
  constructor(message) {
    super(400, message);
  }
}

/** cookie-parser semantics: URI-decoded values, `j:` prefix means JSON. */
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    let val = part.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try {
      val = decodeURIComponent(val);
    } catch {}
    if (val.startsWith('j:')) {
      try {
        val = JSON.parse(val.slice(2));
      } catch {}
    }
    out[name] = val;
  }
  return out;
}

/** Query overrides of preferences, as in Teddit's routes/overides.js. */
export function userPreferences(cookies, query, config) {
  const prefs = { ...cookies };
  if (query.theme) prefs.theme = query.theme.toLowerCase();
  else if (!prefs.theme && prefs.theme !== '') prefs.theme = config.theme;
  for (const key of [
    'flairs',
    'nsfw_enabled',
    'highlight_controversial',
    'collapse_child_comments',
    'domain_twitter',
    'domain_youtube',
    'domain_instagram',
    'domain_quora',
    'domain_imgur',
    'videos_muted',
  ]) {
    if (query[key]) prefs[key] = query[key];
  }
  const h = query.post_media_max_height;
  if (h && (Object.prototype.hasOwnProperty.call(config.post_media_max_heights, h) || !isNaN(h))) {
    prefs.post_media_max_height = h;
  }
  if (query.show_upvoted_percentage) prefs.show_upvoted_percentage = query.show_upvoted_percentage;
  else if (!prefs.show_upvoted_percentage && config.show_upvoted_percentage) prefs.show_upvoted_percentage = 'true';
  return prefs;
}

/** Teddit's `d` fragment: `after` unless `before` is set. */
function cursor(after, before) {
  return before ? { before } : { after };
}

/** Captures what a Teddit handler writes to its Express `res`. */
function captureRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(body = '') {
      this.body = body;
    },
  };
  return res;
}

function decode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Routes an `?api` request. Returns { status, headers, body }.
 * @param {URL} url
 * @param {object} cookies parsed cookies
 * @param {{ teddit: object, redlib: object }} deps
 */
export async function handleApi(url, cookies, { teddit, redlib }) {
  const query = Object.fromEntries(url.searchParams);
  const req = { query, cookies: userPreferences(cookies, query, teddit.config) };
  const res = captureRes();
  const type = query.type;
  // Teddit's raw passthrough is `target=reddit`; `raw=true` is accepted as an alias.
  const target = query.target || (query.raw === 'true' || query.raw === '1' ? 'reddit' : undefined);
  const raw_json = query.raw_json == '1' ? 1 : 0;
  const segs = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decode);
  if (segs.length === 1 && segs[0] === '') segs.length = 0;

  // target=reddit returns Reddit's JSON. Unless RAW_MEDIA_PROXY=off, its media URLs
  // are pointed at /media/ so clients (e.g. Stealth) never contact Reddit's CDNs.
  if (target === 'reddit' && type !== 'rss' && process.env.RAW_MEDIA_PROXY !== 'off') {
    const { config } = teddit;
    const base = `${config.https_enabled ? 'https' : 'http'}://${config.domain}`;
    const upstream = redlib;
    redlib = { ...upstream, json: async (...args) => rewriteMediaUrls(await upstream.json(...args), base) };
  }
  const ctx = { query, req, res, type, target, raw_json, teddit, redlib };
  const [a, b, c, d, e, f] = segs;
  const n = segs.length;

  if (a === 'r' && n >= 2) {
    if (b === 'random' && n === 2) throw new UpstreamError(404, '/r/random is not supported by Reddit anymore');
    if (n === 3 && c === 'search') await subredditSearch(ctx, b);
    else if (n === 3 && c === 'about') await subredditAbout(ctx, b);
    else if (n <= 3) await subredditListing(ctx, b, c);
    else if (c === 'comments' && n >= 4 && n <= 6) await post(ctx, `/r/${b}/comments/${d}`, e, f);
    else throw new UpstreamError(404, 'No such API route');
  } else if (a === 'comments' && n >= 2 && n <= 4) {
    await post(ctx, `/comments/${b}`, c, d);
  } else if ((a === 'u' || a === 'user') && (n === 2 || n === 3)) {
    await user(ctx, b, c);
  } else if (a === 'users' && b === 'search' && n === 2) {
    await usersSearch(ctx);
  } else if (a === 'subreddits' && n <= 2) {
    await subredditsExplore(ctx, b || '');
  } else if (a === 'search' && n === 1) {
    if (query.q === undefined) throw new BadRequest('Missing q');
    await subredditSearch(ctx, 'all', {
      restrict_sr: query.restrict_sr === 'on' ? 'on' : 'off',
      nsfw: query.nsfw === 'on' ? 'on' : 'off',
    });
  } else if (n <= 1) {
    await frontpage(ctx, a || '');
  } else {
    throw new UpstreamError(404, 'No such API route');
  }

  return { status: res.statusCode, headers: res.headers, body: res.body };
}

function listingPast(sortby, past, invalidMsg) {
  if (past) {
    if (sortby === 'controversial' || sortby === 'top') {
      if (!PASTS.includes(past)) throw new BadRequest(invalidMsg);
      return past;
    }
    return undefined;
  }
  return sortby === 'controversial' || sortby === 'top' ? 'day' : undefined;
}

// routes/home.js
async function frontpage(ctx, sortParam) {
  let sortby = sortParam;
  const { query, req, res, type, target, raw_json, teddit, redlib } = ctx;
  if (MEDIA_EXTS.some((ext) => sortby.includes(ext))) throw new UpstreamError(404, 'Not found');
  // Teddit redirects 6–7 character paths to the comment page.
  if ((sortby.length === 6 || sortby.length === 7) && sortby !== 'rising') {
    return post(ctx, `/comments/${sortby}`);
  }
  if (sortby === '' || sortby === 'frontpage') sortby = 'hot';
  if (!LISTING_SORTS.includes(sortby)) throw new BadRequest('Invalid sort');
  const past = listingPast(sortby, query.t, 'Invalid t');

  let path = `/${sortby}.json`;
  const params = { t: past, ...cursor(query.after, query.before), limit: query.limit, raw_json };
  const subbed = req.cookies.subbed_subreddits;
  if (subbed && Array.isArray(subbed)) {
    path = `/r/${subbed.join('+')}/${sortby}.json`;
    params.count = 25;
  }
  const json = await redlib.json(path, params);
  await teddit.handleSubreddit(json, req, res, 'from_online', type, target, '/', 'full');
}

// routes/subreddit.js: /r/:subreddit/:sort?
async function subredditListing(ctx, subreddit, sortParam) {
  const { query, req, res, type, target, raw_json, teddit, redlib } = ctx;
  const sortby = sortParam || 'hot';
  if (!LISTING_SORTS.includes(sortby)) throw new BadRequest('Invalid sort');
  const past = listingPast(sortby, query.t, 'Invalid t');
  const json = await redlib.json(`/r/${subreddit}/${sortby}.json`, {
    count: 25,
    t: past,
    ...cursor(query.after, query.before),
    limit: query.limit,
    raw_json,
  });
  await teddit.handleSubreddit(json, req, res, 'from_online', type, target, subreddit, query.mode);
}

// routes/subreddit.js: /r/:subreddit/about (API only)
async function subredditAbout(ctx, subreddit) {
  const { res, target, raw_json, teddit, redlib } = ctx;
  const json = await redlib.json(`/r/${subreddit}/about.json`, { raw_json });
  await teddit.handleSubredditAbout(json, res, 'from_online', target);
}

// routes/subreddit.js: /r/:subreddit/search
async function subredditSearch(ctx, subreddit, normalized = {}) {
  const { query, req, res, type, target, raw_json, teddit, redlib } = ctx;
  const q = query.q;
  if (q === undefined) throw new BadRequest('Missing q');
  const after = query.after || '';
  const before = query.before || '';
  const restrict_sr = (normalized.restrict_sr ?? query.restrict_sr) === 'on' ? 'on' : 'off';
  const nsfw = (normalized.nsfw ?? query.nsfw) === 'on' ? 'on' : 'off';

  const json = await redlib.json(`/r/${subreddit}/search.json`, {
    q,
    restrict_sr,
    include_over_18: nsfw,
    sort: query.sort,
    t: query.t,
    count: after === '' ? undefined : 25,
    ...cursor(after, before),
    limit: query.limit,
    raw_json,
  });
  // Suggested subreddits on the first unrestricted page, as Reddit does.
  json.suggested_subreddits = {};
  if (restrict_sr === 'off' && before === '' && after === '') {
    try {
      json.suggested_subreddits = await redlib.json('/subreddits/search.json', { q, include_over_18: nsfw, limit: 3 });
    } catch {}
  }
  await teddit.handleSubredditSearch(json, req, res, 'from_online', type, target, subreddit, q, query.mode);
}

// routes/subreddit.js: /r/:subreddit/comments/:id/:snippet?/:comment_id?
async function post(ctx, base, snippet, comment_id) {
  const { query, req, res, type, target, raw_json, teddit, redlib } = ctx;
  let sortby = query.sort || req.cookies.default_comment_sort;
  if (sortby === 'best') sortby = 'confidence';
  if (!sortby) sortby = teddit.config.post_comments_sort;
  if (!COMMENT_SORTS.includes(sortby)) throw new BadRequest('Invalid sort');
  const context = parseInt(query.context);

  let path = base;
  if (snippet !== undefined) path += `/${encodeURIComponent(snippet)}`;
  if (comment_id !== undefined) path += `/${comment_id}`;
  const json = await redlib.json(`${path}.json`, {
    sort: sortby,
    context: Number.isNaN(context) ? undefined : context,
    // Continues a thread from a "more" stub, whose id is the cursor (extension, see API_SURFACE.md)
    cursor: query.cursor || undefined,
    raw_json,
  });
  await teddit.handlePost(json, req, res, 'from_online', type, target);
}

// routes/subreddit.js: /subreddits/:sort?
async function subredditsExplore(ctx, sortby) {
  const { query, req, res, type, target, raw_json, teddit, redlib } = ctx;
  const after = query.after || '';
  const before = query.before || '';
  const nsfw = query.nsfw === 'on' ? 'on' : 'off';
  let json;
  if (sortby === 'search') {
    if (query.q === undefined || query.q === '') throw new BadRequest('Missing q');
    json = await redlib.json('/subreddits/search.json', { q: query.q, include_over_18: nsfw, ...cursor(after, before), raw_json });
  } else {
    if (!SUBREDDITS_SORTS.includes(sortby)) throw new BadRequest('Invalid sort');
    json = await redlib.json(sortby ? `/subreddits/${sortby}.json` : '/subreddits.json', {
      count: 25,
      ...cursor(after, before),
      raw_json,
    });
  }
  await teddit.handleSubredditsExplore(json, req, res, 'from_online', type, target, query.q);
}

// Not in Teddit: /users/search, Reddit's user search. Only as Reddit's JSON (target=reddit).
async function usersSearch(ctx) {
  const { query, res, target, raw_json, redlib } = ctx;
  if (target !== 'reddit') throw new UpstreamError(404, 'User search is only available with target=reddit');
  if (query.q === undefined || query.q === '') throw new BadRequest('Missing q');
  const json = await redlib.json('/users/search.json', {
    q: query.q,
    include_over_18: query.nsfw === 'on' ? 'on' : 'off',
    ...cursor(query.after, query.before),
    limit: query.limit,
    raw_json,
  });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(json));
}

// routes/user.js: /u/:user/:kind?  (Teddit's /user/ redirect drops `api`; we serve both)
async function user(ctx, name, kindParam) {
  const { query, req, res, type, target, raw_json, teddit, redlib } = ctx;
  const after = query.after || '';
  const before = query.before || '';
  let post_type = `/${kindParam}`;
  if (post_type !== '/comments' && post_type !== '/submitted') post_type = '';

  const sortby = query.sort || 'new';
  if (!USER_SORTS.includes(sortby)) throw new BadRequest('Invalid sort');
  let past = query.t;
  if (past) {
    if (sortby === 'controversial' || sortby === 'top') {
      if (!PASTS.includes(past)) throw new BadRequest('Invalid t');
    } else past = '';
  } else past = sortby === 'controversial' || sortby === 'top' ? 'all' : '';

  const user_data = {};
  user_data.about = await redlib.json(`/user/${name}/about.json`, { raw_json });
  user_data.overview = await redlib.json(`/user/${name}${post_type || '/overview'}.json`, {
    limit: 26,
    ...cursor(after, before),
    sort: sortby,
    t: past,
    raw_json,
  });
  await teddit.handleUser(user_data, req, res, 'online', type, target, name, after, before);
}
