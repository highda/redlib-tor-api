# redlib-tor-api

A maintained fork of [Redlib](https://github.com/redlib-org/redlib) that reaches Reddit
through Tor and adds a [Teddit](https://codeberg.org/teddit/teddit)-compatible API, so
apps that speak Teddit's API (for example the Android clients
[Stealth](https://gitlab.com/cosmosapps/stealth) and
[Stealth-Continued](https://github.com/highda/stealth-continued)) can use a Redlib instance.

It is three things on top of upstream Redlib, plus fixes picked from other forks
([Picked fixes](#picked-fixes)):

1. **baalajimaestro's Tor fork**, one commit taken as is from
   [git.ptr.moe/baalajimaestro/redlib](https://git.ptr.moe/baalajimaestro/redlib):
   Reddit's onion addresses, a browser fingerprint gate, DASH/CMAF video.
2. **A small `/raw` route** in Redlib (`src/raw.rs`, plus 4 lines elsewhere). It hands
   Reddit's JSON and media to the API container. Off unless `REDLIB_RAW_TOKEN` is set.
3. **`teddit-api`**, a separate container (`fork/teddit-api`) that serves Teddit's API
   using Teddit's own processing code, fed through Redlib's `/raw`.

Everything this fork adds lives in `fork/` and `.github/workflows/redlib-tor-api-release.yml`;
the rest of the tree is upstream Redlib (plus the Tor commit and the picked fixes), so
syncing stays cheap.

## Architecture

```
                 ┌──▶ redlib:8080       web UI ──────────────┐
 your reverse ───┤                                            ├──▶ tor ──▶ Reddit (onion)
 proxy           └──▶ teddit-api:3000   ?api, /media/ ──▶ redlib /raw (token)
```

- **redlib** (`ghcr.io/highda/redlib-tor-api`): upstream Redlib + the Tor commit + `/raw`.
  Without `REDLIB_RAW_TOKEN` it behaves exactly like baalajimaestro's image.
- **teddit-api** (`ghcr.io/highda/redlib-tor-api-teddit`): the API. Node 22, no npm
  dependencies, about 50 MB.
- **tor**: any Tor SOCKS proxy. The examples use `osminogin/tor-simple`.

`REDLIB_RAW_TOKEN` is a shared secret between redlib and teddit-api only: any random
string, set to the same value in both. API clients never see it and never need it.

## Run it

1. Copy `fork/deploy/compose.example.yaml` to your server, set `PUBLIC_BASE_URL`, and put
   `REDLIB_RAW_TOKEN=$(openssl rand -hex 32)` into a `.env` next to it.
2. `docker compose up -d`. The first start takes a few minutes: Tor has to reach Reddit's
   onion before Redlib starts.
3. Connect your reverse proxy to the `redlib-tor-api` network and route as below.

redlib and teddit-api sit only on an internal network, so they cannot reach the internet
except through Tor. If Tor is down, they fail rather than leak.

`fork/deploy/compose.yaml` is the same stack built from source, with Caddy in front; it
is what `fork/scripts/check.sh` and local development use.

### Routing

| Request | Goes to |
|---|---|
| query has an `api` key (`?api`, `?api=1`, `…&api&…`) | `teddit-api:3000` |
| path starts with `/media/` | `teddit-api:3000` |
| `/pics/*`, `/vids/*`, query has `teddit_proxy` (old Teddit links) | `teddit-api:3000` |
| path `/raw` or `/raw/*` | **block** (404) |
| everything else | `redlib:8080` |

One hostname split like this is what Teddit apps expect. You can also give the API its
own hostname; then send all of it to `teddit-api` and set `PUBLIC_BASE_URL` to that host.

Caddy (as in `fork/deploy/Caddyfile`):

```caddyfile
reddit.example.org {
	@raw path_regexp ^/+raw(/|$)
	respond @raw 404
	@api expression `{http.request.uri.query}.matches("(^|&)api(=|&|$)")`
	@media path /media/* /pics/* /vids/*
	@teddit_proxy query teddit_proxy=*
	handle @api { reverse_proxy teddit-api:3000 }
	handle @media { reverse_proxy teddit-api:3000 }
	handle @teddit_proxy { reverse_proxy teddit-api:3000 }
	handle { reverse_proxy redlib:8080 }
}
```

nginx (names resolved at request time, so nginx still starts while a container is down;
`proxy_pass` with a variable also forwards the URI and query untouched, which Reddit's
signed image URLs need):

```nginx
server {
    # listen / server_name / TLS as usual
    resolver 127.0.0.11 valid=30s;   # Docker's DNS
    set $redlib http://redlib:8080;
    set $teddit http://teddit-api:3000;
    location ~ ^/+raw(/|$) { return 404; }
    location ~ ^/(media|pics|vids)/ { proxy_pass $teddit; }
    location / {
        set $upstream $redlib;
        if ($args ~ "(^|&)(api|teddit_proxy)(=|&|$)") { set $upstream $teddit; }
        proxy_pass $upstream;
    }
}
```

Nginx Proxy Manager: create the proxy host with forward host `redlib`, port `8080`, and
put this into its **Advanced** tab (NPM builds `location /` itself from `$server`/`$port`,
so the snippet switches those instead of adding another `location /`):

```nginx
location ~ ^/+raw(/|$) { return 404; }
location ~ ^/(media|pics|vids)/ { proxy_pass http://$server:$port$request_uri; set $server "teddit-api"; set $port 3000; }
if ($args ~ "(^|&)(api|teddit_proxy)(=|&|$)") { set $server "teddit-api"; set $port 3000; }
```

Both were tested with `fork/scripts/smoke.sh` (every API route, `/raw` blocked, web UI).

## Protecting the endpoint is the server admin's job

The API is public by design: Teddit's API had no authentication and the apps that use
it cannot send any. Anyone who knows the address can use your instance, and every
request costs you Tor bandwidth and Reddit rate limit. This project does not decide
who may use it. If that matters to you, do it in front of the containers, for example:

- reach the instance only over a VPN (WireGuard, Tailscale) or from known IP ranges,
- geo-restrict or rate-limit in your reverse proxy,
- keep the hostname unlisted (obscurity, not protection).

Bot walls such as Anubis or go-away must **exempt API and media requests** (the routing
table's teddit-api rows). Apps cannot solve their challenges, and some of them rewrite
query strings, which breaks Reddit's signed image URLs (`?…&s=…`): Reddit answers 403
when the parameters are reordered. The same applies to Redlib's own media paths
(`/preview/`, `/img/`, `/vid/`, `/hls/`, …).

`REDLIB_FINGERPRINTING=on` puts Redlib's web UI behind a browser check; it never applies
to `/raw`, so the API and `/media/` keep working.

## Stealth

Stealth (Settings → Reddit Source → Teddit) stores only a hostname and always calls
`https://<host>/`. So the instance must be served over HTTPS on port 443 at the root of
its hostname, with a publicly trusted certificate, and without HTTP authentication
(Stealth drops `user:pass@` from the address).

Stealth asks for Reddit's raw JSON (`target=reddit`). teddit-api rewrites every Reddit
media URL in it to `/media/`, so the phone never contacts Reddit's servers, and gives
Reddit's newer CMAF videos a name Stealth recognises, so they play with sound. Links to
other sites (imgur, redgifs, YouTube, …) are loaded by Stealth itself. Set
`RAW_MEDIA_PROXY=off` for Teddit's original behaviour.

Stealth 2.3.1 sends post search, user search and "load more comments" to reddit.com even
in Teddit mode: that is Stealth, not the instance.

### Stealth-Continued

[Stealth-Continued](https://github.com/highda/stealth-continued) is a fork of Stealth made
for this API. It talks only to the instance (post search, user lookup and "load more
comments" included), takes any address (`https://host:port`, or plain HTTP on a trusted
network), supports HTTP Basic authentication in front of the instance, and works around
the limitations below.

## Known limitations

- `/r/a+b` (several subreddits at once) answers with r/popular: `/raw` passes the `+` to
  Reddit unencoded, and Reddit reads it as a space. Stealth-Continued uses a search
  restricted to those subreddits instead.
- `/raw` does not forward `/api/morechildren`, so "load more comments" has to fetch comment
  permalinks; there is no user search route.
- Reddit blocks anonymous API clients more each month. Since 2026-10-22 its onion API
  answers any path ending in `.json` with a 403, so the client sends those paths without
  the suffix (Reddit still returns JSON), and the comments JSON is blocked in every form,
  so post pages and `/raw` threads come from Reddit's GraphQL API (`gql-fed` on the same
  onion, upstream PR #603). If Reddit changes the persisted query hash, comments break
  until `src/gql.rs` is updated.
- Reddit's media onion (i/v/preview.redd.it) can stop answering while the API onion keeps
  working: listings load, every image times out. The examples' Tor healthcheck reports it
  as unhealthy and a Tor restart fixes it; Docker does not restart unhealthy containers by
  itself, so pair it with a watchdog.

## API

`fork/teddit-api/API_SURFACE.md` lists every route, parameter, default and output, and
every place where this API deliberately differs from Teddit. In short: append `?api` to a
normal Redlib/Reddit URL; `type=rss` for RSS; `target=reddit` (or `raw=true`) for
Reddit's own JSON.

## Configuration

Redlib takes all of upstream's `REDLIB_*` settings, plus:

| Variable | Container | Meaning |
|---|---|---|
| `ALL_PROXY` | redlib | Tor SOCKS, e.g. `socks5h://tor:9050` |
| `REDLIB_USE_REDDIT_ONION` | redlib | `on`: Reddit's onion addresses |
| `REDLIB_RAW_TOKEN` | redlib, teddit-api | shared secret for `/raw`; unset = `/raw` disabled |
| `REDLIB_FINGERPRINTING`, `REDLIB_FINGERPRINT_SECRET`, `…_MAX_AGE_SECONDS`, `…_SCORE_THRESHOLD`, `…_BLOCKLIST` | redlib | browser gate for the web UI |
| `REDLIB_URL` | teddit-api | where Redlib is, e.g. `http://redlib:8080` |
| `PUBLIC_BASE_URL` | teddit-api | the public origin clients use (builds links and `/media/` URLs) |
| `RAW_MEDIA_PROXY` | teddit-api | `on` (default) / `off`, see Stealth |
| `NSFW_ENABLED` | teddit-api | Teddit's instance-wide NSFW default (`true`) |

Onion mode needs a warm Tor circuit at startup: Redlib's OAuth bootstrap gives up after
5 seconds per attempt, a cold onion connection takes 20 to 45. The examples' Tor
healthcheck fetches Reddit's onion every 30 seconds and Redlib waits for it; keep both
if you bring your own Tor, and share circuits across clients (`SocksPort … NoIsolateClientAddr`).

## Source offer (AGPL)

Redlib, the Tor commit and Teddit are AGPL-3.0, and so is this fork. If you run it for
others, tell them where the source is. Redlib's footer links to upstream Redlib, so add
a link to this repository (and the tag you run), for example with
`REDLIB_BANNER="Source: https://github.com/highda/redlib-tor-api"`. Credits:
`fork/THIRD_PARTY.md`.

## Development

```bash
fork/scripts/check.sh                     # what CI runs: cargo test, npm test, offline stack + smoke
fork/scripts/smoke.sh <base_url>          # every API route against a running stack
fork/scripts/smoke.sh --gated <base_url>  # same, with REDLIB_FINGERPRINTING=on
REDLIB_RAW_TOKEN=… fork/scripts/record-fixtures.sh http://127.0.0.1:8080   # re-record from live Reddit
```

`check.sh` never contacts Reddit: the API tests replay recorded fixtures, and a
differential test runs every case through an untouched Teddit checkout and requires
identical output. Upstream Redlib's own tests that need live Reddit are skipped there.

## Releases

Publishing a GitHub release (tag `v<upstream-version>-tor.<n>`, e.g. `v0.36.0-tor.1`)
runs `check.sh` and pushes both images to GHCR with that tag. A full release also moves
`latest`; a pre-release does not. arm64 images: run the workflow by hand with the arm64
option.

Roll back by pinning an older tag (`REDLIB_TOR_API_TAG=v0.36.0-tor.1` in the example).

## Keeping up with upstream

```bash
fork/scripts/sync-upstream.sh --report   # how far upstream and the Tor fork have moved
fork/scripts/sync-upstream.sh            # merge upstream/main (never rebase)
fork/scripts/check.sh
git push && # then publish a release
```

The script keeps upstream's workflow files deleted (the Tor commit removed them; this
fork runs only its own workflow) and stops with a list of files on any other conflict.

Before merging, check the [picked fixes](#picked-fixes) against what upstream merged: when
upstream takes one of them (the `(cherry picked from commit …)` line names the source),
resolve that conflict in upstream's favour and drop its row from the table.

### When baalajimaestro updates

His work is one squashed commit (`YUNYUN_COMMIT` in `fork/upstream.env`). If his branch
gains new commits on top of it, cherry-pick them (`git cherry-pick -x <sha>`), keeping him
as author. If he rewrites the squash instead, apply the difference between his old and
new commit as one commit authored by him, update `YUNYUN_COMMIT`, run `check.sh`.

## Picked fixes

Fixes taken from other forks and from unmerged upstream pull requests. Each commit keeps its
author; the line `(cherry picked from commit <sha> in <source>)` names where it came from,
and `[highda: …]` above it says what was changed to make it fit. Fixes that only matter
behind a clearnet IP (session cookies, headless browsers) are left out on purpose.

| Fix | Author | Source |
|---|---|---|
| A blocked response says it was blocked, not "Failed to parse page JSON data" | cute-johnny | [Nachtalb/redlib](https://github.com/Nachtalb/redlib) `1e9515e` |
| `REDLIB_DEFAULT_POST_SORT` applies before settings are saved | Sparronator9999 | [redlib-org#521](https://github.com/redlib-org/redlib/pull/521) |
| …and falls back to `hot` when it is unset | polak14 | [polak14/redlib](https://github.com/polak14/redlib) `19c6606` |
| `/u/<name>/s/<id>` share links | Butter Cat | [redlib-org#560](https://github.com/redlib-org/redlib/pull/560) |
| `/commits.atom` and `/instances.json` serve the cached copy when GitHub fails | Nachtalb | [Nachtalb/redlib](https://github.com/Nachtalb/redlib) `fa54e66` (port of redlib-org#396) |
| RSS: `REDLIB_ENABLE_RSS=off` really turns feeds off; r/popular and r/all feeds; no double-decoded entities | VictorVow | [Nachtalb/redlib](https://github.com/Nachtalb/redlib) `d0261dc`, `54b93b6`, `b875c64` |
| `geo_filter` survives r/popular pagination | Sean | [redlib-org#596](https://github.com/redlib-org/redlib/pull/596) |
| Pausing an HLS video while it loads sticks | Nachtalb | [Nachtalb/redlib](https://github.com/Nachtalb/redlib) `4487817` |
| No panic on a malformed comment `parent_id` | Liam Newman | [mrnamwen/redlib](https://github.com/mrnamwen/redlib) `077ba8b` |
| Onion API paths drop the `.json` suffix Reddit now rejects | LucifersCircle | [LucifersCircle/redlib](https://github.com/LucifersCircle/redlib) `d601f9a` |
| Redirects only go to same-site paths (open redirect, HTML injection) | SpikeHD | [SpikeHD/redlib-ex](https://github.com/SpikeHD/redlib-ex) `b740ef5` |
| A failed background token refresh keeps the token and backs off instead of exiting | Mitch Ross | [mitchross/redlib](https://github.com/mitchross/redlib) `494a7c4`, `39aed9f` |
| Post comments through Reddit's GraphQL API | trqwenyy, polak14 | [redlib-org#603](https://github.com/redlib-org/redlib/pull/603) |
| Onion authentication gets 90 s to build a circuit | baalajimaestro | [baalajimaestro/redlib](https://git.ptr.moe/baalajimaestro/redlib) `a86b3e0`, `src/oauth.rs` only |

baalajimaestro's `a86b3e0` also restores comments, by scraping Reddit's Shreddit HTML
fragments (about 1,000 lines plus the `scraper` crate). This fork uses the GraphQL route
instead: it is smaller, returns the JSON shape `/raw` already passes through, and passed
the live smoke test. If GraphQL breaks, his scraper is the fallback to port.

This fork's own follow-ups: an HTML 404 is reported as not found, GraphQL goes to the
onion, and `/raw` serves threads through GraphQL.
