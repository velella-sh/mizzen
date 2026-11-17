#!/usr/bin/env bash
# Packs Mizzen and Lateen, installs both tarballs into an empty project, builds examples/data-site twice with the
# installed CLI, then checks determinism, URLs, verification, a self-diff, and one MCP data call.
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
npx mizzen diff first first --format json > self-diff.json
node -e '
  const assert = require("node:assert/strict");
  const report = require("./self-diff.json");
  assert.equal(report.identical, true);
  for (const changes of [report.pages, report.files]) {
    for (const entries of Object.values(changes)) assert.deepEqual(entries, []);
  }
  assert.deepEqual(report.brokenUrls, []);
  assert.deepEqual(report.records, []);
'
node <<'JS'
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" },
  } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "get_record", arguments: { collection: "components", id: "button" },
  } },
];
const stdout = execFileSync(process.execPath, ["node_modules/@velella/mizzen/bin/mizzen.js", "mcp", "site"], {
  input: requests.map((message) => JSON.stringify(message)).join("\n") + "\n",
  encoding: "utf8",
  timeout: 60_000,
});
const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
const initialized = replies.find((reply) => reply.id === 1);
assert.equal(initialized?.result?.serverInfo?.version, require("@velella/mizzen/package.json").version);
const answer = replies.find((reply) => reply.id === 2);
assert.ok(answer?.result && !answer.result.isError, JSON.stringify(answer));
const record = JSON.parse(answer.result.content[0].text);
assert.equal(record.id, "button");
assert.equal(record.fields.name, "Button");
assert.equal(record.url, "/catalogue/components/button/");
JS
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
