# Teddit API surface

The spec for `fork/teddit-api`, derived from Teddit's source at
[`3d5fb4bb`](https://codeberg.org/teddit/teddit/src/commit/3d5fb4bb92f1a214f4990289a7a6e003d1bb2477)
(`routes/*.js`, `inc/teddit_api/*.js`, `routes/overides.js`). Teddit's behaviour is
the spec; every deviation is listed at the end.

A request is an API request when its query string has an `api` key (`?api`,
`?api=`, `?api=1`, …). Caddy sends those to teddit-api and everything else to Redlib.

## Common parameters

| Param | Values | Default | Effect |
|---|---|---|---|
| `api` | present | | Marks an API request (required). |
| `type` | `json`, `rss` | `json` | Output format. Anything other than `rss` is JSON. |
| `target` | `reddit` | | Return Reddit's own JSON untouched instead of Teddit's processed JSON. RSS ignores it. |
| `raw` | `true`, `1` | | **Alias** for `target=reddit` (not in Teddit). |
| `raw_json` | `1` | `0` | Forwarded to Reddit. `0` = HTML-escaped bodies (Teddit's processors unescape them), `1` = unescaped. |
| `mode` | `light` | `full` | Subreddit and search JSON only: `selftext_html` set to `null`. |
| `after`, `before` | fullname (`t3_…`) | | Pagination cursor; `before` wins if both are set. |

Preference overrides (from `routes/overides.js`; also read from cookies of the same
name). They change processed JSON and RSS, never `target=reddit` output:

| Param | Effect |
|---|---|
| `nsfw_enabled=false` | Drops `over_18` posts. Instance default: `NSFW_ENABLED` (true). |
| `flairs=false` | Empty `link_flair` / `user_flair`. |
| `highlight_controversial=false` | Empty `controversiality` on comments. |
| `domain_youtube`, `domain_twitter`, `domain_instagram`, `domain_quora`, `domain_imgur` | Rewrite those links in HTML bodies to the given host. |
| `theme`, `post_media_max_height`, `collapse_child_comments`, `show_upvoted_percentage`, `videos_muted` | Accepted, no effect on API output. |

## Routes

Path segments in `{}`; `?` marks optional ones.

### Front page: `/{sort}?`, `/frontpage`
- `sort`: `hot` (default), `new`, `rising`, `controversial`, `top`, `gilded`.
- `t` (only with `top`/`controversial`): `hour`, `day` (default), `week`, `month`, `year`, `all`.
- Cookie `subbed_subreddits` (`j:["a","b"]`) turns it into `/r/a+b/{sort}`.
- A 6 or 7 character path other than `rising` is treated as a post id (`/comments/{id}`), as Teddit does.
- Reddit: `/{sort}.json`. JSON: `{ info: {before, after}, links: [link…] }`. RSS: channel "teddit frontpage".

### Subreddit: `/r/{sub}/{sort}?`
- `sub` may be a multi (`rust+linux`). Same `sort`/`t` rules as the front page; `count=25` is sent.
- Reddit: `/r/{sub}/{sort}.json`. JSON/RSS as the front page.

### Subreddit about: `/r/{sub}/about` (API only)
- Reddit: `/r/{sub}/about.json`. JSON: `{ title, public_description_html, active_user_count, subscribers, created_utc, over18, description_html, moderators }`.

### Subreddit search: `/r/{sub}/search`
- `q` (required), `restrict_sr` (`on`/`off`, default `off`), `nsfw` (`on`/`off` → Reddit `include_over_18`, default `off`), `sort`, `t` (passed through unvalidated, e.g. Stealth sends `sort=relevance&t=all`).
- On the first page with `restrict_sr=off`, Reddit's `/subreddits/search?limit=3` is attached as `suggested_subreddits` (also in `target=reddit` output, as in Teddit).
- JSON: `{ search_firstpage, before, after, posts: [link…], suggested_subreddits }`. RSS channel "`q` - /r/`sub`".

### Search everything: `/search`
- Same as `/r/all/search`. (Teddit redirects here and drops `api`; see deviations.)

### Post: `/r/{sub}/comments/{id}/{slug}?/{comment_id}?`
- `sort`: `confidence` (default; `best` is mapped to it), `top`, `new`, `controversial`, `old`, `qa`, `random`. Cookie `default_comment_sort` is honoured.
- `context`: integer, forwarded. `limit` is accepted and ignored (Teddit ignores it too).
- `cursor` (extension): continues the thread from a "more" stub. Reddit no longer serves
  `/api/morechildren` or the comments JSON to anonymous clients, so threads come from its
  GraphQL API, and a stub's `id` is a continuation cursor instead of a comment id (its
  `children` is empty). A stub under the post: request the post with `cursor=<id>` for the
  next top-level comments. A stub under comment `X`: request `/comments/{id}/_/{X}` with
  `cursor=<id>` for the rest of X's replies, as top-level children. Both answers end with
  another stub while more remain. Up to 200 comments per answer.
- Reddit: same path + `.json`. JSON: Teddit post object (`title`, `author`, `selftext`, `media`, `images`, `gallery_items`, `crosspost`, `comments: [comment…]` with nested `replies` and `load_more` stubs). RSS: the post plus one `<item>` per top-level comment.

### Post by id: `/comments/{id}/{slug}?/{comment_id}?`
- As above without the subreddit (not in Teddit; see deviations).

### User: `/u/{user}/{kind}?`, `/user/{user}/{kind}?`
- `kind`: none (overview), `submitted`, `comments`.
- `sort`: `new` (default), `hot`, `top`, `controversial`. `t` (only with `top`/`controversial`): default `all`.
- Reddit: `/user/{user}/about.json` then `/user/{user}/{kind|overview}.json?limit=26`.
- `target=reddit`: `{ about: <Reddit about>, overview: <Reddit listing> }` (what Stealth reads).
- JSON: `{ username, icon_img, created, verified, link_karma, comment_karma, view_more_posts, user_front, post_type, before, after, posts }`. RSS: up to 25 items.

### Custom feed: `/u/{user}/m/{feed}/{sort}?`, `/user/{user}/m/{feed}/{sort}?`
- A public custom feed (multireddit), served like a subreddit listing: same `sort`, `t`,
  `after`, `before`, `limit`, `mode`, output and RSS.
- Reddit: `/user/{user}/m/{feed}/{sort}.json?count=25`.

### User search: `/users/search` (extension, `target=reddit` only)
- `q` (required), `nsfw` (`on`/`off` → Reddit `include_over_18`), `after`, `before`, `limit`.
- Reddit: `/users/search.json`, returned as is. Without `target=reddit`: 404 (Teddit has no
  user search and so no format for it).

### Subreddit discovery: `/subreddits/{sort}?`
- `sort`: none, `popular`, `new`, `default`, or `search` (needs `q`; `nsfw=on` includes NSFW).
- JSON: `{ info, links: [{ created, id, display_name, display_name_prefixed, public_description, url, subscribers, over_18, title, subreddit_front }] }`. RSS: one item per subreddit.

## Media

Teddit downloaded media to disk and served `/pics/...` and `/vids/...`. Here media
URLs point at `/media/{host}/{path}?{query}`, which teddit-api streams from Redlib
(`/raw/media/...`, through Tor) for the Reddit media hosts Redlib proxies:
`i.redd.it`, `v.redd.it`, `preview.redd.it`, `external-preview.redd.it`,
`{a,b}.thumbs.redditmedia.com`, `emoji.redditmedia.com`, `styles.redditmedia.com`,
`www.redditstatic.com`. Other hosts Teddit accepted (`i.imgur.com`, `i.ytimg.com`,
`thumbs.gfycat.com`) are returned as their original absolute URLs.

`/media/` is not behind Redlib's fingerprint gate. Range requests are passed through.

Teddit-era media URLs still work as redirects to `/media/`:
`/pics/w:null_{file}` → `i.redd.it/{file}`, `/vids/{id}.mp4` → the HLS playlist,
`/{file}?teddit_proxy={host}` → `{host}/{file}`.

### Media in `target=reddit` output (extension)

Teddit returned Reddit's JSON untouched, so clients such as Stealth loaded media straight
from Reddit's CDNs. Here every Reddit media URL in that JSON (whole values such as
`preview…url`, `media_metadata…u`, `reddit_video.fallback_url`, icons, flair emoji, and
links inside `body_html` / `selftext_html` / `body`) is rewritten to
`<PUBLIC_BASE_URL>/media/<host>/...`, so the client talks only to this instance.
Untouched: the `domain` and `permalink` fields and links to other hosts (reddit.com,
imgur, redgifs, streamable, youtube), which clients use for type detection and in-app
link handling. Set `RAW_MEDIA_PROXY=off` for Teddit's original behaviour.

