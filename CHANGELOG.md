# Changelog: @velella/mizzen

Releases of this package are tagged `v<version>`. Add a one-line fragment in `changelog.d/` in any pull request a user would notice; the release tool moves fragments here.

## Unreleased

## 0.2.7 — 2026-11-25

This release makes the engine a living source of truth for code, documentation, and agents: it shows what the product exposes that no page documents, runs the examples and records proof, ties each behavior to tests and ingested evidence, remembers why a decision was made, composes knowledge across repositories, proposes downstream tasks when a change lands, drafts evidence-first pages, and lets a consumer verify a published site offline. An existing `0.2.6` site needs no content migration; every new key, contract, and command is opt-in. The [upgrade guide](site/upgrade.md) lists the schemas and the compatibility result, and `release/scope.json` records the public acceptance case or test for each of the 100 features.

### Added

- Add opt-in executable documentation. Fences marked `test` can carry a stable id, a shared session, hidden setup and teardown, a file snippet, a runbook step, and expected stdout and stderr. `examples.execute` runs them during a build with a content-addressed cache, a bounded runner that denies the network and classifies time, memory, output, filesystem, and command violations, and a type-check against the imports' real exports. `mizzen examples lock` pins the runtime, packages, fixtures, and limits in `.mizzen-env.json`; `mizzen examples record` writes per-fence evidence with exit code and environment hash. Example status appears in `examples.json`, each page's `index.json`, and a verification proof. Existing sites that never opt in keep their bytes.
- Add public product surface coverage: a versioned adapter contract for symbols, commands, config keys, OpenAPI operations, data fields, and versions, with a source span on every item and an adapter rejected whole when its result is not the contract; built-in adapters read the package entry's exports, the running CLI's commands and flags, the config schema and resolver, the pinned OpenAPI document, the public data fields (a private field is never an item), and the declared versions; documentation evidence from links, inline code, directives, and file:line references distinguishes complete, partial, and missing documentation; `mizzen surface` reports the gaps with their kind, id, source, and introduction version, keeps a documented exclusion apart from a gap, compares two reports without a file rename counting as a regression, and exposes the counts and percentages by area in JSON, `mizzen check`, `surface.json`, and each page's `index.json`. See [Public surface coverage](/public-surface/). Tests: `test/surface-contract.test.ts`, `test/surface-adapters.test.ts`, `test/surface-coverage.test.ts`.
- Add product behavior contracts: authored `behavior` front matter with a stable id, title, normative statement, and per-entry source span; duplicate ids rejected with both locations; links to the public surface inventory, tests and expected outcomes, and public or pinned evidence; introduced/changed/deprecated/removed versions with a versioned query; supported, experimental, deprecated, and removed statuses with validated replacements; explicit os, language, and runtime environments; an evidence policy that leaves a claim without its required evidence `unverified`; drift for a changed signature, test, or evidence with the documentation and tests shown together; and a public `behavior.json` plus `behavior/index.html` matrix that withholds private behaviors and evidence values. Stable behavior references and the lookup shape for Decision Memory are documented. See [Product behavior contracts](https://github.com/velella-sh/mizzen/blob/main/docs/behavior-contracts.md). Tests: `test/behavior-contract.test.ts`, `test/behavior-report.test.ts`, `test/behavior-drift.test.ts`, `test/behavior-matrix.test.ts`, `test/behavior-cli.test.ts`, and the `behavior-contracts` acceptance case.
- Add decision memory: versioned decision records (ADRs) with an id, title, status, explicit date, and source are read and refused at their span when incomplete; the lifecycle keeps proposed, accepted, superseded, deprecated, and rejected with a supersession cycle refused; a decision links the APIs, behaviors, collections, and pages it affects and cites commits, pull requests, RFCs, and tests, marking an unresolved reference `unknown`; validity is by version or snapshot, and a "why" query returns the decision in effect at that version or snapshot with its rationale and rejected alternatives; the context compiler adds only the decisions in effect as active rules, and the same access policy covers the records and their citations. `mizzen decisions` reports the records and answers `why`; the `decisions` output writes `decisions.json` and a matrix page; `why_decision` answers over MCP. See [Decision memory](/decisions/). Tests: `test/decisions-parse.test.ts`, `test/decisions-lifecycle.test.ts`, `test/decisions-why.test.ts`, `test/decisions-context.test.ts`, `test/decisions-access.test.ts`, `test/decisions-e2e.test.ts`.
- Add explicit knowledge status: pages and records declare `unknown`, `unsupported`, `unverified`, `not-applicable`, or `out-of-scope`, with a scope limited to a surface, behavior, platform, or version, and a subject that declares nothing stays `missing` apart from all five. The status, scope, and public citations travel into the graph, the context packs, and the proofs; `mizzen knowledge` reports the counts and locations of unknowns, documentation gaps, and unsupported cases and compares two reports; a task criterion resting on an unknown or unverified claim is never proved; a private rationale or citation is redacted in public output; and one evaluation case answers a question whose evidence is missing. See [Explicit unknowns](/explicit-unknowns/). Tests: `test/knowledge-status.test.ts`, `test/knowledge-graph-pack.test.ts`, `test/knowledge-report.test.ts`, `test/knowledge-proof.test.ts`, `test/knowledge-eval.test.ts`.
- Pin external test, CI, and benchmark evidence by SHA-256 and evaluate page claims and behaviors offline.
- Query independent, locked knowledge snapshots across repositories and assemble attributable context offline: a versioned `federation.json` manifest of projects, namespaces, snapshot roles, and source locks that refuses a duplicate id or path; `knowledge.bundle.json`, one repository's graph, public surface, behavior contracts, and authorized evidence with a tool version and a SHA-256, in which private data is left out rather than redacted; `mizzen federation fetch`, which pins every bundle in `federation.lock.json` while a normal build reads only that lock and the local bytes; fully qualified project/snapshot ids, so two same-named nodes stay distinct; composition in which a cross-project edge exists only from an explicit reference and the graph and digest do not depend on retrieval order; `mizzen federation query`, one query that reaches a behavior, page, or evidence with namespaced citations; a pinned or compatible channel that selects a snapshot from the lock and version rules rather than publishing time, and reports a removed target instead of resolving elsewhere; `mizzen federation pack`, one shared budget with every omission attributed to its project; a cross-project evidence chain that preserves each link's digest; a missing optional bundle that yields a `partial` result while every known-good snapshot keeps its place; one access policy over the bundle, query, and pack, so a project the caller may not read never leaks through a node, an omission, or a name; and a project refresh that invalidates only the units that depend on it and equals a full recomposition. `mizzen federation`, the `federation` config key, `src/contracts/federation.ts`, and an offline three-repository fixture. Tests: `test/federation-compose.test.ts`.
- Detect semantic changes that affect declared consumers and prepare evidence-backed downstream tasks: a versioned `propagation.json` consumer manifest of surface, behavior, collection, page, symbol, decision, and evidence dependencies with a version policy and an approval policy, validated at its own JSON Pointer; a diff of two locked snapshots into versioned semantic events for surface, behavior, decision, and evidence changes, each with its source span and SHA-256, while an internal change that preserves the public surface emits nothing external; matching that selects only the consumers whose declared dependency changed; a preview of the downstream snapshots, pages, and task ids a release affects, before anything is published; compatible, breaking, and review severity against the consumer's version range; a task proposal with consumer-relative scope, executable acceptance criteria, change rationale, decision links, and only the evidence that repository is authorized to read, with the upstream source untouched; an approval policy under which a required approval holds a `pending-approval` receipt until an accepted approver is named; deterministic receipts that make reprocessing and an already-resolved impact a no-op while the earlier receipt stays retrievable; per-consumer `missing-bundle` and `permission` results that keep every successful consumer's result; `mizzen propagate check|diff|preview|propose|apply|receipt|verify`; `src/contracts/propagation.ts`, `src/propagation/`, two JSON Schemas, and an installed-package acceptance case. Tests: `test/propagation-contract.test.ts`, `test/propagation-e2e.test.ts`.
- Add coverage-driven authoring: every documentation gap becomes a registered authoring task that names the public surface item, its introduction version, and the evidence a draft must cite; a fixed rule set recommends a reference, guide, example, or runbook and records why; the evidence-first outline covers behavior, prerequisites, an example, limitations, and references and names every section that still needs evidence; the task and its context pack export for an external agent, and the returned draft is validated through one public parser; every normative claim must cite the surface, a behavior, or evidence, and an uncited claim, a dropped explicit unknown, a changed limitation, or a location conflict is refused before preview; a preview builds the page in a temporary copy and shows the HTML, the source diff, the citations, and the write gate, and the repository access policy plus an approval decide whether the page is written; verification checks examples against their recorded output, cited behaviors against the evidence policy, links, documentation coverage after a simulated merge, and the build, and prepares a pull-request proposal only with a proof, the remaining unknowns, and no publish or merge permission. A single-repository fixture traces an undocumented API from gap to task, draft, citations, example execution, proposal, and a merge that closes the gap. See [Coverage-driven authoring](https://github.com/velella-sh/mizzen/blob/main/docs/coverage-driven-authoring.md). Tests: `test/authoring-tasks.test.ts`, `test/authoring-page-type.test.ts`, `test/authoring-outline.test.ts`, `test/authoring-export.test.ts`, `test/authoring-citations.test.ts`, `test/authoring-unknowns.test.ts`, `test/authoring-location.test.ts`, `test/authoring-preview.test.ts`, `test/authoring-verify.test.ts`, `test/authoring-e2e.test.ts`, and the `coverage-driven-authoring` acceptance case.
- Add detached site attestations, Ed25519 signing, and offline verification of bundle files and public evidence against a consumer trust policy.

### Changed

- Publish versioned check reports from `_data/report-set.json`, with static run and comparison pages, trend data, and a public JSON endpoint. Collect doctor runs through `@velella/mizzen/reports`.
- Add a reproducible 0.2.6 compatibility check: the release comparison now defaults its baseline to the published `0.2.6` package, builds the compatibility site with that package and a candidate tarball, and reports URL, effective-configuration, CLI, contract-surface, and public-output differences in one review report; the published `0.2.6` package predates the page-head wiring, so only the head tags the candidate adds are normalized. A preliminary review is recorded in `fixtures/compat-0.2.6/`. Tests: `test/compat-0.2.6.test.ts`.
- Add `ComponentProps.inline`: true when a component was written as a text directive (`:name[label]{...}`), false for a leaf or container directive, an alert, or a component rendered with `renderComponent`. The Markdown stage marks a text directive's `<sl-component>` with `data-inline`. Tests: `test/render-component.test.ts`.
- Give the pages the engine generates a description: the blog archive and author pages, the API reference index, and each operation page now carry a `description` (the operation's or the document's own text, else a plain summary), so every page has one `description`, `og:description`, and `twitter:card`. Tests: `test/head-generated.test.ts`.
- Fix the page head: the build now prints Open Graph and Twitter tags, `og:image` for a page whose generated social image is written, a canonical link, and JSON-LD (`TechArticle`, `BreadcrumbList`, `ItemList`, a collection's `seo.jsonLd`) on every page, and a record's `seo` fields reach the head. `headMeta` was never called by the build; it is now the single owner of the head, so a page has one canonical link, one robots tag (a preview's `noindex` wins), and one description. The document title is the page's title, as before. Tests: `test/head-wiring.test.ts`.
- Update the docs site for Lateen 0.2.5: new pages [Lateen 0.2.5](/theme/) and [Presets and Theme Studio](/presets/), the site now uses the `mizzen` preset, and the upgrade, configuration, data API, and public fields pages mention what the theme adds.
- Add opt-in pinned example results. `mizzen examples record` captures dated per-fence evidence in `.mizzen-examples.json`, and builds expose it through `Page.examples` with stale detection and publish matching entries in `examples.json`. Existing sites keep their totals-only report and output bytes.
- Add `RecordPos.source` and `RecordPos.editable` to every collection record's position: the source the config names (a path, an `https:` URL, a package address, or a SQLite or NDJSON file) and whether `file` is a real local file the author can edit. A record read from a pinned download, a locked extraction, or a package keeps `.mizzen/data/<sha>` in `file` and now has `editable: false`; the NDJSON line is documented as a line of the stored result. Tests: `test/data-record-source.test.ts`.
- Add `renderComponent(name, props?, html?)` to `LayoutProps` and `ComponentProps`: a unit renders another component by name through the current registry, so `theme.overrides.components` apply, and the component's CSS sidecar and island join the page as if the content had used it. An unknown name is a `render.unknown-component` warning; units that render each other without end stop with `render.component-depth`. Both fields are always set by the engine. Tests: `test/render-component.test.ts`.
- Document how themes derive static data API links, including the deployment base, version policy, and publication rules, from the existing layout contract. Site builds are unchanged.

## 0.2.6 — 2026-11-19

This release makes agents first-class clients of the engine: versioned tasks, compiled context, recoverable MCP, atomic edits with proofs, tracing, evaluations, and readiness reports. An existing `0.2.5` site needs no content migration. The [upgrade guide](site/upgrade.md) lists the additions and the measured compatibility result.

### Added

- Add deterministic agent evaluations: versioned case and suite contracts with located validation problems; ten capability cases covering discovery, answer, context, edit, transaction, verification that is proved, verification that is fabricated, handoff, permission, and a conflict marked unavailable with its reason; a published five-component rubric with security as a critical, non-aggregate failure; per-case SHA-256 pins of the fixture, config, compiled pack, and recorded agent output; a runner seam whose default adapter is clock-free, offline, and replays recorded outputs while driving the engine's compiler, transaction writer, independent verifier, and handoff reader; a versioned report with a deterministic run id; baseline recording and comparison that marks a changed pin incomparable instead of a regression; a CI gate; `mizzen eval [suite] --format text|json --out --baseline`; an opt-in live adapter and scheduled workflow outside the engine; and an offline installed-package acceptance test. Tests: `test/evals-suite.test.ts`.
- Add human and agent interaction to tasks: one focused clarification question before any edit, recorded safe defaults with approval for risky ones, stage-scoped approvals, explained refusals with a recovery action, resumable checkpoints that never repeat an applied edit, public handoffs to a person or another agent without conversation history, feedback linked to the task and evidence, and expiry when the snapshot or approval policy changes. Tests: `test/interaction-e2e.test.ts`.
- Add the machine-readable `mizzen agent` CLI: `agent capabilities` reports task, pack, edit, verify, replay, and eval (with an explicit fallback for the unavailable eval), `agent schema` prints a command's input and output schemas and exit codes, and `agent task` registers from a file or stdin, previews and dry-runs without writing, runs idempotently with ordered versioned events and a cost/budget report, keeps JSON stdout separate from diagnostics, and resumes or cancels a paused task by id with a consistent conflict on a finished task. State lives under `.mizzen/agent/`; the installed-package smoke test exercises the whole journey with public JSON. Tests: `test/cli-agent.test.ts`.
- Add secure agent traces: a versioned schema with ordered events and parent references; safe input hashes and result references instead of bodies; links from context, edit, and verification events to the pack, patch, span, transaction, and diff; per-subtask token and call cost that agrees with the task budget; decisions, refusals, and approvals with a reason and policy, never chain of thought; nondeterministic timing separated from replay; search and summaries that link to evidence; an authorized export with redacted paths and credentials; bounded retention that keeps proof-critical events; read-only replay that reports result differences; a handoff for the next agent; and an offline installed-package replay that leaves file hashes unchanged. Tests: `test/trace-cli.test.ts`.
- Enforce a versioned least-privilege access policy: public read-only by default, semantic read restrictions for pages, blocks, collections, and fields, writes checked against both an allowed path and a scope with traversal and symlink refusal, named check-runner grants, per-capability approvals with stale-answer expiry, subtask delegation that can only narrow, network destinations limited to explicit stages, consistent redaction, and audit lines for every allow or deny. The policy reaches the graph and pack queries, edit apply, and every MCP read and edit tool; a policy is loaded with `--policy <file>`. Tests: `test/permissions-policy.test.ts`.
- Add `mizzen readiness`: scan a built folder against the public version 1.0.0 rubric across structure, navigation, context, examples, verification, permissions, and maintenance, with weights, prerequisites, located findings, remediation, and `unknown` for missing evidence. Write a versioned JSON report with a verifying digest, an SVG or Markdown badge, a comparison with an earlier report, and a gate over thresholds and critical rules. Add `mizzen check --agents` to score the staging build after a check. Reports drop private pages, absolute paths, tokens, and credentials before publication, and score `examples.evaluation` only from a matching `mizzen-readiness` suite, version, and build snapshot, including a real `mizzen eval --build <sha256>` report. Tests: `test/readiness-cli.test.ts`.
- Add task verification plans and version 2 proofs: every acceptance criterion maps to a check, fixture, and expected evidence, or to a human review that never passes automatically. Claims cite files, spans, records, checks, or reviews; missing evidence is named. Checks run with timeout, memory, path, and network limits. Verification reproduces the build hash, proves changes stayed in scope, verifies examples at their source span, and checks URLs, block references, and redirects before and after. `mizzen edit verify` consumes a proof plus public input in a fresh process, withholds success for failed, unrun, or missing evidence, and version 1 edit proofs still verify. Receipts bind the commit, tarball SHA-256, and CI result, and swapping the package or an input invalidates them. Tests: `test/verification-proof.test.ts`.
- Add versioned, content-addressed maintenance triggers: drift findings, stale pages, and data impact become idempotent tasks only when the snapshot and source changed. Tests: `test/maintenance-e2e.test.ts`.
- Add task proposals that carry goal, constrained scope, and acceptance, decide between a deterministic mechanical repair and an agent, and exclude any page, file, or write the site policy denies. Tests: `test/maintenance-e2e.test.ts`.
- Add budgeted maintenance context naming changed sources, affected pages, required checks, and every omission, so a model sees exact evidence before acting. Tests: `test/maintenance-e2e.test.ts`.
- Add external maintenance patches: validated against task, snapshot, scope, and policy, applied to text in memory only, refused when a source moved, and reported as a no-op when the change is empty or a person already made it. Tests: `test/maintenance-e2e.test.ts`.
- Add previews with the unified diff, required checks, affected published outputs, and a write gate that distinguishes dry-run, approval, allow, and deny without touching a source file. Tests: `test/maintenance-e2e.test.ts`.
- Add independent verification: every required check must pass, each claim must cite a changed file and a passed check, scope is proved, a version 2 proof is built and then verified again from public inputs. Tests: `test/maintenance-e2e.test.ts`.
- Add pull-request recipes as data with branch, title, body, evidence, impact, authorized files, and `publish: false`/`merge: false`; a later run updates the same open pull request instead of opening a duplicate. Tests: `test/maintenance-e2e.test.ts`.
- Add maintenance state that records a failure with stage and code, keeps the last good snapshot, source hashes, proposal, and pull request, and resumes only on an explicit retry. Tests: `test/maintenance-e2e.test.ts`.
- Add an end-to-end fixture where an API rename produces a task, a preview, one failed verification, a proved proposal, and a local recipe, with no network call and no merge. Tests: `test/maintenance-e2e.test.ts`.
- Add consistent behavior across MCP clients: a versioned adapter contract with located validation, capability detection from the `initialize` hello before any tool runs, explicit fallbacks (synchronous receipts, page offsets, propose-only editing) reported in `_meta.mizzen`, deterministic client configuration generated from one shared descriptor, environment references and redaction so no secret reaches a file, log, or trace, version compatibility with a clear upgrade error, and an installable client skill with a versioned manifest and SHA-256 checksum. Two client profiles are exercised through the public `mizzen mcp` entry point: the same reads and proposals, with the limited profile refused a write and paginated by offset. Tests: `test/clients-profiles.test.ts`.
- Add task-aware context compilation: a task contract becomes a ranked request, the knowledge graph selects entry points and closes their dependencies, and sourced fragments carry file, span, block or record id, and build snapshot. Tests: `test/context-e2e.test.ts`.
- Add fixed-budget packing with stable priority, whole-fragment admission, exact fragment/template/safety accounting, and omitted inputs explained as budget, permission, scope, or irrelevance. Tests: `test/context-e2e.test.ts`.
- Add per-criterion answerability with exact evidence shortages and concrete scope, approval, or evidence requests, plus deterministic pack diff, refill, cache refresh, and targeted invalidation. Tests: `test/context-e2e.test.ts`.
- Add `mizzen pack --task <file>`, which reads a task contract and `blocks.lock.json` and prints the compiled Markdown or JSON; private collection fields and denied principals never reach an entry, fragment, omission, or lineage report. Tests: `test/context-e2e.test.ts`.
- Add a versioned source and documentation knowledge graph: nodes and edges for pages, blocks, headings, links, includes, API operations, code symbols, snippets, collections, records, fields, transforms, joins, derived values, claims, evidence, checks, and lineage, each with its source span and stable identity. Tests: `test/graph-query.test.ts`.
- Add bounded graph queries for neighbors and the shortest evidence path, with snapshots, resumable partial results, audience redaction, and incremental refresh over page and collection units. Tests: `test/graph-query.test.ts`.
- Add `mizzen graph` and the `query_graph` MCP tool, which answer with the same schema and node ids. Tests: `test/graph-query.test.ts`.
- Add a recoverable MCP runtime: the handshake announces a contract version, task capabilities, and limits, and older clients keep the same core answers. Tests: `test/mcp-runtime.test.ts`.
- Add asynchronous pack, proof-verification, and task-replay operations with operation ids, progress measured in real work, cancellation at safe boundaries, bounded event queues, and recovery by operation id after a stdio disconnect. Tests: `test/mcp-runtime.test.ts`.
- Add stable snapshot-bound cursors to `search_docs` and `query_graph`, and a clear error for a cursor from another snapshot. Tests: `test/mcp-runtime.test.ts`.
- Make `apply_edit` idempotent with an optional key: the same key returns the same receipt, a different payload is refused, and a reconnect never applies the edit twice. Tests: `test/mcp-runtime.test.ts`.
- Add independent read, context, edit, and verify deadlines; machine-readable failures with code, stage, retryability, task, and source; and bounded, redacted responses that never carry a stack trace or a local path. Tests: `test/mcp-runtime.test.ts`.
- Pin every session to one site snapshot, signal when the site changes, and keep concurrent sessions' operations, receipts, and results apart. Tests: `test/mcp-runtime.test.ts`.
- Add deterministic multi-agent coordination: split a parent task into owned subtasks with distinct scopes, acceptance criteria, budgets, and dependencies; block overlapping writers before both start; lease a subtask's scope against one snapshot with owner-only renewal, release receipts, and lost-owner recovery that checks activity and state and never deletes a live edit. Schedule dependents only after prerequisite evidence, reject dependency cycles at split time, report duplicate work with reasons and an explicit merge or keep-separate decision, and aggregate only authorized per-subtask packs and proofs without mixing snapshots. Merge results in dependency order with stable ids so finish time never changes the diff, escalate unresolved conflicts to the parent or a human with both diffs and evidence instead of letting the last writer win, hand a subtask to a replacement with its checkpoint, lease, pack, check state, and applied transactions, and reconcile shared token and tool-call usage with the trace. The two-agent demo edits a guide and an example in parallel, rejects a deliberate overlapping claim, and produces the same files as a serial run. Tests: `test/coordination-demo.test.ts`.
- Add a versioned task contract and lifecycle: deterministic task, request, and snapshot identities; semantic scope validation before execution; executable acceptance criteria; independent context, tool-call, and time budgets; ordered state events with deterministic replay; expiry and revocation; explicit v0-to-v1 migration; and related-task discovery that redacts unreadable content. Tests: `test/tasks-e2e.test.ts`.
- Add atomic multi-file edit transactions: a versioned contract that pins the task, snapshot, patches, scope, invariants, and preconditions; span-safe combining and overlap reporting; all-or-nothing writes with hash-checked optimistic concurrency; semantic page, block, symbol, and record reservations; real-path and symlink boundaries; custom and JSON-schema invariants; content validation before activation; dry-run previews; actionable conflict reports; approved rebase onto a fresh snapshot; receipt-based rollback that preserves later independent edits; and proof and audit records written only after the whole transaction succeeds. Tests: `test/cli-edit-transaction-multi.test.ts`.

### Fixed

- Harden 0.2.5 data inputs and build reports: invalidate extraction locks for replaced sources while preserving unrelated entries, enforce stored API byte limits, prevent aggregate key collisions, accept valid SQL quoting, and fingerprint config rule values. Tests: `test/data-api-compat.test.ts`.

## 0.2.5 — 2026-11-19

This release makes data a first-class build input. Collections can read an API, a SQLite database, or NDJSON; rules
transform, join, and summarize them; a `public` allowlist decides what leaves the engine; and `data explain`,
`data transform-diff`, `data refresh`, and `mizzen reproduce` make a value, a rule change, and a build checkable. A
`0.2.4` site needs no content migration; every new key and command is opt-in. The
[upgrade guide](site/upgrade.md) covers the additions and the measured compatibility result.

### Added

- **API collection sources.** A collection whose `source` is an `https://` URL declares `records` and a `pagination`
  mode (`page`, `offset`, `cursor`, or `next`). `mizzen data fetch` reads every page, stores the combined list under
  `.mizzen/data/`, and pins the list and each page's URL, size, and SHA-256 in `mizzen.lock.json`; `--check` compares
  without writing. Limits, retries, allowed next-page origins, and an environment-variable credential are part of the
  config, and a failed page leaves the previous lock and store untouched. A build reads only the stored list and opens
  no connection.
- **SQLite and NDJSON collection inputs.** A collection can read a local `.sqlite`, `.sqlite3`, or `.db` file through
  one configured read query, or an `.ndjson`/`.jsonl` file of one JSON object per line. `mizzen data extract` writes
  the canonical result under `.mizzen/data/` and records its query id, row count, and SHA-256 in the lock; `--check`
  verifies without writing. A build refuses a missing, stale, or mismatched extraction instead of reading the source,
  and equivalent SQLite and NDJSON rows produce the same result bytes.
- **Collection transforms.** A collection's `transform.steps` rewrites records before validation and publication with
  `select`, `remove`, `rename`, `default`, `cast`, `normalize`, `map`, `date`, `unit`, `filter`, and `dedupe`. Steps run
  in order, an absent path does nothing, and `validate: before-and-after` checks the raw record too. `mizzen data
  transform [name] [dir] --limit <n> --json` previews the output and every finding without writing.
- **Collection joins.** A collection's `join` enriches its records from other collections on a key, with `inner` or
  `left` type, per-source `fields`, `onConflict`, `onNull`, `onMissingKey`, and `many` handling. The primary record keeps
  its id, order, and URL; a chain of joins is allowed and a cycle is rejected. A secondary file is part of the build
  key, so an incremental build matches a full one.
- **Aggregate collections.** A collection whose `source` is another collection and that declares `aggregate` publishes
  groups by one or more fields, with optional month or year buckets, `count`, `count-distinct`, `sum`, `average`, `min`,
  and `max` metrics, `where`, `missing`, and `empty` policies. Group ids and order are independent of source row order,
  and a summary is a normal collection for lists, records, feeds, search, and the API.
- **Public fields.** A collection's `public` allowlist names the dot paths every public output may publish. The record
  keeps every field internally, so transforms, joins, permalinks, and filters still read it; pages, twins, page JSON,
  collection indexes, search, feeds, changelog, and the static API apply the same view. `id` is always public, an
  absent policy publishes every field as before, and a public setting or template that names a private field fails
  with `data.public-reference`.
- **Field lineage.** `mizzen data explain <collection> <id> --field <path> --json` reports one field's versioned
  (`format: 1`) chain from its source hash and row, through schema renames, transform rules, joins, and aggregates, to
  every page URL and static API path that publishes it. `--public` prints permitted metadata only and refuses a field
  the collection's `public` policy does not allow. The command writes nothing.
- **Transformation rule diff.** `mizzen data transform-diff <baseline> <proposed> [dir] --collection <name>
  --format text|json --check` runs two configs over the same locked input and reports records added, removed, or
  changed by id, both values per field, the step that last wrote it on each side, and the affected outputs. Both
  configs and the input are hashed; unequal input hashes are a target error. Exit `0` is unchanged, `1` a change under
  `--check`, and `2` an invalid or incomplete comparison.
- **Scheduled data refresh.** `mizzen data refresh [dir] --collections <a,b> --report <file>` fetches the selected
  sources, validates the whole site and its quality rules, and writes one deterministic `mizzen-refresh/1` report with
  the stage, lock hashes, source status, record counts, and changed ids. A failed stage restores the previous lock
  bytes. The checked-in recipe runs the refresh with `contents: read`, builds and diffs the result, and lets only a
  final `contents: write` job commit `mizzen.lock.json` and `.mizzen/data/` and update one review pull request.
- **Diagnose and reproduce builds.** `mizzen build --diagnose` writes `.mizzen/build-report.json` with the input hashes,
  effective config and reference date, tool and theme versions, environment, and every publishable output hash.
  `mizzen compare <a> <b>` groups differences under inputs, config, tools, environment, or outputs and flags an
  unexplained output difference. `mizzen reproduce <report> [dir] --check` preflights a recorded build, and
  `--out` rebuilds without the cache and exits `1` when the output hash differs.

### Changed

- A collection source with `records` and `pagination` is fetched and locked as one record list; a source without them
  keeps the previous byte-for-byte behavior and is parsed by its extension.
- Transforms, joins, and aggregates run before a collection's schema, dates, derived values, lists, feeds, and API
  outputs, and their configuration is part of the build key. Changing a rule refreshes exactly the output it affects,
  and an incremental build writes the same bytes as a full one.
- `mizzen data fetch` and `data extract` are the explicit network and database commands. A build still opens no
  connection and reads only the content-addressed store and lock.
- Generated reports are versioned: lineage reports use `format: 1`, refresh reports use `mizzen-refresh/1`, and build
  reports use format `1`.

### Fixed

- Rule-diff diagnostics stay within the documented diagnostic ids, so a consumer that allowlists ids does not reject
  an incomplete comparison.
- A refresh that fails at fetch, validation, or quality restores the previous `mizzen.lock.json` bytes instead of
  leaving a partially updated lock.

### Compatibility

- `0.2.4` Markdown, front matter, configuration, navigation, CLI commands, and flags remain supported. A 0.2.4 site
  builds at the same URLs with its existing theme; the new keys and commands are opt-in.
- The release compatibility test builds the committed compatibility site with the published `0.2.4` engine and the
  `0.2.5` tarball in separate empty projects and compares every public file and canonical link. The 0.2.4 baseline is
  in `fixtures/compat-0.2.4/baseline.json`; the recorded result is in [the upgrade guide](site/upgrade.md).
- Node 24 or later is required, as in 0.2.4.
- Generated JSON reports the engine as `0.2.5`; consumers should read `version` from `@velella/mizzen`, not pin an
  older literal. Document-format versions are separate and did not change with the engine version.
- Builds still open no network connection. `data fetch`, `data refresh`, `published-site check`, and the network
  commands are explicit.

## 0.2.4 — 2026-11-18

This release turns migration, change review, and data operations into normal parts of a build. Existing `0.2.3`
docs and data sites need no content migration; the new features are opt-in. The
[upgrade guide](site/upgrade.md) covers the additions and the compatibility checks.

### Added

- **Site migrations.** `mizzen import plain|docusaurus|mkdocs|starlight|vitepress <dir>` inventories an existing
  site, previews the conversion, writes a Mizzen project, rewrites internal links, and reports per-file and per-block
  accuracy and coverage. Manual items are tracked, `--fail-on-manual` gates CI on them, and a preview cannot leave a
  source path outside the generated project. Docusaurus versions, locales, and `static` files; MkDocs Material
  admonitions, tabs, and snippets; Starlight autogenerated sidebars and locales; and VitePress `base` and `rewrites`
  are carried over, with a bilingual and a subpath fixture proving the result builds.
- **Stable block ids.** A declared `{#id}` or a content-derived id is carried through HTML (`data-block`), Markdown
  twins, `blocks.lock.json`, and the source map. A block keeps its id after edits, reordering, heading changes, and a
  move to another page; a previous heading anchor stays an alias, and a duplicate id, a removed block, or a link to a
  removed block is reported with its source position. `mizzen build --update-blocks` writes the lock.
- **Semantic change review.** `mizzen diff` matches blocks by their stable id, ignores whitespace and shifted line
  numbers, and reports headings, code and its language, table cells, link and image destinations, record values,
  pure moves, edits after a move, and uncertain matches. Every change carries its before and after source span, and
  `--change-type` filters one kind. JSON reports `schemaVersion: 1`.
- **References that survive renames and moves.** A stored reference names the page's source path, the block id, and
  the format version. `resolveReference` reaches the block's current URL after a permalink change or a block move,
  reports a recorded removal separately from an unknown id, and works in the site, `get_block_source --block`,
  `mizzen pack`, and `mizzen references check` for a batch.
- **Collection schema versions.** A collection records its schema version; an incompatible field change is diagnosed
  and can fail the build, a migration is previewed before it writes, and older data can be upgraded through a rename
  and a type change while the public output remains stable.
- **Data quality rules and snapshots.** Configurable rules report missing fields, coverage and record-count drops,
  outliers, key numbers outside their thresholds, and stale sources against the build's as-of date. Exceptions are
  documented and dated, severities follow the CI policy, and the JSON report groups findings by collection and rule.
- **Record lifecycle.** Records can be retired, replaced, merged, or restored under one collection policy, with
  earlier URLs kept, and the sitemap, search, feeds, API outputs, and relation links following the replacement.
- **Data change impact.** Before publishing, a record change lists every page, list, feed, and API output it affects
  and why, and the prediction is compared with the real build diff; output published outside the predicted scope is
  flagged.
- **Pull request previews and rollback.** `mizzen build --preview-canonical` publishes a preview under its own base
  with `noindex`, provenance, a diagnostics report, a diff against the latest public build, and a manifest. A preview
  bundle carries its base and build hash, and the local host swap-and-rollback recipe is tested.
- **First project samples.** `mizzen init --starter` ships a technical catalog, a periodic report, and a mixed
  Markdown/data sample, each with a guide; the release smoke test builds all three from the installed package.
- **Measured build performance.** A repeatable benchmark records time and peak memory for 1,000- and 10,000-page
  sites in cold, warm, one-record, and search cases; `docs/performance.md` is generated from the saved run. `mizzen
  build --report` names each rebuilt page, the changed input, and the shortest dependency chain, `--workers` renders
  the same bytes with one or more workers, and a budget gates time, memory, and index size.
- **Text directives.** An inline `:name[label]{key=value}` becomes the theme component of that name, with the label
  as its children, so a term link or symbol reference sits inside a paragraph the way a block directive sits between
  them. A name the theme does not draw still reaches it, and the render step reports an unknown one as before.
- **Theme overrides.** `theme.overrides.layouts` and `.components` name site modules relative to the site
  root; each replaces one theme unit while every other unit keeps the theme's. A replacement may add a `<file>.css`
  sidecar beside it. A missing file, a path that leaves the site, or a name the theme does not have is an error rather
  than a silent fallback.

### Changed

- The blog, OpenAPI reference, code annotations, and docs version routing now run in the ordinary build: `blog`
  publishes post, archive, author, pagination, and Atom routes; `apiReference.source` writes an index and one
  searchable page per operation with navigation, twins, and sitemap entries; `annotations={…}` reaches the theme in
  one `data-code` attribute and `mizzen check` reports a bad entry at its fence; and `_data/versions.yml` serves the
  default release at the unprefixed URL while every versioned URL stays reachable.
- Imported component syntax from Docusaurus, Starlight, and VitePress is converted to Markdown instead of being left
  for the build to reject.
- Internal links in imported projects name the page's destination URL under the source site's base and content
  root, so a migrated site serves the same links.

### Fixed

- A removed block's links are reported once per inline link fragment, with the referring file and line, instead of
  once per page.
- A site-download preview writes one folder with its manifest, so a base-path preview and its rollback use the same
  bytes.
- Data quality baselines stay intact when config or collection loading fails, and a data migration source outside the
  site is refused on every platform.

### Compatibility

- `0.2.3` Markdown, front matter, configuration, navigation, CLI commands, and flags remain supported. A 0.2.3 site
  builds at the same URLs with its existing theme; new features are opt-in.
- The release compatibility test builds the published `0.2.3` fixture with the `0.2.3` engine and the `0.2.4`
  tarball in separate empty projects and compares every public file and canonical link. See
  [the upgrade guide](site/upgrade.md) for the recorded result.
- Generated JSON reports the engine as `0.2.4`; consumers should read `version` from `@velella/mizzen`, not pin an
  older literal. Document-format versions are separate and did not change with the engine version.
- Builds still open no network connection. `mizzen published-site check`, `network`, `data fetch`, and the new
  migration commands are explicit.

## 0.2.3 — 2026-11-18

This release makes a site's claims checkable after publishing, connects records across projects, and adds
authoring features for content that a docs team repeats. An existing docs or data site needs no content migration;
everything below is opt-in. The [upgrade guide](site/upgrade.md) covers the optional additions and the one
compatibility fixture.

### Added

- **Published-site checks.** `mizzen published-site check --sitemap <url>` fetches every URL a published sitemap
  lists and reports its status, canonical URL, and redirect destination as text or JSON. `--domain` limits the
  hosts it may request and `--redirects` supplies the expected final address for each old path. The check is a
  recipe for CI; a build still opens no network connection.
- **Network sitemap discovery.** `mizzen network sitemap` writes a sitemap index for the public projects in a
  `network.lock.json`, and the root `robots.txt` can point at it. Projects outside the lock, duplicate entries,
  and an index that points at itself are refused.
- **Cross-site record links.** A link written as `[[project:collection/id]]` resolves to the record's current page
  from the locked project inputs, so a renamed record does not require rewriting every referring page. A removed
  record and an unknown id name the referring file and line. No build request is made.
- **Record relations.** A list of ids in a field named by `references` resolves to the related records in record
  templates and list queries, in declared order. Changing a related record invalidates the pages, lists, feeds,
  and JSON that show it, and an incremental build gives the same bytes as a full build.
- **Report archive.** A run is identified by its configured fields and pinned inputs, the latest and archived
  report views keep stable URLs as later runs are published, and an earlier report can be rebuilt from its locked
  inputs. A filterable gallery shows the runs with their dates and commits.
- **Claim evidence.** A collection can name an `evidence` field whose claims map values to sources. The source is
  rendered beside the value with `:evidence[…]`, published with the same id and URL in the page JSON, and
  validated with the record. Private fields never reach an output.
- **Documented command checks.** A `test` fence meta says which code blocks are runnable examples. The
  `examples-report` output records each result, a failure points at the fence's file and line, and
  `examples.failOnFailure` makes `mizzen check` exit 1. A recipe wires the report into CI.
- **Page tools.** A page selects a browser tool with `tool:` front matter; the `page-tools` output copies it to the
  page's site-relative path and the theme receives the asset URL. A page without `tool:` loads no tool.
- **Blogs.** The `blog` config block plus post front matter writes post, archive, and author routes, pagination,
  search metadata, and an Atom feed. It never implies a blog from a folder name.
- **API reference.** A pinned OpenAPI document builds searchable, stable operation pages with navigation and
  source-position diagnostics. The input is a file in the repository; the build reads nothing else.
- **Code annotations.** `annotations={…}` on a code fence attaches notes to exact source lines. The notes are
  accessible HTML, keep their source positions, and stay byte-for-byte in the Markdown twin.
- **Code snippets.** A fence or include can read a line range from a source file, with the exact origin of every
  line and a diagnostic for a missing file or range. A change to the source rebuilds its consumers.
- **Shared content.** `::include` accepts parameters, nests, and reports the file and line of the fragment and the
  call site. A change to a fragment invalidates every page that includes it.
- **Math.** Inline and block math are rendered to deterministic MathML through the same source positions,
  diagnostics, and Markdown twins as other text; no runtime, stylesheet, or font is downloaded.
- **Documentation versions.** `mizzen versions snapshot <vN>` copies the current pages and navigation into a `vN/`
  folder, refuses a name that exists or is not newer, and writes nothing with `--dry-run`. Default routing and the
  existing versioned URLs are unchanged.
- **Component imports.** Docusaurus MDX, Starlight MDX/Markdoc, and VitePress containers and Vue components convert
  to readable Markdown or HTML, with a report for every pattern that has no exact equivalent. No Vue or MDX is
  executed.
- **Plugin contract.** A content validator, a Markdown transform, and custom outputs can be declared in
  `mizzen.config.ts`. Plugins declare the version, settings, and files they read, so a cached build misses when one
  changes; executable examples and a compatibility test pin the hooks.
- **API contract checks.** A page that cites a public TypeScript symbol or member is compared with the source.
  `drift.json`, `mizzen check`, and `mizzen doctor` report a changed signature, a removed symbol, or an unchecked
  claim; the config's `drift` key chooses whether a failure warns or fails.

### Fixed

- Published-site checks stop at off-domain redirects, reject non-2xx redirect destinations, and report malformed
  redirect locations instead of throwing.
- OpenAPI reference reading reports cyclic YAML aliases instead of overflowing the stack.

### Compatibility

- `0.2.2` Markdown, configuration, navigation, CLI commands, and flags remain supported. New features are opt-in:
  a site without their keys builds the same pages at the same URLs.
- The release compatibility test installs the published `0.2.2` and the release tarball in separate empty
  projects and builds the same 0.2.2 fixture with a fixed render fixture. All 197 public files, every canonical
  link, `_redirects`, and the sitemap URLs match; the only normalized value is the engine version stamp in
  `agent.json`. See `fixtures/compat-0.2.2/README.md`.
- The same fixture builds with the published `@velella/lateen@0.2.2` theme. Canonical links, theme assets, the
  Mermaid diagram, and redirect targets keep the configured base path.
- Existing CLI commands and flags are unchanged; new commands and flags are listed in [Command line](site/cli.md).
  Existing schemas gain optional fields, and the package exports gain optional contract types.
- Generated JSON reports this engine as `0.2.3`; consumers should read `version` from `@velella/mizzen` rather
  than pinning a literal. Document-format versions are separate.
- Follow the [upgrade guide](site/upgrade.md) before enabling the new authoring or publishing features.

## 0.2.2 — 2026-11-17

This release extends data publishing and adds tools for comparing builds, reading a site through MCP,
and finding stale documentation. Existing docs sites need no content migration; see the
[upgrade guide](site/upgrade.md) for optional additions and a collection migration example.

### Added

- **Collection feeds** publish Atom, RSS, and JSON Feed from declared collections, with stable entry ids,
  selected fields, and per-page alternate links.
- **Social share images.** `social.template` draws a 1200 by 630 PNG per page from an SVG template and
  declared fonts. Open Graph metadata points at it; rendering is deterministic across operating systems.
- **Data SEO.** Collection `seo` maps record fields to titles, descriptions, canonicals, `noindex`, dates,
  and JSON-LD. Record and list pages get structured data, real translations get hreflang links, and large
  sitemaps split into an index and per-collection files.
- **Recorded snapshots.** `mizzen data snapshot`, `data fetch`, and `data verify` pin or check a collection's
  source in `mizzen.lock.json`. `:snapshot[…]` displays provenance; raw JSON, CSV, and checksums publish
  downloadable data, with `raw.private` exclusions or `raw: false`.
- **Dated data.** `asOf` and `--as-of` set an explicit reference date; `dates.calendar` chooses Gregorian or
  Jalali formatting. Partial dates preserve their precision, date formats support English, Persian, and
  Arabic, and derived counts and bands use the reference date rather than the clock.
- **Calendar feeds.** `calendars` publishes deterministic RFC 5545 files, optional grouped calendars,
  reminders, per-record downloads, and calendar links for themes. Feed `window.days` selects entries in
  an explicit as-of window; independent parser tests check the calendar files.
- **Versioned static data API.** `api` publishes selected collections and fields as JSON, NDJSON, record
  files, schemas, and OpenAPI, with optional CORS/cache headers. Multiple versions can coexist with
  deprecation metadata; `mizzen api check --against` detects removed collections, fields, versions,
  and changed field types. A size budget warns without truncating output.
- **Recorded data history.** `mizzen data changes` lists pending events, `--write` appends them to
  `data-changes/<collection>.jsonl`, and `--check` detects unrecorded changes. Collection `changelog`
  selects fields and labels; a first import is one event. History becomes a read-only collection, and
  `:::changes`, optional history pages, and feeds display it using the data's snapshot date.
- **Several projects under one domain.** `network`, `network.lock.json`, and `mizzen network
  check|update|sitemap` provide pinned project metadata, cross-project links, shared search, and a sitemap
  index without making one build depend on another project's availability.
- **Analytics and verification.** Optional `analytics` settings add a deferred provider script and
  outside-origin reporting; `verify` adds search-engine ownership tags or files.
- **Stale page detection.** `covers` front matter, `mizzen stale mark`, and `docs-review.lock.json` record
  reviewed files. `mizzen stale` compares their contents without git history, a clock, or network access.
  Checks, page JSON, the theme, MCP, and a pull-request recipe expose stale state and changed files.
- **`mizzen mcp`** serves search, pages, exact source spans, diagnostics, packs, and records over stdio.
  It is read-only unless `--allow-edits` enables proof-backed edits; `--print-config` prints client setup.
- **`mizzen diff`** compares built folders or `--base <ref>` as text, JSON, or Markdown: added, removed,
  changed, and moved pages, section changes, broken URLs, files, records, and pending history events.
  `--fail-on` selects failures; a recipe comments on pull requests.
- **Theme starters.** `mizzen init --starter` copies a theme's starter into an empty folder, `--list`
  lists starters, and `--lang` selects optional languages.
- **Data-site documentation and example.** The quick start and references cover collections, templates,
  lists, search, feeds, SEO, social images, stable URLs, snapshots, dates, calendars, the API, history,
  and the theme contract. The agent Skill includes record editing and URL-lock workflows.

### Changed

- **Incremental data builds** track record-level dependencies and cache renders by record and referenced
  data. Editing one record re-renders its page and affected lists; `dev` and `watch` report reuse.
  Layouts that read unrelated records' fields without a list dependency are outside that cache contract.
- **Bounded build memory** releases rendered pages and written output files as the build progresses.
  Shared hreflang/sitemap lookups reduce repeated work; search indexing, time, and memory have measured
  budgets, and the performance page is generated from benchmark results.
- **CI and release checks** separate correctness, coverage, and scheduled performance work. Package smoke
  tests run on Linux, macOS, and Windows and exercise installed tarballs, deterministic data builds,
  verification, self-diff, MCP, and contract imports. Tags trigger provenance-enabled npm publishing
  only after verification and the full benchmark; prerelease suffixes use `next`, not `latest`.
- **Published contracts and schemas** include the new publishing, calendar, network, analytics, and stale
  types. A tarball listing test checks every schema and each schema reference in the docs.

### Fixed

- Collection Atom feeds include an author, and generated links do not advertise outputs that were not written.
- MCP edits have their own call timeout rather than inheriting the shorter read-tool timeout.
- CLI help, README command tables, documentation, and doctor guidance agree on the data, network, diff,
  and stale-page commands; the changelog configuration describes its label properties.

### Compatibility

- `0.2.0` and `0.2.1` Markdown, configuration, navigation, CLI commands, and flags remain supported.
  New publishing features are opt-in; adding the engine does not turn `_data` files into collections.
- The compatibility test compares all 594 docs-fixture HTML files against the actual `0.2.0` engine
  using a fixed render fixture. There are no intended HTML differences; theme appearance is tested separately.
- Existing schema files and fields remain available. Generated documents that carry an engine version
  now report `0.2.2`; consumers should read the exported `version`, not pin an older literal.
  Document-format versions are separate and do not change just because the engine version changes.
- Existing `changes.xml` and `changelog.xml` feeds retain their shapes. Data locks without snapshots
  remain valid. Commit the lock files of any new features you enable, and review published data fields.
- Follow the [upgrade guide](site/upgrade.md) before enabling collections or other publishing features.

## 0.2.1 — 2026-11-16

This release adds data sites: a collection of records read from a data file, validated, and built into pages, lists,
search, and URLs that do not move. The data contract is exported from `@velella/mizzen/contracts`; a theme can type
against it.

### Added

- **Collections** read records from a `_data` YAML, JSON, or CSV file, an installed npm package, or a locked HTTPS URL,
  with the position of every record and field, size limits, and `mizzen data fetch [--check]` with `mizzen.lock.json`.
  `:data[path]` and `::data-table` show data inside an ordinary page, and the cache and dependency graph track which
  pages read which data.
- **Data validation** checks each record against a JSON Schema and points at the failing field with a suggested fix,
  and checks unique ids, references between collections, and date fields. `onInvalid` decides whether a bad record
  stops the build, and the findings appear in `check` and `doctor`.
- **Search over data** writes per-collection `search` metadata, filters, sort keys, and aliases into the Pagefind index,
  `search-facets.json` with the search results URL parameters, and a compact `data/<name>.index.json` that is split
  into chunks when large.
- **Stable URLs** build slugs from fields (`{name|slug}`), resolve collisions with `disambiguate`, and keep
  `urls.lock.json`. A changed URL is an error until `mizzen build --update-urls` accepts it and writes a redirect;
  `aliases`, `onRemoved`, `urls.json`, and `mizzen urls check` cover earlier addresses and removed records.
- **Named views** build extra pages of one record from their own templates, kept out of navigation, search, and feeds.
- **List pages** turn an ordinary page into a filtered, sorted, grouped, and paginated list of a collection's
  records with `list` front matter: a reference date instead of the clock, one page per group value, `:count`
  on ordinary pages, `LayoutProps.list`, and a Markdown twin for every page.
- **Data pages** build one page per record from a collection's Markdown template: `:field[…]`, `:::if`,
  `:::each`, and `:::records` directives, front matter and URL patterns filled from fields, Markdown fields,
  per-language pages, collection navigation, `record:` links, data-file edit links and agent instructions, and
  span edits that refuse to make a record unparseable or invalid.

## 0.2.0 — 2026-11-13

This release makes the engine's claims checkable: the CLI reports what it actually does, an agent edit is
committed with its proof and audit record or not at all, trust and drift come from the build that wrote
the page, incremental work reuses only inputs it can prove unchanged, and a task pack explains every
selection, omission, and token it spent.

### Added

- **`mizzen doctor`** checks the config, content, output paths, runtime, and toolchain, and reports each
  check independently, including SARIF output and `--format json`.
- **`mizzen pack --request`** compiles a versioned task request from a file or stdin: task kind and
  intent, include/exclude/locale/version constraints, required references, and a hard token budget.
  Packs publish selection, omissions, source positions, trust evidence, and token accounting.
- **Machine-readable edit results** for `edit apply` and `edit verify` (`--format json`), including
  refusals, the failed check, and the paths a proof covers.
- **An edit provenance ledger** (`<patch>.audit.jsonl`) and an atomic source + proof + audit commit, so
  a failed step never produces a successful provenance record.
- **Same-build trust and drift evidence** in `site.data` for every page, with explainable levels,
  reviewer coverage, signal provenance, exact source spans, and explicit unknown/unavailable states.
- **Incremental builds** keyed by config, content, navigation, theme, outputs, and engine version, with a
  per-page Markdown cache, a dependency graph, a deterministic invalidation plan, and bounded worker
  scheduling. A cache miss, corrupt entry, or site code file falls back to a full build.
- **`mizzen watch`** coalesces bursts losslessly, survives watcher failures, and follows renames and
  atomic saves.
- **A portable Agent Skill** in `skills/mizzen`, installed with `npx skills add velella-sh/mizzen`, so a
  compatible coding agent has the engine's pipeline, contract, and edit workflows at hand.

### Changed

- CLI help, the README, and generated `AGENTS.md` guidance list only commands that exist.
- A packed install no longer inherits a `lateen` checkout beside the source tree.
- Example execution is isolated with resource limits, and skipped or unrun examples no longer count as
  passing evidence.
- Cache writes and audit appends are concurrency-safe; abandoned locks are reclaimed only when their
  owner is gone.

### Fixed

- Includes, theme assets, edit writes, and proof paths are confined through real paths, including
  symbolic links.
- Malformed trust counts, review evidence, drift severities, version bounds, token estimates, and
  diagnostic fields are reported instead of clamped or silently accepted.
- Git-history evidence, proof verification, worker rendering, and pack input have explicit bounds.
- Version bounds are compared without numeric overflow, and pack budgets honour estimator margins.
- Review lookups read the repository state once per build instead of once per page: on the 594-page
  fixture the trust pass fell from 7.7 s to about 0.2 s, and a cold build from 10.3 s to about 3.3 s.

### Compatibility

- The CLI commands and flags from 0.1.0 keep working. `--allow-unchecked` is required only for a patch
  that carries neither `expected` nor `beforeHash`.
- Generated JSON now carries the engine version `0.2.0`. Consumers that pinned the literal `0.1.0`
  string, including the old hard-coded engine check in the test suite, should read the exported
  `version` instead.
- The trust, drift, pack, and edit JSON documents gained fields; existing fields keep their names and
  meanings. A consumer that validates against the bundled schemas should update to the 0.2.0 schemas.

## 0.1.0

First release: the `mizzen` CLI and library, compiled to JavaScript with type declarations, plus the JSON schemas.
