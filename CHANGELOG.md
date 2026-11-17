# Changelog: @velella/mizzen

Releases of this package are tagged `v<version>`. Add a one-line fragment in `changelog.d/` in any pull request a user would notice; the release tool moves fragments here.

## Unreleased

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