Reddit's newer videos are `CMAF_<h>.mp4` with audio in `CMAF_AUDIO_<kbps>.mp4`. Clients
built for the older `DASH_<h>` naming (Stealth derives `DASH_AUDIO_128` from the video
URL) would play them silently, so CMAF video URLs are exposed as
`/media/v.redd.it/<id>/cmaf/DASH_<h>.mp4`; `/media/` maps `cmaf/DASH_*` back to `CMAF_*`
and falls back from `AUDIO_128` to `AUDIO_64`. A video without audio still answers 403,
which Stealth treats as "play without sound".

## Errors

All errors are JSON `{ "error": "<message>", "status": <code> }` with that HTTP status:

| Status | When |
|---|---|
| 400 | Invalid `sort` or `t`, missing `q`. |
| 403 / 404 | Reddit says private / quarantined / gated (403), banned / suspended / not found (404). |
| 429 | Reddit rate limit. `Retry-After` gives the seconds until Reddit's limit resets (30 when unknown). |
| 502 | Redlib unreachable or Reddit failed (network, Tor, a block page). |
| 503 | Redlib is still getting its first token, or the token just expired and is being replaced. `Retry-After: 30`. |
| 5xx | Other upstream Reddit 5xx, passed through. |

## Other endpoints

- `GET /healthz`: `{status, redlib, reddit}`. 200 if Redlib answers; `?deep` also fetches one Reddit listing through Tor.

