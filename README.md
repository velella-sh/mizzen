<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/velella-sh/mizzen/main/.github/assets/mark-night.svg">
    <img src="https://raw.githubusercontent.com/velella-sh/mizzen/main/.github/assets/mark-day.svg" width="96" height="96" alt="Mizzen">
  </picture>
</p>

<h1 align="center">Mizzen</h1>

<p align="center">
  <strong>Same input. Same site.</strong><br>
  A deterministic docs engine with exact source positions.
</p>

<p align="center">
  <a href="https://github.com/velella-sh/mizzen/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/velella-sh/mizzen/ci.yml?branch=main&label=CI&logo=github&logoColor=white&labelColor=1F1F28&color=8A6220&style=flat"></a>
  <a href="https://www.npmjs.com/package/@velella/mizzen"><img alt="npm" src="https://img.shields.io/npm/v/@velella/mizzen?label=npm&logo=npm&logoColor=white&labelColor=1F1F28&color=8A6220&style=flat"></a>
  <a href="https://github.com/velella-sh/mizzen/actions/workflows/ci.yml"><img alt="coverage" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fvelella-sh%2Fmizzen%2Fbadges%2Fcoverage.json&labelColor=1F1F28&style=flat"></a>
  <a href="https://skills.sh/velella-sh/mizzen/mizzen"><img alt="skills.sh" src="https://skills.sh/b/velella-sh/mizzen"></a>
</p>

<p align="center">
  <a href="https://velella.sh/mizzen/install/">Quick start</a> ·
  <a href="https://velella.sh/mizzen/">Documentation</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="https://github.com/velella-sh/lateen">Lateen</a>
</p>

---

A deterministic docs engine with exact source positions: config, the content model, Markdown, navigation, the render host, outputs, diagnostics, and the CLI. No source file imports the theme's code, and no theme color, layout, or stylesheet ships here. A [Lateen](https://github.com/velella-sh/lateen) checkout beside this repository is only the CLI's fallback when no theme is configured. `test/boundary.test.ts` enforces that boundary.

## Why Mizzen

