#!/usr/bin/env bash
# Smoke test of a running stack through Caddy: every Teddit API route (JSON and
# RSS), raw passthrough, pagination, media, error cases, the /raw block and
# (unless --offline) Redlib's HTML.
#
#   fork/scripts/smoke.sh [--offline|--gated] <base_url>
#
# --gated: Redlib runs with REDLIB_FINGERPRINTING=on, so its HTML must answer
# curl with the gate's empty response while the API stays reachable.
#
# URLs match test/cases.json so the offline stack (fixture mock) can answer
# them too. Prints a summary table; exits non-zero if anything failed.
set -uo pipefail

OFFLINE=0
GATED=0
if [[ "${1:-}" == "--offline" ]]; then OFFLINE=1; shift; fi
if [[ "${1:-}" == "--gated" ]]; then GATED=1; shift; fi
BASE="${1:?usage: smoke.sh [--offline|--gated] <base_url>}"
BASE="${BASE%/}"
TIMEOUT="${SMOKE_TIMEOUT:-120}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
ROWS=()

# check NAME PATH STATUS CTYPE_REGEX [JQ_FILTER_OR_GREP]
#   A filter starting with "grep:" is a grep -E pattern on the body, "empty"
#   requires an empty body; otherwise a jq expression that must print "true".
check() {
  local name="$1" path="$2" want_status="$3" want_ctype="$4" filter="${5:-}"
  local out="$TMP/body" meta status ctype ms ok=1 why="" note=""
  meta="$(curl -s -o "$out" --max-time "$TIMEOUT" -w '%{http_code} %{time_total} %{content_type}' "$BASE$path")"
  status="${meta%% *}"
  # Reddit (especially through Tor) has transient 5xx; retry once and say so.
  if [[ "$status" =~ ^5 && ! "$want_status" =~ ^5 ]]; then
    note="(retried after $status) "
    meta="$(curl -s -o "$out" --max-time "$TIMEOUT" -w '%{http_code} %{time_total} %{content_type}' "$BASE$path")"
    status="${meta%% *}"
  fi
  ms="$(awk -v t="$(echo "$meta" | cut -d' ' -f2)" 'BEGIN{printf "%d", t*1000}')"
  ctype="$(echo "$meta" | cut -d' ' -f3-)"
  if [[ "$status" != "$want_status" ]]; then ok=0; why="status $status"; fi
  if (( ok )) && [[ -n "$want_ctype" ]] && ! [[ "$ctype" =~ $want_ctype ]]; then ok=0; why="type '$ctype'"; fi
  if (( ok )) && [[ -n "$filter" ]]; then
    if [[ "$filter" == empty ]]; then
      [[ ! -s "$out" ]] || { ok=0; why="body not empty"; }
    elif [[ "$filter" == grep:* ]]; then
      grep -Eq "${filter#grep:}" "$out" || { ok=0; why="body !~ ${filter#grep:}"; }
    else
      [[ "$(jq -r "$filter" "$out" 2>/dev/null)" == "true" ]] || { ok=0; why="jq: $filter"; }
    fi
  fi
  if (( ok )); then PASS=$((PASS + 1)); ROWS+=("PASS|$name|$status|${ms}ms|$note"); else FAIL=$((FAIL + 1)); ROWS+=("FAIL|$name|$status|${ms}ms|$note$why"); fi
  cp "$out" "$TMP/last_$name" 2>/dev/null
}

J='application/json'
R='application/rss\+xml'
POST='/r/AskReddit/comments/1x3uinu/what_previously_glorified_careers_are_struggling/'
ST='&target=reddit&raw_json=1'

# Front page and subreddit listings
check frontpage_json         '/?api'                                 200 "$J" '(.links | length) > 0'
check frontpage_rss          '/?api&type=rss'                        200 "$R" 'grep:<item>'
check frontpage_top_week     '/top?api&t=week'                       200 "$J" '(.links | length) > 0'
check sub_json               '/r/pics?api'                           200 "$J" '(.links | length) > 0 and (.info.after | type) == "string"'
check sub_rss                '/r/pics?api&type=rss'                  200 "$R" 'grep:<title>/r/pics</title>'
check sub_light              '/r/rust/new?api&mode=light'            200 "$J" '[.links[].selftext_html] | all(. == null)'
check sub_target_reddit      '/r/rust/new?api&target=reddit'         200 "$J" '.kind == "Listing"'
check sub_raw_alias          '/r/rust/new?api&raw=true'              200 "$J" '.kind == "Listing"'
check sub_nsfw_hidden        '/r/AskRedditAfterDark?api&limit=5&nsfw_enabled=false' 200 "$J" '(.links | length) == 0'

# Pagination: page 2 starts after page 1's cursor and differs from it.
AFTER="$(jq -r '.info.after // empty' "$TMP/last_sub_json" 2>/dev/null)"
FIRST="$(jq -r '.links[0].id // empty' "$TMP/last_sub_json" 2>/dev/null)"
check sub_page2 "/r/pics?api&after=$AFTER" 200 "$J" "(.links | length) > 0 and .links[0].id != \"$FIRST\""

