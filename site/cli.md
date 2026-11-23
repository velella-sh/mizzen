---
title: Command line
description: "Every mizzen command and flag, from build and check to data fetch, doctor, dev, pack, verify, and edit."
layout: doc
permalink: /cli/
---

Mizzen installs one command, `mizzen`.

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
  -h, --help           Show this help

Exit codes: 0 ok, 1 errors, 2 usage.
```

From a site that installed the package, run it as `mizzen` (or `npx mizzen`). From a checkout of this repository, run `node bin/mizzen.ts`.

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
| `mizzen build [dir] --diagnose` | Writes `.mizzen/build-report.json`: a versioned record of the lock, data, and content inputs, the effective config hash, rules, and reference date, the Mizzen, Node, and theme versions, the time zone and locale, and every publishable output file with its relative path and SHA-256. Moving the checkout changes nothing. See [Diagnose and reproduce builds](https://github.com/velella-sh/mizzen/blob/main/docs/reproduce.md). |
| `mizzen compare <a> <b> --format text\|json` | Compares two build reports and groups every difference under inputs, config, tools, environment, or outputs. A changed output with every other category equal is flagged `unexplained`. |
| `mizzen reproduce <report> [dir] --check --out <dir> --theme <dir>` | Checks the report's inputs and tool versions before building; a missing input or incompatible Mizzen, Node, or theme version stops with the reason. Then builds without the cache, writes a fresh report to `.mizzen/build-report.json`, and compares it with the recorded one. `--check` stops after preflight; exits `1` when the output hashes differ. |
| `mizzen check [dir] --format text\|json\|sarif --theme <dir>` | Builds into a temporary folder, prints only the diagnostics in the chosen format, and removes the folder. Exits `1` on an error. |
| `mizzen data changes [name] [dir] --write --check` | Lists what changed in a collection since the state in `data-changes/`; `--write` appends the events, and `--check` fails when the data changed without an entry. |
| `mizzen data extract [dir] --check` | Extracts every local SQLite query and NDJSON collection, stores the result under `.mizzen/data/`, and records its hash in `mizzen.lock.json`; `--check` verifies without writing. A missing or stale extraction is reported at build time. |
| `mizzen data fetch [dir] --check` | Fetches every `https:` collection source, stores its bytes under `.mizzen/data/`, and writes `mizzen.lock.json`; a source with `records` and `pagination` is walked page by page and stored as one record list. `--check` compares without writing and exits 1 when data changed. A source that is new, changed, or over its limit is a failure. |
| `mizzen data refresh [dir] --collections <a,b> --report <file>` | Fetches the selected sources, validates the result against every schema and quality rule, and writes a `mizzen-refresh/1` report. The report names the record counts, added and removed ids, the changed ids, and the stage that failed; a failed validation restores the previous lock. Exit 0 is changed or unchanged, 1 is a failed stage, 2 is a usage error. |
| `mizzen data quality [dir] --json --write` | Checks the config's `quality` rules against the collections: a record missing a field, a field's coverage dropping more than `maxDrop` percentage points, or a collection losing more than `maxDrop` records since `data-quality.json`. `--write` records the current data as that baseline; `--json` prints every finding. Exits `1` on a diagnostic or a finding the policy marks as an error. |
| `mizzen data snapshot <name> [dir] --allow-dirty` | Records the last commit that touched a file collection, and its commit date, under `snapshots` in `mizzen.lock.json`; refuses a file with uncommitted changes unless `--allow-dirty`. See [Recorded snapshots](/data/snapshots/). |
| `mizzen data schema [dir] --format text\|json` | Compares each collection's schema with the one its snapshot recorded in `mizzen.lock.json` and names the top-level fields it added or removed, with both versions and the schema file; a collection with no recorded schema is skipped. Read-only; exits `1` on a config, lock, or schema error. See [Recorded snapshots](/data/snapshots/). |
| `mizzen data migrate [name] [dir]` | Previews moving each record to the current schema: it applies the collection's `schemaRenames`, validates every record, and prints a sample of the migrated records and each rejected one with its source line. Writes nothing; exits `1` on a config, schema, or source error. See [Recorded snapshots](/data/snapshots/). |
| `mizzen data explain <collection> <id> [dir] --field <path> --json --public` | Explains one field: its versioned (`format: 1`) chain from the input hash and row, through schema renames, transform rules, joins, and aggregates, to the page URL and static API path. `--field` is required; a missing collection, record, or field exits `2` with a message. `--public` prints only permitted metadata and never a raw value, secret, or internal path, and is refused for a field the collection's `public` policy does not allow. Writes nothing. See [Field lineage](https://github.com/velella-sh/mizzen/blob/main/docs/lineage.md). |
| `mizzen data transform [name] [dir] --limit <n> --json` | Previews the records each collection's `transform` rules produce: a sample per collection, every finding with its source line, and with `--json` the field-change events. It loads the site as a build does and writes nothing. Without a name it previews every collection that declares rules; `--limit` defaults to 5. Exits `1` on an error. See [Transforming data](https://github.com/velella-sh/mizzen/blob/main/docs/transform.md). |
| `mizzen data transform-diff <baseline> <proposed> [dir] --collection <name> --format text\|json --check` | Runs two configs over the same collection input and reports records added, removed, or changed by id. Each field shows both values, with missing kept apart from null and type changes marked, and the step that last wrote it on each side or why none could be named. Transform and validation failures name their side and stage and mark the result incomplete; affected outputs come from the dependency graph. Both configs and the input are hashed, and unequal input hashes are a target error. Writes nothing. Exits `0` unchanged, `1` a change under `--check`, `2` an invalid target or failure. See [Transforming data](https://github.com/velella-sh/mizzen/blob/main/docs/transform.md). |
| `mizzen data verify [dir]` | Compares each collection with the lock and prints the first differing record with its source position; exits `1` on a difference and never writes. |
| `mizzen dev [dir] --port <number> --host <host> --theme <dir>` | Builds `dir`, serves the output with pretty URLs, watches the source and theme, rebuilds on change, and reloads the browser over Server-Sent Events. The reload script is added to HTML responses only; the files on disk stay as `build` wrote them. Ctrl-C stops the server. |
| `mizzen doctor [dir] --format text\|json\|sarif --theme <dir>` | Checks the runtime, the config, the content, the output paths, and the toolchain without writing to the site, and prints the findings in the chosen format. Exits `1` on an error. |
| `mizzen edit apply <patch.json> [dir] --dry-run --proof <path> --allow-unchecked` | Applies one span patch (the JSON shape of `src/edits/patch.ts`) to the source file its `span.file` names, resolved against `dir` and refused outside it. The patch is applied in memory and the file is replaced through a rename only when it succeeds, so a refused patch leaves it byte-identical. A patch that carries neither `expected` nor `beforeHash` is refused (exit `2`) unless `--allow-unchecked` is given; one that carries only one is still refused. Writes an edit proof (`src/edits/proof.ts`) with the SHA-256 before and after, at `--proof` or `<patch>.proof.json`, and prints its path. `--dry-run` prints a unified diff and writes neither. Exits `1` on a refused patch or path, `2` on a missing or invalid patch. `--format json` prints the same outcome as one report: `status`, `exitCode`, the file, the proof, and any `diagnostics` with their path and span. |
| `mizzen edit transaction <file.json> [dir] --dry-run --rebase --approve --receipt <path> --proof <path> --audit <path>` | Applies the versioned transaction of `src/contracts/edit-transaction.ts` as one all-or-nothing set: every snapshot and patch hash must match, spans may not overlap, files must stay inside the task's scope and the site's real path, content must parse, and every invariant must hold. Writes the source files, their proof, one audit line per file, and a rollback receipt; a failure at any rename restores the files already replaced. `--dry-run` prints one aggregate diff and every check without writing or reserving anything. `--rebase` relocates patches onto the current bytes; a low-confidence match needs `--approve`. Exits `1` on a conflict or failed check, `2` on a malformed transaction. `--format json` prints the files, checks, conflicts, and record paths. |
| `mizzen edit rollback <receipt.json> [dir] --format text\|json` | Restores only the files the receipt names, and only when each still holds the receipt's after hash. A file changed by a later independent edit is preserved and reported, never overwritten. Exits `1` on a damaged receipt or failed restore, `2` on a missing receipt. |
| `mizzen edit verify <proof.json> --site <dir> --doctor` | Re-hashes every file the edit's proof record names, under `--site` (default `.`), and compares each with its after-edit hash. The first mismatch is named, and the command exits `1`; a proof that cannot be read exits `2`. With `--doctor` it also runs `mizzen doctor --format json` and compares the level with the recorded one; without it, the hashes are checked and the command says the doctor check did not run. `--format json` prints the same outcome as one report, with the failed check, its path, and the doctor levels it compared. |
| `mizzen evidence ingest <envelope.json> [dir] [--artifact <file>]` | Validates an external evidence envelope and prints its SHA-256 for `evidence.lock.json`. Builds with this lock produce an offline claim report. See the [external evidence guide](https://github.com/velella-sh/mizzen/blob/main/docs/external-evidence.md). |
| `mizzen eval [suite] --format text\|json --out <file> --baseline <file> --package <pin>` | Runs the evaluation suite in `suite` (default `evals`): it parses each case, pins the fixture, config, compiled pack, and recorded agent output by SHA-256, calls the runner, and scores task success, evidence, scope, checks, and efficiency against the published rubric. Security is critical: a write outside the case's permissions or an allowed attempt to reach denied data fails the case whatever the total. The default runner is the deterministic reference adapter, which replays recorded outputs and drives the engine's own compiler, transaction writer, independent verifier, and handoff reader; it never calls a model or the network. `--format json` prints the versioned report; `--out` writes it; `--baseline` compares case by case and reports a changed pin as incomparable instead of a regression. Exits `0` when the gate passes, `1` on a failed or invalid case, `2` on a usage error. |
| `mizzen import <name> <dir> [--out <dir>] [--fail-on-manual] [--allow <ids>]` | Previews a migration: the importer reads `dir` and prints each file's proposed destination and URL, and the items a person still has to do. Writes nothing, or writes the mapped project to the empty `--out` folder outside the source. Exits `1` on an error and `2` on an unknown importer. `--fail-on-manual` also exits `1` while a manual item is unresolved, and `--allow <ids>` records the diagnostic ids (comma-separated) a person has reviewed, so those items no longer fail the gate. |
| `mizzen inputs export [dir] --collections <a,b> --out <file>` | Writes one deterministic package of the selected collections' sources and their `references` targets, plus the lock entries those sources need; `--out` defaults to `inputs.mizzenpack` in the current folder. Every missing input is reported by id and nothing is written. Environment files, the cache, and files outside the site never enter. See `docs/input-pack.md`. |
| `mizzen inputs inspect <file> --json` | Reads a package and prints its format, package hash, and each input's source, size, and hash. Changes nothing in the site; exits `1` on an invalid package. |
| `mizzen inputs verify <file>` | Checks the package format, every content hash, and that no undeclared bytes follow the declared contents, before an install. Changes nothing; exits `1` on a tampered, truncated, or oversized package. |
| `mizzen inputs import <file> [dir] --accept <ids\|all>` | Validates the package, every destination path and size, and the destination lock, then installs the declared inputs and merges their lock entries. A differing file or lock entry changes nothing until its input is named by `--accept`; the same package installed twice changes nothing. Exits `1` on a conflict or bad package. A package holds raw source bytes: keep it private. See `docs/input-pack.md`. |
| `mizzen init --starter <name> [dir] --theme <dir> --lang <a,b>` | Copies the theme's `starters/<name>/` folder into `dir` (default `.`), resolving the theme the way `build` does. `--list` prints each starter with its title and description from `starter.json`; `--lang` keeps only the named optional languages. It refuses a folder that is not empty and names a missing theme or starter. |
| `mizzen mcp [dir] [--allow-edits] [--print-config <client>]` | Serves the site to an AI client over MCP on stdio. Read-only unless `--allow-edits` adds `apply_edit`. Logs go to stderr. See [MCP server](/mcp/). |
| `mizzen knowledge [dir] --json --format <text\|json> --as-of <date> --baseline <file> --out <file> --fail-on <status>` | Reports every page and record with its declared knowledge status (unknown, unsupported, unverified, not-applicable, or out-of-scope) or an explicit `missing`, and lists the gaps while keeping an explicit unknown, a documentation gap, and an unsupported case apart. `--as-of` measures review against a fixed date; `--baseline` compares with an earlier report; `--fail-on` exits `1` on a named status or a documentation gap. See [Explicit unknowns](/explicit-unknowns/). |
| `mizzen network check <file>` | Checks the shared network file: ids, paths, and titles. See [Several projects](/network/). |
| `mizzen network update [dir]` | Fetches the network and writes `network.lock.json`; `--check` compares without writing and `--accept` takes a changed project. |
| `mizzen network sitemap [dir]` | Writes the organization's sitemap index; `--url <origin>` names the host and `--out <dir>` the folder. |
| `mizzen stale [dir]` | Lists pages whose covered files changed since they were reviewed. `--json`, `--fail` (exit `1` when any page is stale), `--changed <files…>`, and `--git-diff <base>` choose what counts as changed. |
| `mizzen stale mark <page…>` | Records a page's covered files as reviewed; `--all` marks every page. |
| `mizzen trace show <trace.json>` | Prints a recorded trace's task, snapshot, stages, statuses, and evidence references; `--json` prints the summary. |
| `mizzen trace search <trace.json>` | Filters events by `--stage`, `--file`, `--task`, and `--status`; `--json` prints the events. |
| `mizzen trace replay <trace.json>` | Checks the recorded order, input hashes, and results against an optional `--snapshot` and `--expect` trace. Writes and calls nothing. |
| `mizzen trace export <trace.json>` | Writes or prints only the authorized fields, with a file name derived from the trace hashes; `--out <dir>`. |
| `mizzen trace handoff <trace.json>` | Prints the state, changes, decisions, and remaining work for the next agent. |
| `mizzen urls check [dir]` | Compares every record page's URL with `urls.lock.json` and prints the new, changed, and removed records. Writes nothing; exits `1` on an error. `--format text\|json`. See [Stable URLs](/data/urls/). |
| `mizzen pack [dir] --topic <name> --budget <tokens> --out <file>` | Prints the context pack for one topic in `_data/context-packs.yml` to stdout, or writes it to `--out`. `--budget` overrides the topic's budget; without `--topic` the site's only topic is used, and a site with several lists them and exits `2`. Diagnostics go to stderr, so stdout stays clean Markdown. |
| `mizzen published-site attest <bundle> <provenance.json> [--key <private.pem>]` | Prints a detached attestation with build provenance and an allowlisted evidence manifest. |
| `mizzen published-site verify <bundle> <attestation.json> <trust-policy.json>` | Verifies the site bundle and its evidence offline against a local trust policy and prints a JSON report. Exits `1` if verification fails. |
| `mizzen published-site check --sitemap <url> [--domain <host>] [--redirects <file>]` | Fetches every URL in a sitemap or sitemap index and reports each page's status code, canonical URL, and redirect destination. `--domain` is the only host it may request; `--redirects` names a JSON map of expected sources to final addresses. `--format text\|json`; writes nothing and exits `1` on an error. |
| `mizzen readiness [built] --report <file> --badge <file> --compare <file> --min-overall <n> --min <section>=<n> --fail-on-unknown` | Scores a built folder against the [public readiness rubric](https://github.com/velella-sh/mizzen/blob/main/docs/readiness.md): structure, navigation, context, examples, verification, permissions, and maintenance, with weights, unknowns, located findings, and remediation. Writes a versioned JSON report whose digest verifies, an SVG or Markdown badge, and an optional comparison with an earlier report. Exits `1` on a failed critical rule, a failed threshold, or a failing report. |
| `mizzen examples record [dir] --date YYYY-MM-DD --commit <full SHA>` | Records per-fence results in `.mizzen-examples.json`. Requires `examples.pinned: true`. See [Pinned example results](/example-results/). |
| `mizzen graph [dir] [--from <id>] [--to <id>]` | Answers one query against the knowledge graph: a node's neighbors and the shortest path to another node, with the same JSON and node ids as the `query_graph` MCP tool. `--depth`, `--nodes`, and `--max-output` bound the answer; a bounded answer is `partial` and carries `--cursor`. `--allow` names the audiences the caller may read. |
| `mizzen references check <file\|-> [dir]` | Resolves a JSON array of stored block references (`{"version": 1, "page": "<source>", "block": "<id>"}`) against the site's current build. Prints one JSON array of resolutions; a reference is `resolved` with its current URL, `removed` when `blocks.lock.json` recorded it, or `unknown`. Exits `1` when any reference is not resolved. |
| `mizzen diff <a> <b>` | Compares two built folders by their manifests and prints the pages, files, and records that changed, the moved pages, and the URLs that stopped answering. `--base <ref>` builds a git ref and compares it with the current site. `--format text\|json\|markdown`; exits `0` unless `--fail-on removed-pages,broken-urls,render-only` finds one (`1`). See [Compare two builds](/site-diff/). |
| `mizzen verify [dir] --hash <hex>` | Hashes a built folder by the same rule the build used and compares it with `.mizzen/manifest.json` (or `--hash`). Exits `1` on a mismatch. |
| `mizzen versions snapshot <vN> [dir]` | Copies every current page and the navigation into a new `vN/` folder and prints the files it wrote. `--dry-run` prints the same list and writes nothing. A name that exists, an invalid name, or a version that is not newer is refused and nothing is written; exits `1` on a refusal and `2` on a usage problem. |
| `mizzen watch [dir] --out <dir> --theme <dir>` | Builds `dir` once, then rebuilds whenever a source or theme file changes. Changes are debounced and builds run one at a time, in order; an unchanged build is restored from `.mizzen/cache`. Ctrl-C stops the watcher. |

`--out` is resolved from the current working directory, not from the site root, for `build`, `dev`, `pack`, and `watch`; `dev`'s default is `<site>/.mizzen/dev` and `watch`'s is `<site>/.mizzen/watch`. `check` is the command to use in CI: it never touches `dist`. `pack` reads the site model and never the theme, so it needs no theme root.

`--as-of <YYYY-MM-DD|today>` (for `build`, `check`, `watch`, and `data quality`) sets the day the build pretends it is, and wins over the config's `asOf` key. `today` reads the system date once, at the command's edge, and prints it; the build itself never reads a clock, so the same data and the same as-of date give the same bytes.

`--workers <n|auto>` (for `build` and `check`) renders pages in `n` worker threads, each one loading the theme; `auto` is the CPU count minus one. The site written is byte for byte the one `--workers 1` writes, diagnostics included. The default is `1`: a small site would pay for threads it cannot use, so a large one opts in with `--workers auto`. A worker that fails renders its pages in the main thread and adds a `render.worker-failed` warning. There is no config key, because how many cores a machine has is a machine setting, not a property of the site.

The theme root is picked in this order:

1. `--theme <dir>`, resolved from the current working directory.
2. `theme.name` in `mizzen.yml`: a folder relative to the site root, an absolute path, or a package name resolved from the site and then from the current directory.
3. A `lateen` checkout beside this repository (`../lateen`), when it exists.

A page with no layout in its front matter or in `defaults` gets the layout `doc` from the CLI. A programmatic build has no default unless it passes `defaultLayout`.
