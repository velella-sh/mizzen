#!/usr/bin/env bash
# Packs Mizzen and Lateen, installs both tarballs into an empty project, and builds the Lateen docs site with the
# installed `mizzen` command. It proves the published packages work from node_modules, not from a checkout.
# Usage: scripts/smoke-package.sh [mizzen-dir] [lateen-dir]   (defaults: ../mizzen and ../lateen)
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

cp -R "$lateen/site" site
rm -rf site/.mizzen
node -e '
  const fs = require("node:fs");
  const text = fs.readFileSync("site/mizzen.yml", "utf8");
  fs.writeFileSync("site/mizzen.yml", text.replace(/^theme:$/m, "theme:\n  name: \"@velella/lateen\""));
'

npx mizzen build site --out out
test -s out/index.html
mermaid_page=out/components/mermaid/index.html
if grep -q 'class="mermaid-fallback"' "$mermaid_page"; then
  echo "smoke: the Mermaid diagram fell back to text instead of an inline SVG" >&2
  exit 1
fi
if ! grep -q 'class="mermaid-diagram"' "$mermaid_page"; then
  echo "smoke: $mermaid_page has no rendered Mermaid diagram" >&2
  exit 1
fi
echo "packages build the Lateen site from node_modules"

# The data contract types must be importable from the installed package, so a theme can typecheck against them.
cat > contract-check.ts <<'TS'
import type { Collection, DataRecord, LayoutProps, ListProps, RecordProps } from "@velella/mizzen/contracts";
export type Check = [Collection, DataRecord, ListProps, RecordProps, LayoutProps["record"], LayoutProps["list"]];
TS
"$mizzen/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext \
  --target es2023 --allowImportingTsExtensions contract-check.ts
echo "packages expose the data contract types"
