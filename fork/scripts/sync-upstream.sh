#!/usr/bin/env bash
# Brings upstream Redlib's main into this fork's main (merge, no rebase, so
# published tags stay valid) and reports whether baalajimaestro's Tor fork has
# moved since the commit we carry.
#
#   fork/scripts/sync-upstream.sh            # fetch, report, merge upstream/main
#   fork/scripts/sync-upstream.sh --report   # fetch and report only
#
# Then: fork/scripts/check.sh → push → publish a release.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/fork/upstream.env"
git() { command git -C "$ROOT" "$@"; }

REPORT_ONLY=0
[[ "${1:-}" == "--report" ]] && REPORT_ONLY=1

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "Run this on main." >&2; exit 1; }

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_REPO"
git remote get-url yunyun >/dev/null 2>&1 || git remote add yunyun "$YUNYUN_REPO"
git fetch --quiet upstream
if ! git fetch --quiet yunyun 2>/dev/null; then
  echo "warning: could not fetch $YUNYUN_REPO (unreachable?); skipping the Tor fork report" >&2
fi

base="$(git merge-base HEAD upstream/main)"
behind="$(git rev-list --count HEAD..upstream/main)"
echo "upstream/main: $behind new commit(s) since $(git log -1 --format='%h %cs' "$base")"
git log --oneline --no-merges -n 20 HEAD..upstream/main | sed 's/^/  /'

if git rev-parse --verify --quiet yunyun/main >/dev/null; then
  if git merge-base --is-ancestor "$YUNYUN_COMMIT" yunyun/main 2>/dev/null; then
    moved="$(git rev-list --count "$YUNYUN_COMMIT"..yunyun/main)"
    echo "yunyun/main: $moved commit(s) after the Tor commit we carry (${YUNYUN_COMMIT:0:7})"
    git log --oneline -n 20 "$YUNYUN_COMMIT"..yunyun/main | sed 's/^/  /'
    [[ "$moved" == "0" ]] || echo "  → see fork/README.md, 'When baalajimaestro updates', before importing."
  else
    echo "yunyun/main no longer contains ${YUNYUN_COMMIT:0:7} (history rewritten). Compare by hand:"
    git log --oneline -n 5 yunyun/main | sed 's/^/  /'
  fi
fi

(( REPORT_ONLY )) && exit 0
if [[ "$behind" == "0" ]]; then
  echo "Already up to date with upstream."
  exit 0
fi

if git merge --no-ff --no-edit -m "Merge upstream redlib-org/redlib main" upstream/main; then
  echo "Merged. Next: fork/scripts/check.sh, then push and publish a release."
  exit 0
fi

# baalajimaestro's commit deletes upstream's workflows; if upstream edits them,
# keep them deleted (this fork only runs its own workflow).
for f in $(git diff --name-only --diff-filter=U); do
  if [[ "$f" == .github/workflows/* && "$f" != .github/workflows/redlib-tor-api-* ]]; then
    git rm --quiet "$f"
    echo "kept upstream workflow deleted: $f"
  fi
done

conflicts="$(git diff --name-only --diff-filter=U)"
if [[ -z "$conflicts" ]]; then
  git commit --quiet --no-edit
  echo "Merged (upstream workflow edits dropped). Next: fork/scripts/check.sh, push, release."
  exit 0
fi

echo "Merge stopped on conflicts. Resolve these, then 'git commit':" >&2
echo "$conflicts" | sed 's/^/  /' >&2
echo "Or abort with: git merge --abort" >&2
exit 1