- **Deterministic.** The same input gives byte-identical output, in the same order, with LF line endings.
- **Traceable.** Every page keeps the exact source position of its text, so a tool or an agent can edit the right line.
- **Agent-ready.** A build also writes `llms.txt`, Markdown twins, a source map, and per-page JSON beside the HTML.
- **Theme-free.** The engine ships no colors or layouts; [Lateen](https://github.com/velella-sh/lateen) draws the pages.

A build runs eight stages, each a function from typed input to typed output: config, discover, front matter, Markdown, HTML, site model, render, and outputs. Stages talk only through the frozen types in `src/contracts/`. The same input gives byte-identical output, in the same order, with LF line endings.

## No build step

The source is TypeScript that Node runs directly through type stripping (Node 24 or later). Use only erasable syntax (no `enum`, `namespace`, or parameter properties), import local files with their `.ts` extension, and mark type-only imports with `import type`. `tsconfig.json` enforces this and emits nothing; never commit compiled output.

## Commands

- `npm test` runs `node --test` on `test/**/*.test.ts`.
- `npm run typecheck` runs `tsc --noEmit`.
- `node scripts/bench-data.ts` measures a site of thousands of records; the numbers, the budgets CI enforces, and what makes a build start over are in [docs/performance.md](docs/performance.md).

Many tests build the fixtures in `fixtures/` with the theme, so check out [Lateen](https://github.com/velella-sh/lateen) next to this repository (`../lateen`) and run `npm ci` in both.

## CLI

The package installs one command, `mizzen`, from `bin/mizzen.js`, which runs the built `dist/cli/index.js`. Its help is the source of truth for the flags:

```text
Usage: mizzen <command> [dir] [options]

Commands:
  agent capabilities        Print versioned JSON capabilities: task, pack, edit, verify, replay, eval
  agent schema [name]       Print a command's input schema, output schema, and exit codes
  agent task register [dir]  Register a task from --file <path> or --stdin
  agent task preview [dir]  Show proposed changes, required checks, and affected outputs; writes nothing
  agent task run <id> [dir]  Compile a task; --dry-run previews, --events <file> writes JSON Lines
  agent task status <id> [dir]  Print a task, its last run, and its approvals
  agent task resume <id> [dir]  Resume a waiting or blocked task; --approve <ids|all>
  agent task cancel <id> [dir]  Cancel a task; --reason <text>
  api check [dir]           Fail when the data API breaks a consumer of --against <built folder|git ref>
  build [dir]               Build the site into --out (default: dist)
  check [dir]               Build to a temp folder and print diagnostics only
  compare <a> <b>           Compare two build diagnostic reports
  data extract [dir]        Lock local SQLite and NDJSON collection results (--check verifies only)
  data fetch [dir]          Fetch and pin HTTPS collection sources (--check verifies only)
  data refresh [dir]        Fetch selected sources, validate, and write a review report (--collections, --report)
  data changes [name] [dir]  List a collection's pending history events (--write appends, --check fails on any)
  data verify [dir]         Compare the lock's record of each collection with its data; read-only
  data quality [dir]        Report records that fail the config's quality rules (--json, --write, --as-of)
  data snapshot <name> [dir]  Record the last commit and date of a file collection in the lock
  data schema [dir]          Report the fields each schema added or removed since its recorded baseline
  data migrate [name] [dir]  Preview the records a schema's renames would migrate; read-only
  data explain <collection> <id> [dir]
                            Explain one field's lineage (--field <path>, --json, --public)
  data transform [name] [dir]  Preview the records a collection's transform rules produce (--limit, --json)
  data transform-diff <baseline> <proposed> [dir]
                            Compare two rule versions on one input (--collection, --format, --check)
  dev [dir]                 Serve the site, rebuild on change, and reload the browser
  diff <a> <b>              Compare two built folders, or --base <ref> a git ref with the current site
  doctor [dir]              Check the config, content, output paths, runtime, and toolchain
  edit apply <patch.json> [dir]
                            Apply a span patch to its source file and record a proof
  edit transaction <file.json> [dir]
                            Apply a versioned multi-file edit atomically (--dry-run, --rebase, --approve)
  edit rollback <receipt.json> [dir]
                            Restore only the files a transaction receipt names
  edit verify <proof.json>  Check an edit proof or a verification proof (--input <file> for public evidence)
  eval [suite]              Run a deterministic evaluation suite and print its report (--format, --out, --baseline)
  evidence ingest <envelope.json> [dir] [--artifact <file>]
                            Validate evidence and store it by SHA-256
  examples record [dir]     Run and record fences (--date YYYY-MM-DD --commit <full SHA>)
  graph [dir]               Query the knowledge graph: neighbors and the shortest path (--from, --to)
  import <name> <dir>         Preview a migration; --out <dir> writes it, --fail-on-manual gates on manual items
  init [dir]                Start a site from a theme starter: --starter <name> copies it, --list names them
  knowledge [dir]           Report explicit unknowns, documentation gaps, and unsupported cases (--json, --baseline)
  mcp [dir]                 Serve the site to an AI client over MCP on stdio (read-only; --allow-edits adds apply_edit)
  network check <file>      Check the shared network file: ids, paths, titles
  network update [dir]      Fetch the network and write network.lock.json (--check, --accept)
  network sitemap [dir]     Write the organization's sitemap index (--url <origin>, --out <dir>)
  pack [dir]                Print one context pack for a topic or an ad-hoc request, to stdout or --out
  published-site attest <bundle> <provenance.json> [--key <private.pem>]
                            Print a detached site and evidence attestation
  published-site check      Check a published site from --sitemap <url>: status, canonical URL, redirects
  published-site verify <bundle> <attestation.json> <trust-policy.json>
                            Verify a local bundle offline and print a JSON report
  readiness [built]         Score a built folder against the public readiness rubric (--report, --badge, --compare)
  references check <file|-> [dir]
                            Resolve a JSON array of stored block references: resolved, removed, or unknown
  reproduce <report> [dir]  Preflight a recorded build, rebuild it, and compare the reports (--check: preflight only)
  stale [dir]               List pages whose covered files changed since review (--json, --fail, --changed <files…>, --git-diff <base>)
  stale mark <page…>        Record a page's covered files as reviewed (--all for every page)
  trace show <trace.json>   Print a recorded agent trace: task, snapshot, stages, and evidence
  trace search <trace.json>  Filter events by --stage, --file, --task, or --status
  trace replay <trace.json>  Check the recorded order, input hashes, and results; writes nothing
  trace export <trace.json>  Write or print only the authorized fields (--out <dir>)
  trace handoff <trace.json>  Print the state, changes, decisions, and remaining work
  urls check [dir]          Compare record page URLs with urls.lock.json
  verify [dir]              Check a built folder against the hash in its manifest
  versions snapshot <vN> [dir]
                            Copy the current pages and navigation into a new version folder
  surface [dir]             Report public-surface documentation coverage and gaps (--json, --baseline, --min)
  watch [dir]               Rebuild the site whenever a source or theme file changes
  inputs export [dir]       Write selected collection sources to one transferable package (--collections, --out)
  inputs inspect <file>     Print a package's format, inputs, sizes, and hashes (--json); changes nothing
  inputs verify <file>      Check every content hash and that no undeclared bytes follow; changes nothing
  inputs import <file> [dir]
                            Install a package's inputs and lock entries (--accept on a conflict)

Options:
  --out <path>         Output folder: build (default: dist), dev (default: .mizzen/dev), watch (default: .mizzen/watch), import (the generated project); pack writes a file here instead of stdout; inputs export writes the package here
  --theme <dir>        Theme root folder (layouts/, chrome/, components/)
  --diagnose           For build: write .mizzen/build-report.json after the build
  --format <format>    text, json, or sarif (check and doctor; default: text); text, json, or markdown for diff; text or json for compare, reproduce, readiness, data schema, data transform-diff, edit apply, edit verify, urls check, and published-site check; markdown or json for pack
  --sitemap <url>      Sitemap or sitemap index URL for published-site check
  --domain <host>      The one host published-site check may request (default: the sitemap's host)
  --redirects <file>   Redirect map for published-site check: a JSON object from a source address to its final address
  --hash <hex>         Expected build hash for verify (default: the manifest's)
  --site <dir>         Site root for edit verify (default: .)
  --input <file>       Public evidence for a verification proof: files, before, checks, output, human review, and package binding
  --doctor             Rerun the doctor for edit verify
  --port <number>      Port for dev (default: 3000; 0 picks a free one)
  --host <host>        Host for dev (default: 127.0.0.1)
  --as-of <date|today> The date the build pretends it is, YYYY-MM-DD (build, check, watch, data quality); today reads the system date once. Wins over the config's asOf
  --workers <n|auto>   Render pages in n worker threads; auto is the CPU count minus one (default: 1)
  --check              For data fetch: compare with mizzen.lock.json without writing; for data transform-diff: exit 1 on a change, 2 on a failure; for reproduce: preflight only
  --allow-dirty        For data snapshot: record the last commit although the file has uncommitted changes
  --json               For data quality: print the findings and scopes as JSON; for data refresh: print the report; for data explain: print the versioned lineage report; for inputs inspect: print the report as JSON
  --field <path>       For data explain: the field to trace, such as title or author.name
  --public             For data explain: print only permitted metadata, with no values or internal paths
  --limit <n>          For data transform: records to show per collection (default: 5)
  --write              For data quality: record the current data as data-quality.json
  --update-urls        For build: accept changed record URLs and write urls.lock.json
  --report             For build: print why each page was rebuilt after a warm build
  --report <file>      For data refresh: write the structured report here; for readiness: write the versioned JSON report
  --update-blocks      For build: give pages stable block ids and write blocks.lock.json
  --request <file|->   Versioned JSON context request for pack; - reads stdin
  --task <file>        JSON task contract for pack; compiles task-aware context against the site
  --topic <name>       Topic for pack (default: the site's only topic); not with --request or --task
  --budget <tokens>    Token budget for pack, overriding the topic's; not with --request
  --against <x>        For api check: a built folder or a git ref holding the API consumers rely on
  --base <path>        For build: write the site under this base path (such as /preview/pr-1); for diff: build this git ref and compare it with the current site (one dir)
  --commit <sha>       For build: record this commit in a preview's manifest (default: GITHUB_SHA)
  --preview-canonical <url>
                       For build: mark every page noindex and point its canonical at this URL plus the page's URL
  --baseline <dir>     For build: the latest public build to compare this preview with, written to .mizzen/preview-diff.json; needs --preview-canonical
  --fail-on <kinds>    For diff: exit 1 on removed-pages, broken-urls, or render-only (comma-separated)
  --change-type <type> For diff: list only one change type, such as heading, table, link, or record
  --fail-on-manual     For import: exit 1 while a manual item has no recorded decision
  --allow <ids>        For import: comma-separated manual-item ids recorded as reviewed, with --fail-on-manual
  --max-entries <n>    For diff --format markdown: table rows before "N more" (default: 50)
  --link-base <url>    For diff --format markdown: link page URLs under this base
  --allow-edits        For mcp: also offer apply_edit, which writes a patch to source with a proof
  --print-config <c>   For mcp: print the configuration for claude-code, claude-desktop, cursor, or vscode, and exit
  --starter <name>     For init: the theme starter to copy into the folder (default folder: .)
  --collections <a,b>  For inputs export: collections to carry; their references targets are added. For data refresh: collections to fetch (default: every collection)
  --collection <name>  For data transform-diff: the collection to compare when both configs declare several
  --accept <ids|all>   For inputs import: inputs whose differing destination files or lock entries may be replaced
  --list               For init: print the theme's starters with their titles and descriptions
  --min <section>=<n>  For readiness: minimum score for one rubric section (repeatable)
  --min-overall <n>    For readiness: minimum overall score
  --fail-on-unknown    For readiness: fail when a rule has no evidence
  --evals <file>       For readiness: an evaluation report whose suite, version, and build snapshot must match
  --badge <file>       For readiness: write a deterministic SVG badge (.md writes Markdown)
  --evidence <url>     For readiness: public CI evidence link kept in the report and badge
  --compare <file>     For readiness: compare this build with an earlier verified report
  --lang <a,b>         For init: keep only these of the starter's optional languages
  --dry-run            For edit apply: print the diff without writing; for versions snapshot: print the files without writing
  --allow-unchecked    Apply an edit apply patch that carries neither "expected" nor "beforeHash"
  --proof <path>       Proof record for edit apply (default: <patch>.proof.json)
  --baseline <file>    For surface: compare against an earlier report written by this command
  --min <percent>      For surface: exit 1 when the documented percentage is below this, 0 to 100
  --version <version>  For surface: the product version to inventory, recorded on every item
  -h, --help           Show this help

Exit codes: 0 ok, 1 errors, 2 usage.
```

From this repository, run it as `node bin/mizzen.ts`; from a site that installed the package, as `mizzen`.

| Command | What it does |
| --- | --- |
| `mizzen agent capabilities` | Prints one versioned (`1`) JSON document listing `task`, `pack`, `edit`, `verify`, `replay`, and `eval`. An available capability names its public commands; an unavailable one (`eval`) names a fallback instead of pretending. Writes nothing. |
| `mizzen agent schema [name]` | Prints a command's public CLI shape, its draft 2020-12 input and output schemas, and exit codes. Without a name it lists every documented command; an unknown name exits `2`. Writes nothing. |
| `mizzen agent task register [dir] --file <path>\|--stdin` | Reads a versioned task contract from exactly one source and writes `.mizzen/agent/tasks/<id>.json`, where the id is the SHA-256 of the contract's `idempotencyKey`. The same key and content return the existing task without writing; the same key with different content is a conflict (exit `1`); an invalid field is named by JSON Pointer and nothing is written (exit `2`). |
| `mizzen agent task preview [dir] --file <path>\|--stdin` | Compiles the contract's context and prints the scope references it may change, the checks and reviews its acceptance criteria require, the affected output URLs, and the token estimate. Writes no state and changes no project file. |
| `mizzen agent task run <id> [dir] --dry-run --format json\|text\|ndjson --events <file>` | Compiles the registered task's context, records its cost and budget, emits ordered versioned events (`start`, `progress`, `approval-required`, `finish`, `failure`), and moves it to `waiting` for unapproved review or `verify` when prepared. A repeated run returns the recorded result; `--dry-run` writes nothing; `--events` writes the events as JSON Lines. |
| `mizzen agent task status <id> [dir]` | Prints the task document, its last run result, and its recorded approvals as one JSON document. A missing id exits `1`; nothing is written. |
| `mizzen agent task resume <id> [dir] --approve <ids\|all>` | Moves a `waiting` or `blocked` task back to `ready`, optionally recording human-review approvals. A finished task refuses with the same `task.transition` problem every time (exit `1`). |
| `mizzen agent task cancel <id> [dir] --reason <text>` | Moves a task to `canceled` and keeps its events; a repeated cancel on a finished task returns the same conflict (exit `1`). |
| `mizzen api check [dir] --against <folder\|ref>` | Builds the site and compares its data API with the one at `--against`, a built folder or a git ref; exits `1` when a collection, a field, or a version is gone or a field changed type, and prints the file, the field, and a fix. Added fields pass. |
| `mizzen build [dir] --out <dir> --theme <dir>` | Builds `dir` (default `.`) into `--out` (default `dist`). Prints diagnostics as text. A build with an error still writes the site and exits `1`. |
| `mizzen build [dir] --diagnose` | Writes `.mizzen/build-report.json`: a versioned record of the lock, data, and content inputs, the effective config hash, rules, and reference date, the Mizzen, Node, and theme versions, the time zone and locale, and every publishable output file with its relative path and SHA-256. Moving the checkout changes nothing. See [docs/reproduce.md](docs/reproduce.md). |
| `mizzen compare <a> <b> --format text\|json` | Compares two build reports and groups every difference under inputs, config, tools, environment, or outputs. A changed output with every other category equal is flagged `unexplained`. |
| `mizzen reproduce <report> [dir] --check --out <dir> --theme <dir>` | Checks the report's inputs and tool versions before building; a missing input or incompatible Mizzen, Node, or theme version stops with the reason. Then builds without the cache, writes a fresh report to `.mizzen/build-report.json`, and compares it with the recorded one. `--check` stops after preflight; exits `1` when the output hashes differ. |
| `mizzen check [dir] --format text\|json\|sarif --theme <dir>` | Builds into a temporary folder, prints only the diagnostics in the chosen format, and removes the folder. Exits `1` on an error. |
| `mizzen data changes [name] [dir] --write --check` | Lists what changed in a collection since the state in `data-changes/`; `--write` appends the events, and `--check` fails when the data changed without an entry. |
| `mizzen data extract [dir] --check` | Extracts every local SQLite query and NDJSON collection, stores the result under `.mizzen/data/`, and records its hash in `mizzen.lock.json`; `--check` verifies without writing. A missing or stale extraction is reported at build time. |
| `mizzen data fetch [dir] --check` | Fetches every `https:` collection source, stores it under `.mizzen/data/`, and writes `mizzen.lock.json`; `--check` compares without writing. |
| `mizzen data refresh [dir] --collections <a,b> --report <file>` | Fetches the selected sources, validates them, and writes a `mizzen-refresh/1` report with counts, changed record ids, and the failed stage. |
| `mizzen data quality [dir] --json --write` | Checks the config's `quality` rules against the collections: a record missing a field, a field's coverage dropping more than `maxDrop` percentage points, or a collection losing more than `maxDrop` records since `data-quality.json`. `--write` records the current data as that baseline; `--json` prints every finding grouped by collection and rule kind. Exits `1` on a diagnostic or a finding marked as an error by its rule's `severity` or the policy. |
| `mizzen data snapshot <name> [dir] --allow-dirty` | Records the last commit that touched a file collection, and its commit date, under `snapshots` in `mizzen.lock.json`; refuses a file with uncommitted changes unless `--allow-dirty`. |
| `mizzen data schema [dir] --format text\|json` | Compares each collection's schema with the one its snapshot recorded in `mizzen.lock.json` and names the top-level fields it added or removed, with both versions and the schema file; a collection with no recorded schema is skipped. Read-only; exits `1` on a config, lock, or schema error. |
| `mizzen data migrate [name] [dir]` | Previews moving each record to the current schema: it applies the collection's `schemaRenames`, validates every record, and prints a sample of the migrated records and each rejected one with its source line. Writes nothing; exits `1` on a config, schema, or source error. |
| `mizzen data explain <collection> <id> [dir] --field <path> --json --public` | Explains one field: its versioned (`format: 1`) chain from the input hash and row, through schema renames, transform rules, joins, and aggregates, to the page URL and static API path. `--field` is required; a missing collection, record, or field exits `2` with a message. `--public` prints only permitted metadata and never a raw value, secret, or internal path, and is refused for a field the collection's `public` policy does not allow. Writes nothing. See [Field lineage](docs/lineage.md). |
| `mizzen data transform [name] [dir] --limit <n> --json` | Previews the records each collection's `transform` rules produce: a sample per collection, every finding with its source line, and with `--json` the field-change events. It loads the site as a build does and writes nothing. Without a name it previews every collection that declares rules; `--limit` defaults to 5. Exits `1` on an error. |
| `mizzen data transform-diff <baseline> <proposed> [dir] --collection <name> --format text\|json --check` | Runs two configs over the same collection input and reports records added, removed, or changed by id. Each field shows both values, with missing kept apart from null and type changes marked, and the step that last wrote it on each side or why none could be named. Transform and validation failures name their side and stage and mark the result incomplete; affected outputs come from the dependency graph. Both configs and the input are hashed, and unequal input hashes are a target error. Writes nothing. Exits `0` unchanged, `1` a change under `--check`, `2` an invalid target or failure. |
| `mizzen data verify [dir]` | Compares each collection with the lock and prints the first differing record with its source position; exits `1` on a difference and never writes. |
| `mizzen dev [dir] --port <number> --host <host> --theme <dir>` | Builds `dir`, serves the output with pretty URLs, watches the source and theme, rebuilds on change, and reloads the browser over Server-Sent Events. The reload script is added to HTML responses only; the files on disk stay as `build` wrote them. Ctrl-C stops the server. |
| `mizzen doctor [dir] --format text\|json\|sarif --theme <dir>` | Checks the runtime, the config, the content, the output paths, and the toolchain without writing to the site, and prints the findings in the chosen format. Exits `1` on an error. |
| `mizzen edit apply <patch.json> [dir] --dry-run --proof <path> --allow-unchecked` | Applies one span patch (the JSON shape of `src/edits/patch.ts`) to the source file its `span.file` names, resolved against `dir` and refused outside it. The patch is applied in memory and the file is replaced through a rename only when it succeeds, so a refused patch leaves it byte-identical. A patch that carries neither `expected` nor `beforeHash` is refused (exit `2`) unless `--allow-unchecked` is given; one that carries only one is still refused. Writes an edit proof (`src/edits/proof.ts`) with the SHA-256 before and after, at `--proof` or `<patch>.proof.json`, and prints its path. `--dry-run` prints a unified diff and writes neither. Exits `1` on a refused patch or path, `2` on a missing or invalid patch. `--format json` prints the same outcome as one report: `status`, `exitCode`, the file, the proof, and any `diagnostics` with their path and span. |
| `mizzen edit transaction <file.json> [dir] --dry-run --rebase --approve --receipt <path> --proof <path> --audit <path>` | Applies the versioned transaction of `src/contracts/edit-transaction.ts` as one all-or-nothing set: every snapshot and patch hash must match, spans may not overlap, files must stay inside the task's scope and the site's real path, content must parse, and every invariant must hold. Writes the source files, their proof, one audit line per file, and a rollback receipt; a failure at any rename restores the files already replaced. `--dry-run` prints one aggregate diff and every check without writing or reserving anything. `--rebase` relocates patches onto the current bytes; a low-confidence match needs `--approve`. Exits `1` on a conflict or failed check, `2` on a malformed transaction. `--format json` prints the files, checks, conflicts, and record paths. |
| `mizzen edit rollback <receipt.json> [dir] --format text\|json` | Restores only the files the receipt names, and only when each still holds the receipt's after hash. A file changed by a later independent edit is preserved and reported, never overwritten. Exits `1` on a damaged receipt or failed restore, `2` on a missing receipt. |
| `mizzen edit verify <proof.json> --site <dir> --doctor` | Re-hashes every file the edit's proof record names, under `--site` (default `.`), and compares each with its after-edit hash. The first mismatch is named, and the command exits `1`; a proof that cannot be read exits `2`. With `--doctor` it also runs `mizzen doctor --format json` and compares the level with the recorded one; without it, the hashes are checked and the command says the doctor check did not run. `--format json` prints the same outcome as one report, with the failed check, its path, and the doctor levels it compared. |
| `mizzen evidence ingest <envelope.json> [dir] [--artifact <file>]` | Validates an external evidence envelope and prints its SHA-256 for `evidence.lock.json`. Builds with this lock produce an offline claim report. See the [external evidence guide](docs/external-evidence.md). |
| `mizzen eval [suite] --format text\|json --out <file> --baseline <file> --package <pin>` | Runs the evaluation suite in `suite` (default `evals`): it parses each case, pins the fixture, config, compiled pack, and recorded agent output by SHA-256, calls the runner, and scores task success, evidence, scope, checks, and efficiency against the published rubric. Security is critical: a write outside the case's permissions or an allowed attempt to reach denied data fails the case whatever the total. The default runner is the deterministic reference adapter, which replays recorded outputs and drives the engine's own compiler, transaction writer, independent verifier, and handoff reader; it never calls a model or the network. `--format json` prints the versioned report; `--out` writes it; `--baseline` compares case by case and reports a changed pin as incomparable instead of a regression. Exits `0` when the gate passes, `1` on a failed or invalid case, `2` on a usage error. |
| `mizzen import <name> <dir> [--out <dir>] [--fail-on-manual] [--allow <ids>]` | Previews a migration: the importer reads `dir` and prints each file's proposed destination and URL, and the items a person still has to do. Writes nothing, or writes the mapped project to the empty `--out` folder outside the source. Exits `1` on an error and `2` on an unknown importer. `--fail-on-manual` also exits `1` while a manual item is unresolved, and `--allow <ids>` records the diagnostic ids (comma-separated) a person has reviewed, so those items no longer fail the gate. |
| `mizzen inputs export [dir] --collections <a,b> --out <file>` | Writes one deterministic package of the selected collections' sources and their `references` targets, plus the lock entries those sources need; `--out` defaults to `inputs.mizzenpack` in the current folder. Every missing input is reported by id and nothing is written. Environment files, the cache, and files outside the site never enter. See `docs/input-pack.md`. |
| `mizzen inputs inspect <file> --json` | Reads a package and prints its format, package hash, and each input's source, size, and hash. Changes nothing in the site; exits `1` on an invalid package. |
| `mizzen inputs verify <file>` | Checks the package format, every content hash, and that no undeclared bytes follow the declared contents, before an install. Changes nothing; exits `1` on a tampered, truncated, or oversized package. |
| `mizzen inputs import <file> [dir] --accept <ids\|all>` | Validates the package, every destination path and size, and the destination lock, then installs the declared inputs and merges their lock entries. A differing file or lock entry changes nothing until its input is named by `--accept`; the same package installed twice changes nothing. Exits `1` on a conflict or bad package. A package holds raw source bytes: keep it private. See `docs/input-pack.md`. |
| `mizzen init --starter <name> [dir] --theme <dir> --lang <a,b>` | Copies the theme's `starters/<name>/` folder into `dir` (default `.`), resolving the theme the way `build` does. `--list` prints each starter with its title and description from `starter.json`; `--lang` keeps only the named optional languages. It refuses a folder that is not empty and names a missing theme or starter. |
| `mizzen knowledge [dir] --json --format <text\|json> --as-of <date> --baseline <file> --out <file> --fail-on <status>` | Reports every page and record with its declared knowledge status (unknown, unsupported, unverified, not-applicable, or out-of-scope) or an explicit `missing`, and lists the gaps while keeping an explicit unknown, a documentation gap, and an unsupported case apart. `--as-of` measures review against a fixed date; `--baseline` compares with an earlier report; `--fail-on` exits `1` on a named status or a documentation gap. A private rationale or citation is redacted. Prints the versioned report or its text form; `--out` writes it. |
| `mizzen mcp [dir] [--allow-edits] [--print-config <client>]` | Serves the site to an AI client over MCP on stdio: search, read, find a block's source span, propose a diff, and read diagnostics and packs. Read-only unless `--allow-edits` adds `apply_edit`. Logs go to stderr. See `site/mcp.md`. |
| `mizzen network check <file>` | Checks the shared network file: ids, paths, and titles. See `site/network.md`. |
| `mizzen network update [dir]` | Fetches the network and writes `network.lock.json`; `--check` compares without writing and `--accept` takes a changed project. |
| `mizzen network sitemap [dir]` | Writes the organization's sitemap index; `--url <origin>` names the host and `--out <dir>` the folder. |
| `mizzen stale [dir]` | Lists pages whose covered files changed since they were reviewed. `--json`, `--fail` (exit `1` when any page is stale), `--changed <files…>`, and `--git-diff <base>` choose what counts as changed. |
| `mizzen stale mark <page…>` | Records a page's covered files as reviewed; `--all` marks every page. |
| `mizzen trace show <trace.json>` | Prints a recorded trace's task, snapshot, stages, statuses, and evidence references; `--json` prints the summary. |
| `mizzen trace search <trace.json>` | Filters events by `--stage`, `--file`, `--task`, and `--status`; `--json` prints the events. |
| `mizzen trace replay <trace.json>` | Checks the recorded order, input hashes, and results against an optional `--snapshot` and `--expect` trace. Writes and calls nothing. |
| `mizzen trace export <trace.json>` | Writes or prints only the authorized fields, with a file name derived from the trace hashes; `--out <dir>`. |
| `mizzen trace handoff <trace.json>` | Prints the state, changes, decisions, and remaining work for the next agent. |
| `mizzen urls check [dir]` | Compares every record page's URL with `urls.lock.json` and prints the new, changed, and removed records. Writes nothing; exits `1` on an error. `--format text\|json`. See `site/data/urls.md`. |
| `mizzen pack [dir] --topic <name> --budget <tokens> --out <file>` | Prints the context pack for one topic in `_data/context-packs.yml` to stdout, or writes it to `--out`. `--budget` overrides the topic's budget; without `--topic` the site's only topic is used, and a site with several lists them and exits `2`. Diagnostics go to stderr, so stdout stays clean Markdown. |
| `mizzen published-site attest <bundle> <provenance.json> [--key <private.pem>]` | Prints a detached attestation with build provenance and an allowlisted evidence manifest. See [Verifiable publishing](docs/verifiable-publishing.md). |
| `mizzen published-site verify <bundle> <attestation.json> <trust-policy.json>` | Verifies the site bundle and its evidence offline against a local trust policy and prints a JSON report. Exits `1` if verification fails. |
| `mizzen published-site check --sitemap <url> [--domain <host>] [--redirects <file>]` | Fetches every URL in a sitemap or sitemap index and reports each page's status code, canonical URL, and redirect destination. `--domain` is the only host it may request; `--redirects` names a JSON map of expected sources to final addresses. `--format text\|json`; writes nothing and exits `1` on an error. |
| `mizzen readiness [built] --report <file> --badge <file> --compare <file> --min-overall <n> --min <section>=<n> --fail-on-unknown` | Scores a built folder against the [public readiness rubric](docs/readiness.md): structure, navigation, context, examples, verification, permissions, and maintenance, with weights, unknowns, located findings, and remediation. Writes a versioned JSON report whose digest verifies, an SVG or Markdown badge, and an optional comparison with an earlier report. Exits `1` on a failed critical rule, a failed threshold, or a failing report. |
| `mizzen examples record [dir] --date YYYY-MM-DD --commit <full SHA>` | Records per-fence results in `.mizzen-examples.json`. Requires `examples.pinned: true`. See [Pinned example results](site/example-results.md). |
| `mizzen graph [dir] [--from <id>] [--to <id>]` | Answers one query against the knowledge graph: a node's neighbors and the shortest path to another node, with the same JSON and node ids as the `query_graph` MCP tool. `--depth`, `--nodes`, and `--max-output` bound the answer; a bounded answer is `partial` and carries `--cursor`. `--allow` names the audiences the caller may read. |
| `mizzen references check <file\|-> [dir]` | Resolves a JSON array of stored block references (`{"version": 1, "page": "<source>", "block": "<id>"}`) against the site's current build. Prints one JSON array of resolutions; a reference is `resolved` with its current URL, `removed` when `blocks.lock.json` recorded it, or `unknown`. Exits `1` when any reference is not resolved. |
| `mizzen diff <a> <b>` | Compares two built folders by their manifests and prints the pages, files, and records that changed, the moved pages, and the URLs that stopped answering. `--base <ref>` builds a git ref and compares it with the current site. `--format text\|json\|markdown`; exits `0` unless `--fail-on removed-pages,broken-urls,render-only` finds one (`1`). See [Compare two builds](/site-diff/). |
| `mizzen verify [dir] --hash <hex>` | Hashes a built folder by the same rule the build used and compares it with `.mizzen/manifest.json` (or `--hash`). Exits `1` on a mismatch. |
| `mizzen versions snapshot <vN> [dir]` | Copies every current page and the navigation into a new `vN/` folder and prints the files it wrote. `--dry-run` prints the same list and writes nothing. A name that exists, an invalid name, or a version that is not newer is refused and nothing is written; exits `1` on a refusal and `2` on a usage problem. |
| `mizzen surface [dir] --json --baseline <file> --min <percent> --version <v>` | Inventories the public surface — TypeScript symbols, CLI commands and flags, config keys, OpenAPI operations, data fields, and versions — matches it to documentation evidence, and prints the versioned report: counts and percentages by area, the items with complete, partial, or no documentation, and every gap with its kind, id, source, and introduction version. A documented exclusion is counted apart from a gap. `--baseline` compares two reports and reports added, removed, and newly documented items without a file rename counting as a regression; `--min` exits `1` below the documented percentage. Writes nothing but the report. See [Public surface coverage](docs/public-surface.md). |
| `mizzen watch [dir] --out <dir> --theme <dir>` | Builds `dir` once, then rebuilds whenever a source or theme file changes. Changes are debounced and builds run one at a time, in order; an unchanged build is restored from `.mizzen/cache`. Ctrl-C stops the watcher. |

`--out` is resolved from the current working directory, not from the site root, for `build`, `dev`, `pack`, and `watch`; `dev`'s default is `<site>/.mizzen/dev` and `watch`'s is `<site>/.mizzen/watch`. `check` is the command to use in CI: it never touches `dist`. `pack` reads the site model and never the theme, so it needs no theme root.

`--as-of <YYYY-MM-DD|today>` (for `build`, `check`, `watch`, and `data quality`) sets the day the build pretends it is, and wins over the config's `asOf` key. `today` reads the system date once, at the command's edge, and prints it; the build itself never reads a clock, so the same data and the same as-of date give the same bytes.

`--workers <n|auto>` (for `build` and `check`) renders pages in `n` worker threads, each one loading the theme; `auto` is the CPU count minus one. The site written is byte for byte the one `--workers 1` writes, diagnostics included. The default is `1`: a small site would pay for threads it cannot use, so a large one opts in with `--workers auto`. A worker that fails renders its pages in the main thread and adds a `render.worker-failed` warning. There is no config key, because how many cores a machine has is a machine setting, not a property of the site.

The theme root is picked in this order:

1. `--theme <dir>`, resolved from the current working directory.
2. `theme.name` in `mizzen.yml`: a folder relative to the site root, an absolute path, or a package name resolved from the site and then from the current directory.
3. A `lateen` checkout beside this repository (`../lateen`), when it exists.

A page with no layout in its front matter or in `defaults` gets the layout `doc` from the CLI. A programmatic build has no default unless it passes `defaultLayout`.

## Config

A site's settings live in `mizzen.yml` at its root; every path in the file is relative to that folder. Without the file the engine builds with the defaults below and the folder name as the title. The top level is closed: an unknown key is an error with its line and column. The schema is [`schema/config.schema.json`](schema/config.schema.json), and `SiteConfig` in `src/contracts/config.ts` is the same shape.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | string | the folder name | Site name in the header, page titles, `llms.txt`, and JSON-LD. |
| `description` | string | | One-sentence summary for the home page's meta description and `llms.txt`. |
| `url` | string | | Scheme and host of the published site, without a trailing slash, such as `https://example.com`. Needed for canonical links, social images, and an absolute sitemap; without it they are relative or left out, with a warning. |
| `base` | string | `""` | Path the site lives under, starting with `/` and without a trailing slash; empty at a domain root. Every URL the engine writes carries it. |
| `lang` | string | `en` | Default language of every page, as a BCP 47 tag. A page's `lang` wins. |
| `dir` | `ltr` or `rtl` | from `lang` | Default text direction: `rtl` for `fa`, `ar`, `he`, `ur`, and the other right-to-left languages. A page's `dir` wins. |
| `languages` | list of `{code, name, prefix}` | `[]` | The site's languages, in switcher order. Leave it out for a one-language site. |
| `source` | string | `.` | Folder that holds the content, relative to the site root. Files outside it are not pages. |
| `include` | list of strings | `[]` | Paths under `source` that discovery would skip (names starting with `.` or `_`) but should copy or build, such as `.well-known`. |
| `exclude` | list of strings | `[]` | Paths under `source` that are neither pages nor copied. `node_modules`, the output folder, and `mizzen.yml` are always excluded. |
| `navigation` | string | `_data/navigation.yml` | Navigation file, relative to the site root. Without it, navigation is built from folders and each page's `order`. |
| `defaults` | list of `{path, values}` | `[]` | Front matter applied to every page under a path unless the page sets the key itself. Later entries win over earlier ones; a page always wins. |
| `repository` | `{url, branch, dir}` | | Where the source lives, for "Edit this page" links and the "Edit with your agent" prompt. `branch` defaults to `main`; `dir` is the site root's folder in the repository, default `""`. |
| `theme` | `{name, options}` | | The theme package or folder, and the options handed to it unread. The theme validates its own options. |
| `search` | `false` or `{text}` | `{}` | `false` builds no search index. `text` is the most characters of a page's body the index keeps (default `300`); titles and headings are always indexed. |
| `examples` | `{failOnFailure, pinned}` | none | Runs fences marked `test` and writes `examples.json`. `failOnFailure: true` reports failed examples as errors. `pinned: true` uses [recorded results](site/example-results.md) during the build. |
| `social` | `{template, fonts}` | none | Turns on a generated share image for every page. `template` names `_templates/social/<template>.svg` in the source folder (1200 by 630, text slots marked `data-slot`); `fonts` lists the `.ttf`, `.otf`, or `.woff` files, relative to the site root, the images are drawn with. No system font is used. A page sets `social: <name>` in its front matter for another template, `social: false` for none, and its own `image` always wins. Without the key no image is written. The engine ships no template; the theme or the site provides one. |
| `redirects` | map of path to path or URL | `{}` | Redirect pages: each key is an old path under `base`, each value a path on the site or an `https` URL. |
| `outputs` | map of name to boolean | every output on | Turns one output off by its name, such as `twins: false`. The names are in [Outputs](#outputs). |

```yaml
title: Beacon
description: Documentation for the Beacon deploy CLI.
url: https://example.com
base: /beacon
lang: en
source: docs
navigation: _data/navigation.yml
repository:
  url: https://github.com/example/beacon
  branch: main
  dir: docs
defaults:
  - path: ""
    values:
      layout: doc
search:
  text: 300
redirects:
  /old/: /new/
outputs:
  twins: false
```

`mizzen.config.ts` is not a second config file. It holds code only: the site's plugins, default-exported as `{ plugins: [...] }`. It cannot set a key of `mizzen.yml`, so every setting stays readable without running the site's code.

## Programmatic API

The package exposes two entry points today:

| Entry | Exports |
| --- | --- |
| `@velella/mizzen` | `version`. |
| `@velella/mizzen/contracts` | The frozen contract types, type-only. |

`test/contracts-import.test.ts` builds the package and imports each entry point the way a consumer does, so the table above is checked against the artifact.

Inside the repository, each stage is a function with typed input and output:

| Function | File | Returns |
| --- | --- | --- |
| `build(options)` | `src/pipeline/build.ts` | `BuildResult`: the output folder, every file written (sorted), and every diagnostic. |
| `buildModel(root)` | `src/model/build.ts` | `ModelResult`: the complete site model plus diagnostics. It parses, renders Markdown, and builds navigation, but writes nothing. |
| `applyFacts({ site, root, sourceDir, dir? })` | `src/model/facts.ts` | `ApplyFactsResult`: the site with each derived fact's value at `data[fact.name]`, plus diagnostics. `buildModel` calls it. |
| `loadConfig(root, options?)` | `src/config/load.ts` | `LoadConfigResult`: a complete `SiteConfig` after defaults, plus diagnostics. |
| `loadRegistry(themeRoot)` | `src/render/registry.ts` | `ThemeRegistry`: the theme manifest, layouts, chrome, and components. |
| `loadCodeConfig(root, options?)` | `src/plugins/hooks.ts` | `LoadedCode`: the site's plugins and diagnostics. See [Plugins](#plugins). |

`build()` takes:

- `root`: the site root, the folder that holds `mizzen.yml`.
- `out`: the output folder, replaced as a whole. It must be outside `source`, or its first segment must start with `_` or `.`, as in `_site`.
- `themeRoot`: the theme's root folder, which holds `src/index.ts` and the `layouts/`, `chrome/`, and `components/` folders.
- `themeFiles`: theme files to copy, as paths relative to `themeRoot`; each lands under `assets/theme/` with its hash in the name.
- `defaultLayout`: the layout for a page that names none; without it such a page is an error.
- `outputsDir`: the folder outputs are read from; default `src/outputs/`.
- `cache`: reuse an unchanged build's output from the cache; off by default, and `mizzen build` turns it on.
- `cacheDir`: the cache folder; default `<root>/.mizzen/cache`, and only used when `cache` is true.
- `workers`: pages to render at once in worker threads; default `1`, which renders in this process. `2` or more starts that many workers, each loading the theme.

Every output runs first, in memory, and its files are checked: a path outside `out` is an error, and so is a path two outputs both write (the first one wins). Then the site is written to a staging folder beside `out` and swapped in only when complete. A site's own file wins over an output's file at the same path, with no diagnostic. Problems in content and theme come back as diagnostics; a throw means a bug, such as an output or layout that threw, and leaves `out` as it was.

<!-- readme-example: programmatic-build -->
```ts
import { build, type BuildResult } from "../src/pipeline/build.ts";

/** Builds a site and returns what was written. */
export function buildSite(root: string, out: string, themeRoot: string): Promise<BuildResult> {
  return build({ root, out, themeRoot, defaultLayout: "doc" });
}
```

`buildModel()` is the API for a tool that reads the site without writing it, such as a linter or an MCP server. Its diagnostics are the same ones a build reports.

## Outputs

Each `*.ts` file in an outputs folder is one unit. The pipeline finds them by listing the folder in file-name order; adding one needs no edit to a shared index. A file exports exactly one `Output`, under any export name, and its `name` must equal the file name without `.ts`. A file that exports no output is a helper and is not run.

| Name | Writes |
| --- | --- |
| `agents-md` | `AGENTS.md`, a guide to the built site for agents. |
| `api` | `api/<version>/`, the data API: `index.json`, each collection's records as `<collection>.json` and `.ndjson`, one file per record, its JSON Schema, and `openapi.json`. |
| `blog-feed` | `<route>/feed.xml`, an Atom feed of the public blog posts, newest first. |
| `changelog-feed` | `changelog.xml`, an Atom feed of the changelog page's dated release headings. |
| `code-meta-check` | No files: reports fence meta that names lines the fence does not have. |
| `collection-index` | `data/<collection>.index.json` for each collection with `index`: a column layout of its records and page URLs, split into numbered chunks over the byte budget. |
| `collection-csv` | `data/<collection>.csv` and `data/<collection>.sha256` for every collection: its records as CSV and the checksums of its raw files. `collections.<name>.raw: false` turns it off. |
| `collection-json` | `data/<collection>.json` for every collection: each record's id, URL, and page JSON address, and `data/<collection>.raw.json` with every record and its snapshot. |
| `context-pack` | `pack/<topic>.md` for each topic in `_data/context-packs.yml`: the best pages for the topic, trimmed to its token budget, with each page's URL and source path. |
| `data-changelog` | `feeds/<collection>-changes.xml`, an Atom feed of a collection's change history, when its `changelog` pages are on and the site has `url`. |
| `drift-report` | `drift.json`, every drift finding grouped by page URL. |
| `examples-report` | `examples.json`, per page: the runnable examples and how many passed, failed, or were skipped. [Pinned mode](site/example-results.md) also includes current recorded results keyed by page URL and fence ID. |
| `feed` | `changes.xml`, an Atom feed of the 30 most recently changed doc pages, when the config has `url`. |
| `feeds` | `feeds/<name>.xml`, `feeds/<name>.rss.xml`, and `feeds/<name>.json` for each feed the config declares, in the formats it names. |
| `footnote-check` | No files: reports footnote references with no definition. |
| `headers` | `_headers`, CORS and cache rules for `/api/*`, when `api.headers` is `true` and the site has no `_headers` of its own. |
| `html` | One HTML file per document page, at the page's pretty URL. |
| `link-check` | No files: reports internal links and heading anchors that do not resolve. |
| `llms` | `llms.txt`, following llmstxt.org. |
| `llms-full` | `llms-full.txt`, every page's Markdown in one file. |
| `calendars` | `calendars/<name>.ics` and one file per `groupBy` value, from the `calendars` config. |
| `record-calendar` | `calendar.ics` beside each record page that has dated events. |
| `manifest` | `.mizzen/manifest.json`, the page list, per-page source and HTML hashes, and the build hash. |
| `not-found` | `404.html`, the page at `/404/` when the site has one, else a minimal page. |
| `opensearch` | `opensearch.xml`, the site's search as an OpenSearch provider, when the config has `url`. |
| `page-agent` | One JSON file per document page with an `agent:` block (`agent.json` for a pretty URL): URL, source, and the page's instructions. |
| `page-json` | One JSON file per document page (`index.json` for a pretty URL): URL, title, description, headings, source, last change, and estimated tokens; a record page adds its collection, id, and published fields, and a list page adds its record ids, groups, and pagination. |
| `page-tools` | Copies the file a page selects with `tool:` to its site-relative output path; a missing file is an error at the page's front matter. |
| `pages-files` | `.nojekyll`, and `CNAME` when the config's `url` is a custom domain on GitHub Pages. |
| `reading-time` | `reading-time.json`, the word count and reading minutes of each doc page. |
| `redirects` | One HTML redirect page per old path, and `_redirects` for hosts that read it. |
| `related` | `related.json`, the few pages each doc page is most related to. |
| `review-coverage` | `review-coverage.json`, each doc page's review policy, reviewers, last review, and coverage state. |
| `origin-report` | No files: lists every outside origin a site with `analytics` contacts and warns about unlisted ones. |
| `blocks` | `blocks.json`, every recorded block's id, page URL, source file, and line, for a stable deep link. |
| `verification` | `BingSiteAuth.xml` and Google's verification file, when `verify` asks for them. |
| `social-images` | `assets/social/<page>.png`, a 1200 by 630 share image per page drawn from an SVG template, when the config sets `social`. The page head points at it. |
| `robots` | `robots.txt`, with the sitemap address when the config has `url`. |
| `search` | `pagefind/`, a static search index; record pages carry the fields their collection declares. |
| `search-merge` | `pagefind-network.json`, the other public projects' search indexes, for a site with a `network` key. |
| `network-record` | `.mizzen/network.json`, the locked network a build was made against, for a site with a `network` key. |
| `search-facets` | `search-facets.json`, each search filter and its value counts, with the query parameter names the theme reads. |
| `search-synonyms` | `pagefind.yml`, the search synonyms from `_data/search-synonyms.yml`. |
| `site-files` | No files: names the root files a site may own (`llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml`) so its own copy wins. |
| `sitemap` | `sitemap.xml`. |
| `sourcemap` | `sourcemap.json`, the line-exact source map (format). |
| `surface` | `surface.json`, the public-surface coverage report: each item's documentation state, the gaps, the documented exclusions, and the counts by area. Written only when the config declares `surface`. |
| `translations` | `translations.json`, each page's status in every configured language. |
| `trust` | `trust.json`, each doc page's trust level, reasons, and last reviewer. |
| `twins` | One Markdown twin per document page: the same URL with `.md` in place of the HTML file. |
| `urls` | `urls.json`, each collection's record ids and their page URLs, with the engine version and a hash of the data. |
| `variables` | `variables.json`, every variable placeholder a page uses and its declaration. |
| `version-diff` | `diff/<version>/<path>.json` for each adjacent pair of versions whose page sections differ. |
| `versions` | `versions.json`, the versions each page path exists in and how it differs from the newest. |

A preview build also writes `.mizzen/doctor.json`: the `doctor --format json` report of that build, the count of each severity, and the base and canonical it was built under.

`outputs` in `mizzen.yml` turns one off by name:

```yaml
outputs:
  twins: false
  search: false
```

The contract is in `src/contracts/output.ts`:

```ts
interface Output {
  readonly name: string;
  run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]>;
}
```

`ctx.renderPage(page)` renders a page to a complete HTML document through the theme. `ctx.report(diagnostic)` records a finding; an output reports a content problem instead of throwing. `run()` returns files sorted by path, each `{ path, contents }`, where `path` is relative to the output folder and uses `/`, and `contents` is a string (UTF-8, LF) or a `Uint8Array`.

A custom outputs folder is passed to `build()` as `outputsDir`. It replaces the built-in folder for that build, so a custom output can either live beside the built-ins or be the whole set.

<!-- readme-example: custom-output -->
```ts
import type { Output } from "@velella/mizzen/contracts";

/** Writes feed.txt; the file name must be feeds.ts, so the output's name is feeds. */
export const feeds: Output = {
  name: "feeds",
  async run() {
    return [{ path: "feed.txt", contents: "hello\n" }];
  },
};
```

## Plugins

A site adds behavior from `mizzen.config.ts` at its root. The file default-exports its plugins and nothing else:

```ts
import type { Plugin } from "@velella/mizzen/contracts";

export default {
  plugins: [
    /* Plugin objects, in the order they run. */
  ],
};
```

A site without the file is an ordinary site: no plugins, no diagnostics. A file Node cannot import, or a default export without a `plugins` list, is one error naming the file. An entry that is not a plugin is dropped with an error and the sound entries still run.

A plugin is a `name` for diagnostics and any of five hooks. Each hook receives a value and returns the value the next plugin receives; none mutates its input. A hook may be async, and it is awaited before the next plugin runs.

| Hook | Runs | Receives | Returns |
| --- | --- | --- | --- |
| `markdown` | Once per page, after includes and before Markdown is parsed. | `MarkdownSource` | `string`, with the same line count |
| `content` | Once per page, after its Markdown is parsed and before the site model is assembled. | `Page` | `Page` |
| `validate` | Once per final page, after the `content` hooks. | `Page` | `readonly Diagnostic[]` |
| `model` | Once, after the site model is assembled and before anything is rendered. | `Site` | `Site` |
| `outputs` | Once, with the files the outputs produced and the site they came from, before the files are written. | `readonly OutputFile[]`, `Site` | `readonly OutputFile[]` |

A hook that throws, returns something the stage cannot use, or misses its 10-second deadline is `plugin.hook-failed` or `plugin.hook-timeout`; the message names the plugin and the stage. The value the stage carried before that plugin is kept and the plugins after it still run, so one bad plugin costs its own work and nothing more.

The runnable example is [examples/plugin-api/](examples/plugin-api/README.md). [recipes/plugin-api.md](recipes/plugin-api.md) walks through the same hooks, and [docs/plugin-api.md](docs/plugin-api.md) is the full contract.

<!-- readme-example: plugin -->
```ts
import type { Plugin } from "@velella/mizzen/contracts";

const banner: Plugin = {
  name: "banner",
  content(page) {
    return { ...page, frontMatter: { ...page.frontMatter, banner: true } };
  },
};

export default { plugins: [banner] };
```

The loader is `loadCodeConfig()` and the hook runners are `runMarkdownHooks()`, `runContentHooks()`, `runValidateHooks()`, `runModelHooks()`, and `runOutputsHooks()` in `src/plugins/`. Each runner returns `{ value, diagnostics }` and never fails the stage. `build()` loads `mizzen.config.ts` and runs every hook in the order above, once per stage, before anything is written. The file itself is never copied into the output.

A plugin also declares its cache inputs: `version`, `settings`, and `inputs`, the site-relative files its code reads. A site whose plugins all declare `inputs` is cached, and a change to a declared version, setting, declared file, or the code file misses. A plugin that omits `inputs` declares that its inputs cannot be tracked, so a site that lists it always builds cold; `inputs: []` declares that it reads no file.

## Layout

- `src/index.ts`: the public entry. It exports only `version` for now.
- `src/contracts/`: the frozen types every stage shares; types only, nothing runs.
- `src/config/`, `src/content/`, `src/markdown/`, `src/model/`, `src/nav/`, `src/pipeline/`, `src/plugins/`, `src/render/`, `src/outputs/`, `src/source/`: the pipeline's stages and units.
- `src/model/facts/`: one file per derived fact, merged into `Site.data` at the end of the model stage; see its [README](src/model/facts/README.md).
- `src/outputs/`: one file per output; see its [README](src/outputs/README.md).
- `bin/mizzen.js`: the installed `mizzen` command, which runs the built `dist/cli/index.js`.
- `bin/mizzen.ts`: the same command run from a checkout.
- `schema/config.schema.json`: the site config schema.
- `test/`: `*.test.ts` files for `node --test`.

## Contributing

Bug reports, fixes, and docs improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[Apache-2.0](LICENSE).

---

<p align="center">Mizzen is part of <a href="https://velella.sh">Velella</a>. The mast behind the sail.</p>
