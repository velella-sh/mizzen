# Changelog: @velella/mizzen

Releases of this package are tagged `v<version>`. Add a one-line fragment in `changelog.d/` in any pull request a user would notice; the release tool moves fragments here.

## Unreleased

- **`mizzen diff <a> <b>`** compares two builds: pages added, removed, changed (by section), and moved, URLs that stopped answering, changed files, and changed records, as text, JSON (`schema/site-diff.schema.json`), or a pull request comment. `--base <ref>` builds a git ref for you, and `--fail-on` sets what exits `1`. A GitHub Actions recipe is in `recipes/site-diff.yml`.

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

