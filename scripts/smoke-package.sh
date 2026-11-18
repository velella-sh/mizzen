#!/usr/bin/env bash
# Packs Mizzen and Lateen, installs both tarballs into an empty project, and builds the Lateen docs site with the
# installed `mizzen` command, then checks the example data site. The engine runs from node_modules, not a checkout.
# Usage: scripts/smoke-package.sh [mizzen-dir] [lateen-dir] [--mizzen-tarball <file>] [--lateen-tarball <file>]
#   (dirs default to ../mizzen and ../lateen). A tarball argument tests that exact file instead of packing again, so
#   the release workflow tests and publishes one artifact.
set -euo pipefail

mizzen="$(cd "${1:-../mizzen}" && pwd)"
lateen="$(cd "${2:-../lateen}" && pwd)"
if [ $# -ge 2 ]; then shift 2; elif [ $# -eq 1 ]; then shift; fi
mizzen_tarball=""
lateen_tarball=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mizzen-tarball) mizzen_tarball="$2"; shift 2 ;;
    --lateen-tarball) lateen_tarball="$2"; shift 2 ;;
    *) echo "smoke: unknown argument: $1" >&2; exit 2 ;;
  esac
done
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir "$work/tar" "$work/project"
if [ -n "$mizzen_tarball" ]; then cp "$mizzen_tarball" "$work/tar/"; else (cd "$mizzen" && npm pack --silent --pack-destination "$work/tar" >/dev/null); fi
if [ -n "$lateen_tarball" ]; then cp "$lateen_tarball" "$work/tar/"; else (cd "$lateen" && npm pack --silent --pack-destination "$work/tar" >/dev/null); fi

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

# The data contract types must be importable from the tarball alone, in an empty folder with no Lateen and no
# checkout, so a theme can typecheck against a published pre-release.
mkdir "$work/contract"
cd "$work/contract"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$work"/tar/velella-mizzen-*.tgz
cat > contract-check.ts <<'TS'
import type { Collection, DataRecord, LayoutProps, ListProps, RecordProps } from "@velella/mizzen/contracts";
export type Check = [Collection, DataRecord, ListProps, RecordProps, LayoutProps["record"], LayoutProps["list"]];
TS
"$mizzen/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext \
  --target es2023 --allowImportingTsExtensions contract-check.ts
echo "the tarball alone exposes the data contract types"

bash "$mizzen/scripts/smoke-example.sh" "$mizzen" "$lateen" \
  --mizzen-tarball "$(ls "$work"/tar/velella-mizzen-*.tgz)" \
  --lateen-tarball "$(ls "$work"/tar/velella-lateen-*.tgz)"
