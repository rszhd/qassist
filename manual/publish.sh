#!/bin/sh
# One publish attempt for docs.qassist.run (US-070). Fetch, build if the manual
# moved, install into the volume nginx serves.
#
# The loop and the sleep are in docker-compose.docs.yml; this is the body, and
# it is re-read from the clone on every iteration. So improving a publish is a
# commit to `dev` — no container is recreated and no compose file is edited.
#
# Run it by hand to publish without waiting for the poll:
#   docker compose -p qassist-docs exec builder sh /src/manual/publish.sh
set -eu

SRC="${DOCS_SRC_DIR:-/src}"
OUT="${DOCS_OUT_DIR:-/dist}"
BRANCH="${DOCS_BRANCH:-dev}"
# Outside OUT, so nothing nginx serves is a state file of ours. Untracked, so
# `git checkout --force` below leaves it alone.
STAMP="$SRC/.publish-stamp"

cd "$SRC"

# --depth 1: the builder never needs history, and a shallow fetch keeps the
# clone from growing without bound in a volume production shares a disk with.
git fetch --quiet --depth 1 origin "$BRANCH"

# The *tree* hash of manual/, not the commit. This is what makes "a push
# touching nothing under manual/ rebuilds nothing" exact rather than a diff
# against a parent the shallow clone may not have.
tree=$(git rev-parse "FETCH_HEAD:manual")

if [ "$tree" = "$(cat "$STAMP" 2>/dev/null || true)" ] && [ -f "$OUT/index.html" ]; then
  exit 0
fi

echo "publishing manual $tree from $BRANCH"
git checkout --quiet --force --detach FETCH_HEAD

cd "$SRC/manual"

# Only when the lockfile actually moved. node_modules lives in the src volume,
# so the usual publish installs nothing at all — which is also the bound on
# disk: the npm cache is dropped after each install rather than accumulating
# beside a production database.
lock=$(git rev-parse "FETCH_HEAD:manual/package-lock.json")
if [ ! -d node_modules ] || [ "$lock" != "$(cat node_modules/.lock-stamp 2>/dev/null || true)" ]; then
  echo "installing dependencies"
  npm ci --no-audit --no-fund
  npm cache clean --force >/dev/null 2>&1 || true
  printf '%s' "$lock" > node_modules/.lock-stamp
fi

npm run build

# --delete so a page removed upstream stops being served, and rsync rather than
# a wipe-and-copy because rsync replaces each file by rename: there is no moment
# where the site is half there. `.publish-stamp` is not under OUT, so nothing
# here can delete it.
rsync -a --delete .vitepress/dist/ "$OUT/"

printf '%s' "$tree" > "$STAMP"
echo "published $(find "$OUT" -name '*.html' | wc -l) pages"
