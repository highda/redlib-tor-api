#!/usr/bin/env bash
# The one command to run before any push or release. CI runs exactly this.
#
#   fork/scripts/check.sh            # all stages
#   CHECK_SKIP_COMPOSE=1 ...         # skip the Docker stage (no Docker available)
#
# 1. cargo test, minus upstream tests that need live Reddit
# 2. teddit-api tests (npm test), incl. the differential test against an
#    untouched Teddit checkout at a pinned commit
# 3. offline compose stack (fixture mock instead of Redlib + Tor) + smoke test
#
# Nothing here talks to Reddit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/fork/teddit-api"
DEPLOY="$ROOT/fork/deploy"
TEDDIT_REPO="https://codeberg.org/teddit/teddit"
TEDDIT_SHA="3d5fb4bb92f1a214f4990289a7a6e003d1bb2477"

step() { printf '\n==> %s\n' "$*"; }

# Upstream Redlib tests that fetch from Reddit. They are upstream's, not ours,
# and Reddit rate-limits CI runners, so they are skipped here.
NETWORK_TESTS=(
  client::tests::test_banned_sub
  client::tests::test_default_subscriptions
  client::tests::test_gated_sub
  client::tests::test_localization_popular
  client::tests::test_obfuscated_share_link
  client::tests::test_private_sub
  client::tests::test_rate_limit_check
  oauth::tests::
  subreddit::tests::test_fetching_subreddit
  subreddit::tests::test_gated_and_quarantined
  user::tests::test_fetching_user
  utils::tests::test_fetching_nsfw_subreddit
  utils::tests::test_fetching_subreddit_quarantined
  utils::tests::test_fetching_ws
)

step "cargo test (offline subset)"
SKIPS=()
for t in "${NETWORK_TESTS[@]}"; do SKIPS+=(--skip "$t"); done
(cd "$ROOT" && cargo test --locked -- "${SKIPS[@]}")

step "teddit-api: reference Teddit checkout"
if [[ -z "${TEDDIT_REF_DIR:-}" ]]; then
  if [[ -f "$ROOT/../refs/teddit/inc/processJsonPost.js" ]]; then
    TEDDIT_REF_DIR="$ROOT/../refs/teddit"
  else
    TEDDIT_REF_DIR="$APP/.teddit-ref"
    if [[ ! -d "$TEDDIT_REF_DIR/.git" ]]; then
      git clone --quiet "$TEDDIT_REPO" "$TEDDIT_REF_DIR"
    fi
    git -C "$TEDDIT_REF_DIR" -c advice.detachedHead=false checkout --quiet "$TEDDIT_SHA"
  fi
fi
export TEDDIT_REF_DIR
echo "using $TEDDIT_REF_DIR"

step "teddit-api: npm test"
(cd "$APP" && npm test)

if [[ "${CHECK_SKIP_COMPOSE:-0}" == "1" ]]; then
  step "compose stage skipped (CHECK_SKIP_COMPOSE=1)"
  exit 0
fi

step "offline compose stack + smoke"
TMP="$(mktemp -d)"
PORT="${CHECK_PORT:-18080}"
cat >"$TMP/check.env" <<EOF
REDLIB_RAW_TOKEN=$(openssl rand -hex 16)
PUBLIC_BASE_URL=http://127.0.0.1:$PORT
PUBLIC_BIND=127.0.0.1
PUBLIC_PORT=$PORT
SITE_ADDRESS=:8080
EOF
COMPOSE=(docker compose -p redlib-tor-api-check --env-file "$TMP/check.env" -f "$DEPLOY/compose.yaml" -f "$DEPLOY/compose.test.yaml")
cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"${COMPOSE[@]}" up -d --build --wait --wait-timeout 180
if ! "$ROOT/fork/scripts/smoke.sh" --offline "http://127.0.0.1:$PORT"; then
  "${COMPOSE[@]}" logs --tail 50
  exit 1
fi

step "all checks passed"
