#!/usr/bin/env bash
# Packs Mizzen and Lateen, installs both tarballs into an empty project, builds examples/data-site twice with the
# installed `mizzen` command, and requires the same build hash both times, a clean `urls check`, and a passing `verify`.
# Usage: scripts/smoke-example.sh [mizzen-dir] [lateen-dir]   (defaults: ../mizzen and ../lateen)
set -euo pipefail

mizzen="$(cd "${1:-../mizzen}" && pwd)"
lateen="$(cd "${2:-../lateen}" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir "$work/tar" "$work/project"
(cd "$mizzen" && npm pack --silent --pack-destination "$work/tar" >/dev/null)
(cd "$lateen" && npm pack --silent --pack-destination "$work/tar" >/dev/null)

cd "$work/project"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$work"/tar/velella-mizzen-*.tgz "$work"/tar/velella-lateen-*.tgz preact

cp -R "$mizzen/examples/data-site" site
node -e '
  const fs = require("node:fs");
  const text = fs.readFileSync("site/mizzen.yml", "utf8");
  fs.writeFileSync("site/mizzen.yml", text.replace(/^collections:$/m, "theme:\n  name: \"@velella/lateen\"\ncollections:"));
'

npx mizzen build site --out first
npx mizzen build site --out second
npx mizzen verify first
npx mizzen verify second
npx mizzen urls check site
if ! diff -r first second >/dev/null; then
  echo "smoke: two builds of the example site differ" >&2
  diff -r first second | head -20 >&2
  exit 1
fi
hash_of() { node -p 'require("./" + process.argv[1] + "/.mizzen/manifest.json").build.hash' "$1"; }
test "$(hash_of first)" = "$(hash_of second)"
test -s first/feeds/releases.xml
test -s first/search-facets.json
echo "the example data site builds twice with the same hash: $(hash_of first)"