## Deviations from Teddit

| Teddit | Here | Why |
|---|---|---|
| Errors render the HTML front page (200) or redirect. | JSON errors with the real status. | API clients cannot use HTML. |
| Invalid `sort`/`t` redirect to an HTML page. | 400 JSON. | Same. |
| `/user/{u}` redirects to `/u/{u}` and drops `api`. | Served directly. | The redirect broke the API. |
| `/search?q=` redirects to `/r/all/search` and drops `api`. | Served as `/r/all/search`. | Same. |
| No `/comments/{id}` route. | Served. | Shortlinks without subreddit. |
| Media downloaded to disk; videos merged with audio by ffmpeg. | Streamed via `/media/`; `v.redd.it` fallback MP4s have no audio track. | No disk cache; Redlib proxies media. Clients wanting audio can use `/media/v.redd.it/{id}/HLSPlaylist.m3u8`. |
| Redis cache (10 min listings). | Redlib's 30 s JSON cache. | One cache, upstream. |
| `/r/random` | 404 JSON. | Reddit removed it. |
| `raw` param does not exist. | `raw=true` = `target=reddit`. | Convenience alias. |
| `target=reddit` media URLs point at Reddit's CDNs. | Point at `/media/` (unless `RAW_MEDIA_PROXY=off`); CMAF videos get a `cmaf/DASH_*` alias. | Full proxying; sound in DASH-only clients. |
| `limit` ignored on listings. | Forwarded on front page, subreddit and search. | Harmless extension; Teddit's processors handle any length. |
| Sets preference cookies when overrides are passed. | No cookies set. | Shares the domain with Redlib. |
| Morechildren (`POST`), wiki, saved, subscriptions, gallery/poll pages. | Not provided; `cursor` on post routes continues threads instead. | Not part of Teddit's API; Reddit blocks `/api/morechildren` for anonymous clients. |
| No user search. | `/users/search` with `target=reddit`. | Clients like Stealth search users. |
