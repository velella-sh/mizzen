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

# A sample agent client uses only public JSON from the installed tarball: discover, register, run, read,
# approve, run again, and cancel a task. No checkout, no help text, no internal module. The README the
# tarball ships must name the commands the capability document reports, or the docs and the binary disagree.
mkdir "$work/agent"
cd "$work/agent"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$work"/tar/velella-mizzen-*.tgz
mkdir -p site/guide
printf 'title: Agent smoke\n' > site/mizzen.yml
printf '# Home\n\nThe agent smoke site.\n' > site/index.md
printf '# Install\n\nInstall the engine with Node 24 and a terminal.\n' > site/guide/install.md
node <<'JS'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const mizzen = path.resolve("node_modules/@velella/mizzen/bin/mizzen.js");
function run(args, input) {
  const result = spawnSync(process.execPath, [mizzen, ...args], { encoding: "utf8", input });
  if (result.error) throw result.error;
  return result;
}
function parse(result, args) {
  if (result.stdout.trim() === "") throw new Error(`mizzen ${args.join(" ")} wrote no JSON`);
  return JSON.parse(result.stdout);
}
function ok(args, input) {
  const result = run(args, input);
  if (result.status !== 0) throw new Error(`mizzen ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return parse(result, args);
}
function conflict(args) {
  const result = run(args);
  if (result.status !== 1) throw new Error(`mizzen ${args.join(" ")} exited ${result.status}, not 1: ${result.stderr}`);
  const document = parse(result, args);
  if (document.ok !== false || document.problems.length === 0) throw new Error(`mizzen ${args.join(" ")} did not report a problem`);
  return document;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const caps = ok(["agent", "capabilities"]);
assert(caps.version === 1 && caps.capabilities.length === 6, "capabilities are version 1 and list six names");
assert(caps.capabilities.map((entry) => entry.name).join(",") === "task,pack,edit,verify,replay,eval", "capabilities keep their order");
const evalCapability = caps.capabilities.find((entry) => entry.name === "eval");
assert(evalCapability.available === false, "eval is reported unavailable");
assert(typeof evalCapability.fallback === "string" && evalCapability.fallback.length > 0, "eval has a fallback reason");

const schema = ok(["agent", "schema", "agent.task.register"]);
assert(schema.version === 1 && schema.input.type === "object" && schema.output.type === "object", "the register schema is public JSON");
assert(schema.exitCodes["2"].includes("invalid"), "the schema names exit code 2");

const contract = {
  version: 1,
  idempotencyKey: "smoke-agent-task",
  goal: "Update the install guide for Node 24",
  scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: ["guide/install.md"] },
  snapshot: { content: "a".repeat(64), data: "b".repeat(64), config: "c".repeat(64), tooling: "d".repeat(64) },
  budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
  permissions: { read: ["*"], write: ["agent"], check: ["agent"] },
  acceptance: [{ id: "review", statement: "A person reviewed the wording", review: true }],
};
const registered = ok(["agent", "task", "register", "site", "--stdin"], JSON.stringify(contract));
assert(registered.created === true && registered.state === "draft", "the task registered in draft");
const id = registered.taskId;

const first = ok(["agent", "task", "run", id, "site"]);
assert(first.outcome === "awaiting-approval", "the review criterion pauses the run");
assert(first.progress.events.map((event) => event.type).join(",") === "start,progress,approval-required,finish", "the events are ordered");
assert(first.cost.estimated === true && first.cost.toolCalls === 1, "the cost report is machine-readable");

const status = ok(["agent", "task", "status", id, "site"]);
assert(status.task.state === "waiting" && status.run.outcome === "awaiting-approval", "status reads the paused task");

const resumed = ok(["agent", "task", "resume", id, "site", "--approve", "all"]);
assert(resumed.task.state === "ready" && resumed.approvals.includes("review"), "resume records the approval");

const prepared = ok(["agent", "task", "run", id, "site"]);
assert(prepared.outcome === "prepared" && prepared.task.state === "verify", "the approved task prepares");
assert(prepared.resultRef.startsWith("context:"), "the prepared result names its context");

const canceled = ok(["agent", "task", "cancel", id, "site"]);
assert(canceled.task.state === "canceled", "cancel is terminal");
const conflictDocument = conflict(["agent", "task", "cancel", id, "site"]);
assert(conflictDocument.problems[0].code === "task.transition", "a repeated cancel reports the same conflict");

const readme = fs.readFileSync("node_modules/@velella/mizzen/README.md", "utf8");
for (const command of ["mizzen agent capabilities", "mizzen agent schema", "mizzen agent task register", "mizzen agent task run"]) {
  assert(readme.includes(command), `the tarball's README documents ${command}`);
}
console.log("the installed agent CLI discovers, registers, runs, recovers, and cancels a task with public JSON");
JS

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