# Subreddit about, search, discovery
check about                  '/r/rust/about?api'                     200 "$J" '(.subscribers | type) == "number"'
check sub_search_json        '/r/rust/search?api&q=async&restrict_sr=on' 200 "$J" '(.posts | length) > 0'
check sub_search_rss         '/r/rust/search?api&q=async&restrict_sr=on&type=rss' 200 "$R" 'grep:<item>'
check search_all             '/search?api&q=rust'                    200 "$J" '(.posts | length) > 0'
check subreddits_search      '/subreddits/search?api&q=linux'        200 "$J" '(.links | length) > 0'
check subreddits_search_rss  '/subreddits/search?api&q=linux&type=rss' 200 "$R" 'grep:<item>'

# Posts
check post_json              "$POST?api"                             200 "$J" '(.comments | length) > 0 and (.title | length) > 0'
check post_rss               "$POST?api&type=rss"                    200 "$R" 'grep:<item>'
check post_gallery           '/r/MechanicalKeyboards/comments/1x5fyx1/the_most_beautiful_keyboard_ever/?api' 200 "$J" '.gallery == true and (.gallery_items | length) > 0'
check post_short             '/comments/1x5fyx1?api'                 200 "$J" '.id == "1x5fyx1"'

# Users
check user_json              '/u/spez?api'                           200 "$J" '.username == "spez" and (.posts | length) > 0'
check user_rss               '/u/spez?api&type=rss'                  200 "$R" 'grep:<item>'
check user_submitted         '/user/spez/submitted?api'              200 "$J" '(.posts | length) > 0'
check user_comments          '/u/spez/comments?api'                  200 "$J" '(.posts | length) > 0'

# Exactly what the Stealth Android client sends
check stealth_sub            "/r/rust/hot?api$ST"                    200 "$J" '.kind == "Listing" and (.data.children | length) > 0'
check stealth_sub_top        "/r/rust/top?api&t=week$ST"             200 "$J" '.kind == "Listing"'
check stealth_about          "/r/rust/about?api$ST"                  200 "$J" '.kind == "t5"'
check stealth_search         "/r/rust/search?api&restrict_sr=on&nsfw=on&q=async&sort=relevance$ST" 200 "$J" '.kind == "Listing"'
check stealth_post           "$POST?api&sort=confidence$ST"          200 "$J" '(. | length) == 2 and .[0].kind == "Listing"'
check stealth_user_posts     "/u/spez/submitted?api&sort=hot$ST"     200 "$J" '.about.kind == "t2" and .overview.kind == "Listing"'
check stealth_user_comments  "/u/spez/comments?api&sort=new$ST"      200 "$J" '.overview.kind == "Listing"'
check stealth_subreddits     "/subreddits/search?api&nsfw=on&q=linux$ST" 200 "$J" '.kind == "Listing"'

# Media through teddit-api (not behind Redlib's fingerprint gate)
THUMB="$(jq -r '[.links[].images.thumb // empty | select(startswith("http"))][0] // empty' "$TMP/last_sub_json" 2>/dev/null)"
check media_thumb "/${THUMB#*://*/}" 200 '^image/'

# Errors
check error_bad_sort         '/r/rust/sideways?api'                  400 "$J" '.status == 400'
check error_missing_sub      '/r/thissubdoesnotexist12345xyz?api'    404 "$J" '.status == 404'

# /raw must never be reachable from outside
check raw_blocked            '/raw/r/rust/hot.json'                  404 ''
check raw_blocked_slashes    '//raw/r/rust/hot.json'                 404 ''
check raw_media_blocked      '/raw/media/i.redd.it/x.jpg'            404 ''

# Live Reddit only (the offline fixtures predate these): several subreddits at once,
# user search, and thread continuation through a "more" stub's cursor
if (( ! OFFLINE )); then
  check stealth_multi_sub    "/r/rust+linux/new?api$ST"              200 "$J" '[.data.children[].data.subreddit | ascii_downcase] | unique == ["linux", "rust"]'
  check stealth_user_search  "/users/search?api&q=spez$ST"           200 "$J" '[.data.children[].data.name] | index("spez") != null'
  MORE="$(jq -r '.[1].data.children[-1] | select(.kind == "more") | .data.id' "$TMP/last_stealth_post" 2>/dev/null)"
  check stealth_post_more    "$POST?api&cursor=$MORE$ST"             200 "$J" '(.[1].data.children | length) > 0 and .[1].data.children[0].kind == "t1"'
fi

# Redlib HTML (needs the real Redlib, so skipped offline)
if (( GATED )); then
  check redlib_html_gated    '/r/rust'                               200 '' empty
  check redlib_media_gated   '/img/x.jpg'                            200 ''
elif (( ! OFFLINE )); then
  check redlib_html          '/r/rust'                               200 '^text/html'
  check redlib_settings      '/settings'                             200 '^text/html'
fi
if (( ! OFFLINE )); then
  # After the checks above, most requests to Reddit got through
  check reddit_health        '/healthz/reddit'                       200 '^text/plain' 'grep:^ok: last [0-9]+ Reddit requests'
fi

printf '\n%-5s  %-24s  %-6s  %-8s  %s\n' RESULT CHECK STATUS TIME DETAIL
for row in "${ROWS[@]}"; do
  IFS='|' read -r r n s t w <<<"$row"
  printf '%-5s  %-24s  %-6s  %-8s  %s\n' "$r" "$n" "$s" "$t" "$w"
done
printf '\n%d passed, %d failed (%s)\n' "$PASS" "$FAIL" "$BASE"
(( FAIL == 0 ))
