# Upgrading to Mizzen 0.2.6

`0.2.6` adds an agent surface to the engine: versioned tasks, compiled context, a recoverable MCP runtime, atomic edit
transactions, independent proofs, traces, evaluations, and readiness reports. An existing `0.2.5` site needs no content
migration. Every new key, contract, and command is opt-in, and an ordinary build keeps its pages, URLs, configuration,
and output.

## Measured compatibility with 0.2.5

The release candidate was built against the published baseline in separate empty projects:

| Check | Baseline | Candidate | Result |
| --- | --- | --- | --- |
| Package | `@velella/mizzen@0.2.5` | `velella-mizzen-0.2.6.tgz` (`d5098d97e79693ffb421a823b71adbe09528f8e9fc95dd4d7488b409c0cd5fc6`) | — |
| Public files compared | 197 | 197 | 0 missing, 0 changed, 0 added |
| Canonical links | 2 | 2 | 0 differences |
| `_redirects` | 2 rules | 2 rules | identical |
| Sitemap URLs | 31 | 31 | 0 differences |
| Theme | `@velella/lateen@0.2.2` baseline | `@velella/lateen@0.2.3` | canonical, base assets, Mermaid SVG, and redirects keep the base |

### Intended difference: page head tags

The build now prints the head that `headMeta` computes: Open Graph and Twitter tags, a canonical link, JSON-LD, and
`og:image` for a page whose social image is written. The compatibility comparison removes exactly those tags from the
candidate (and the derived `trust.json` `build.id`) and requires everything else to match, including the single
canonical link and the `hreflang` set. In the compatibility site that is, on 31 pages, `og:type`, `og:title`,
`og:url`, `og:site_name`, `twitter:card`, a canonical link, `og:description` on 23 pages, and 38 JSON-LD blocks, plus a
description on the home page. See `fixtures/compat-0.2.5/README.md`.

Reproduce it with the committed compatibility site:

```sh
npm pack --pack-destination /tmp/mizzen
node scripts/release-compat.ts \
  --baseline @velella/mizzen@0.2.5 \
  --theme @velella/lateen@0.2.3 \
  --candidate /tmp/mizzen/velella-mizzen-0.2.6.tgz \
  --report /tmp/mizzen/compat-report.json
```

The script compares every public file byte for byte, normalizing only the engine version stamp in `agent.json` and the
platform-specific Pagefind wasm binaries. The result above is from a local run with registry access; a run without
registry access can use the committed baseline fixture instead, and must say that the baseline was not re-fetched.

### What stays the same

- `mizzen build`, `dev`, `check`, `verify`, `watch`, `diff`, `stale`, `import`, `data`, `api`, `network`,
  `published-site`, `urls`, `references`, `compare`, `reproduce`, `inputs`, and `init` keep their flags and exit codes.
- Markdown, front matter, navigation, collections, transforms, joins, aggregates, public fields, feeds, search, and
  every existing URL are unchanged.
- Generated reports still carry `format` versions; `build-report` stays format `1`, lineage stays `format: 1`, refresh
  stays `mizzen-refresh/1`. A consumer reads the engine revision from `version` in `@velella/mizzen`, never from a
  pinned literal.
- The schemas in `schema/` are additive. Read them from the installed package rather than copying an older set.

### New public entry points

| Area | Entry point | Contract |
| --- | --- | --- |
| Agent CLI | `mizzen agent capabilities`, `agent schema`, `agent task register/preview/run/status/resume/cancel` | `schema/task-contract.schema.json`, `schema/task.schema.json` |
| Context | `mizzen pack --task <file>` | `schema/context-request.schema.json`, `schema/context-pack.schema.json` |
| Graph | `mizzen graph --from <id> --to <id>` | `schema/graph.schema.json` |
| MCP | `mizzen mcp <dir>` and `--print-config` | `schema/task.schema.json`, `schema/trace.schema.json` |
| Editing | `mizzen edit apply/transaction/rollback/verify` | `schema/edit-transaction.schema.json`, `schema/verification-proof.schema.json` |
| Trace | `mizzen trace show/search/replay/export/handoff` | `schema/trace.schema.json` |
| Evals | `mizzen eval [suite]` | `schema/eval-case.schema.json`, `schema/eval-suite.schema.json`, `schema/eval-report.schema.json` |
| Readiness | `mizzen readiness <built>` | `schema/readiness-report.schema.json` |
| Permissions | `--policy <file>` on `edit` and `mcp` | `schema/access-policy.schema.json` |

## Contract review

### Tasks

Version `1` task contracts are new; there is nothing before them to break. The contract has deterministic task,
request, and snapshot identities, a semantic scope, independent context/tool-call/time budgets, permissions, and
acceptance criteria that name a check or a human review. The CLI registers a contract from a file or stdin and writes
`.mizzen/agent/tasks/<id>.json` only when it validates:

```sh
mizzen agent task register . --file task.json
mizzen agent task run <task-id> . --dry-run
mizzen agent task resume <task-id> . --approve all
```

A version `0` document is migrated by filling `version: 1` and the required `scope.files`, `budget`, and
`permissions` fields. The rule is mechanical, so a small Node script is enough; nothing else in the document changes:

```js
import { readFileSync, writeFileSync } from "node:fs";
const task = JSON.parse(readFileSync("task.json", "utf8"));
if (task.version === 0) {
  writeFileSync("task-v1.json", JSON.stringify({
    ...task,
    version: 1,
    scope: { pages: [], blocks: [], collections: [], symbols: [], files: [], ...task.scope },
    budget: task.budget ?? { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
    permissions: task.permissions ?? { read: ["*"], write: [], check: [] },
  }, null, 2));
}
```

