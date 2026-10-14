#!/usr/bin/env bash
# Records /raw fixtures from a live Redlib (through Tor), sanitises them and
# regenerates the golden outputs.
#
#   REDLIB_RAW_TOKEN=... fork/scripts/record-fixtures.sh [redlib_url]
#
# redlib_url defaults to http://127.0.0.1:8080 and must reach Redlib directly
# (not through Caddy, which blocks /raw). Review the fixture diff before committing.
set -euo pipefail

REDLIB_URL="${1:-http://127.0.0.1:8080}"
: "${REDLIB_RAW_TOKEN:?set REDLIB_RAW_TOKEN to the token Redlib was started with}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/fork/teddit-api"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Recording from $REDLIB_URL ..."
RECORD_FIXTURES_DIR="$TMP/raw" REDLIB_RAW_TOKEN="$REDLIB_RAW_TOKEN" \
  node "$APP/test/helpers/run-cases.js" --redlib "$REDLIB_URL" --out "$TMP/live.json"

# Every case except the deliberate error cases must have succeeded live.
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const bad = Object.entries(r).filter(([n, v]) => !n.startsWith("error_") && v.status !== 200);
  for (const [n, v] of bad) console.error(`  ${n}: HTTP ${v.status} ${v.body.slice(0, 200)}`);
  if (bad.length) { console.error("Live recording had failures; fixtures not updated."); process.exit(1); }
' "$TMP/live.json"

node "$APP/test/helpers/sanitize-fixtures.js" "$TMP/raw" "$APP/test/fixtures"
node "$APP/test/helpers/run-cases.js" --update-goldens
echo "Fixtures and goldens updated. Run: (cd fork/teddit-api && npm test)"
