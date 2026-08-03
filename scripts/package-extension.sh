#!/usr/bin/env bash
# Builds the Chrome Web Store upload for extension/ (US-066).
#
# The store requires manifest.json at the zip root, so this zips from inside
# extension/ rather than from the repo root. Everything there ships except
# the two things a store copy has no use for — the unit tests and the
# side-load README — and the exclusions are a blocklist on purpose: a new
# lib/ file that popup.js imports must ship without anyone remembering to
# add it here.
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json)
out="$PWD/dist/qassist-session-capture-$version.zip"

mkdir -p dist
rm -f "$out"
cd extension
zip -r -q "$out" . -x '*.test.mjs' 'README.md' '.*' '*/.*'

echo "$out"
unzip -l "$out"