The same idempotency key and content return the existing task; the same key with different content is a conflict and
writes nothing. Every transition is an ordered event and replays deterministically.

### Context

`pack --task` takes a task contract, reads `blocks.lock.json`, and compiles ranked fragments with a file, span, block
or record id, and the build snapshot. It reports the exact accounting, the omissions with a reason, per-criterion
answerability, and the evidence it still needs:

```sh
mizzen pack . --task fixtures/context-compiler/task.json --format json
```

`--request` still accepts a version `1` `context-request` and is the ad-hoc entry point. A request with no budget, an
empty goal, or an unknown field is refused with a JSON Pointer and nothing is written.

### MCP

The server announces contract version `1` in `initialize` before any tool runs. An older client keeps the same core
answers; a client with fewer capabilities gets explicit fallbacks in `_meta.mizzen`, never a silent degradation. New
tools and fields are additive. `apply_edit` accepts an idempotency key: the same key returns the same receipt, a
different payload is refused, and a reconnect never applies an edit twice. Sessions are pinned to one site snapshot;
a cursor or operation from another snapshot is a named error.

Generate a client entry instead of hand-writing one:

```sh
mizzen mcp . --print-config claude-desktop
mizzen mcp . --print-config cursor --allow-edits
```

The installable skill under `skills/mizzen-client/` carries a versioned manifest and a SHA-256 checksum; its guide
matches the fallbacks the server reports. `test/skill.test.ts` and `test/clients-profiles.test.ts` prove both.

### Transactions and proofs

An edit transaction is versioned and pins the task, snapshot, patches, scope, invariants, and preconditions. The first
run previews, the second applies atomically, and a receipt rolls back only the files it names while preserving later
independent edits:

```sh
mizzen edit transaction tx.json . --dry-run --format json
mizzen edit transaction tx.json . --format json
mizzen edit verify tx.json.receipt.json.proof.json
mizzen edit rollback tx.json.receipt.json .
```

Proofs are version `2`; version `1` edit proofs still verify. A version `2` proof maps each acceptance criterion to a
check, fixture, and expected evidence, or to a human review that never passes automatically. `edit verify` in a fresh
process withholds success for a failed, unrun, or missing check. A receipt binds the commit, tarball SHA-256, and CI
result; swapping the package invalidates it.

### Traces

Traces are version `1`, ordered, and parent-linked. They record input hashes and result references, not bodies;
decisions, refusals, and approvals with a reason and policy, never chain of thought; and timing separately from
replay. `trace replay` is read-only and writes nothing:

```sh
mizzen trace replay trace.json
mizzen trace export trace.json --out export/
mizzen trace handoff trace.json
```

### Evaluations

Suites, cases, and reports are versioned. The default runner is clock-free, offline, and deterministic: it replays
recorded agent output and drives the engine's own compiler, transaction writer, verifier, and handoff reader. A changed
pin is reported as incomparable, not as a regression:

```sh
mizzen eval fixtures/evals --format json --out report.json
mizzen eval fixtures/evals --baseline report.json
```

The live-model adapter and its scheduled workflow stay outside the engine; a CI gate never calls a model.

### Readiness

`mizzen readiness <built>` scores a built folder, not a source tree, against rubric `1.0.0`. Reports are versioned,
carry a verifying digest, and mark missing evidence `unknown`, never pass. A badge is written only from a verified
report:

```sh
mizzen build . --out dist
mizzen readiness dist --report readiness.json --badge readiness.svg
mizzen readiness dist --min-overall 90 --min verification=100
```

### Permissions

An access policy is version `1` and least-privilege by default: public read, no write, no check runner, no network,
no publish. A policy is validated with JSON Pointers and loaded with `--policy`:

```sh
mizzen edit apply patch.json . --policy policy.json
mizzen mcp . --policy policy.json --allow-edits
```

A write is checked against both the allowed path and the semantic scope, traversal and symlinks are refused, and every
allow or deny writes an audit line. Redaction is shared across traces, reports, and MCP answers.

## Upgrading a project

1. Install the new engine and keep your theme:

   ```sh
   npm install --save-dev @velella/mizzen@0.2.6
   npx mizzen check .
   npx mizzen build . --out dist
   npx mizzen verify dist
   ```

2. Commit `package.json` and `package-lock.json`. Lateen `0.2.3` is the published theme this release was checked
   against; Lateen `0.2.2` still works.
3. Adopt an agent feature only when you need it. Run `mizzen agent capabilities` to see what the installed package
   reports, then add a task contract, a policy, or a readiness gate to CI.
4. Keep third-party schemas in sync by reading `schema/` from the installed package. No shipped schema removed a field
   in `0.2.6`.

## Measured cost

The build, pack, transaction, and replay timings and the budgets a regression must stay under are in
[determinism and performance](determinism-0.2.6.md).

## Known limits

- Automated maintenance and multi-agent coordination landed as deterministic library modules and recipe data. They
  have tests (`test/maintenance-*.test.ts`, `test/coordination-*.test.ts`) but no public CLI or MCP command in
  `0.2.6`; they are recorded as library capabilities in `release/scope.json`, not as shipped commands.
- The live evaluation runner needs a model endpoint and is opt-in; its results are separate from the offline gate and
  are not part of the release acceptance run.
- The release was verified on the published `@velella/lateen@0.2.3` and on the sibling `../lateen` checkout. A
  different theme version is outside that measured contract.
