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
  api check [dir]           Fail when the data API breaks a consumer of --against <built folder|git ref>
  build [dir]               Build the site into --out (default: dist)
  check [dir]               Build to a temp folder and print diagnostics only
  data fetch [dir]          Fetch and pin HTTPS collection sources (--check verifies only)
  data changes [name] [dir]  List a collection's pending history events (--write appends, --check fails on any)
  data verify [dir]         Compare the lock's record of each collection with its data; read-only
  data quality [dir]        Report records that fail the config's quality rules (--json, --write, --as-of)
  data snapshot <name> [dir]  Record the last commit and date of a file collection in the lock
  data schema [dir]          Report the fields each schema added or removed since its recorded baseline
  data migrate [name] [dir]  Preview the records a schema's renames would migrate; read-only
  dev [dir]                 Serve the site, rebuild on change, and reload the browser
  diff <a> <b>              Compare two built folders, or --base <ref> a git ref with the current site
  doctor [dir]              Check the config, content, output paths, runtime, and toolchain
  edit apply <patch.json> [dir]
                            Apply a span patch to its source file and record a proof
  edit verify <proof.json>  Check an edit proof against the site and rerun the doctor
  import <name> <dir>         Preview a migration; --out <dir> writes it, --fail-on-manual gates on manual items
  init [dir]                Start a site from a theme starter: --starter <name> copies it, --list names them
  mcp [dir]                 Serve the site to an AI client over MCP on stdio (read-only; --allow-edits adds apply_edit)
  network check <file>      Check the shared network file: ids, paths, titles
  network update [dir]      Fetch the network and write network.lock.json (--check, --accept)
  network sitemap [dir]     Write the organization's sitemap index (--url <origin>, --out <dir>)
  pack [dir]                Print one context pack for a topic or an ad-hoc request, to stdout or --out
  published-site check      Check a published site from --sitemap <url>: status, canonical URL, redirects
  stale [dir]               List pages whose covered files changed since review (--json, --fail, --changed <files…>, --git-diff <base>)
  stale mark <page…>        Record a page's covered files as reviewed (--all for every page)
  urls check [dir]          Compare record page URLs with urls.lock.json
  verify [dir]              Check a built folder against the hash in its manifest
  versions snapshot <vN> [dir]
                            Copy the current pages and navigation into a new version folder
  watch [dir]               Rebuild the site whenever a source or theme file changes

Options:
  --out <path>         Output folder: build (default: dist), dev (default: .mizzen/dev), watch (default: .mizzen/watch), import (the generated project); pack writes a file here instead of stdout
  --theme <dir>        Theme root folder (layouts/, chrome/, components/)
  --format <format>    text, json, or sarif (check and doctor; default: text); text, json, or markdown for diff; text or json for data schema, edit apply, edit verify, urls check, and published-site check; markdown or json for pack
  --sitemap <url>      Sitemap or sitemap index URL for published-site check
  --domain <host>      The one host published-site check may request (default: the sitemap's host)
  --redirects <file>   Redirect map for published-site check: a JSON object from a source address to its final address
  --hash <hex>         Expected build hash for verify (default: the manifest's)
  --site <dir>         Site root for edit verify (default: .)
  --doctor             Rerun the doctor for edit verify
  --port <number>      Port for dev (default: 3000; 0 picks a free one)
  --host <host>        Host for dev (default: 127.0.0.1)
  --as-of <date|today> The date the build pretends it is, YYYY-MM-DD (build, check, watch, data quality); today reads the system date once. Wins over the config's asOf
  --workers <n|auto>   Render pages in n worker threads; auto is the CPU count minus one (default: 1)
  --check              For data fetch: compare with mizzen.lock.json without writing
  --allow-dirty        For data snapshot: record the last commit although the file has uncommitted changes
  --json               For data quality: print the findings and scopes as JSON
  --write              For data quality: record the current data as data-quality.json
  --update-urls        For build: accept changed record URLs and write urls.lock.json
  --request <file|->   Versioned JSON context request for pack; - reads stdin
  --topic <name>       Topic for pack (default: the site's only topic); not with --request
  --budget <tokens>    Token budget for pack, overriding the topic's; not with --request
  --against <x>        For api check: a built folder or a git ref holding the API consumers rely on
  --base <ref>         For diff: build this git ref and compare it with the current site (one dir)
  --fail-on <kinds>    For diff: exit 1 on removed-pages, broken-urls, or render-only (comma-separated)
  --fail-on-manual     For import: exit 1 while a manual item has no recorded decision
  --allow <ids>        For import: comma-separated manual-item ids recorded as reviewed, with --fail-on-manual
  --max-entries <n>    For diff --format markdown: table rows before "N more" (default: 50)
  --link-base <url>    For diff --format markdown: link page URLs under this base
  --allow-edits        For mcp: also offer apply_edit, which writes a patch to source with a proof
  --print-config <c>   For mcp: print the configuration for claude-code, claude-desktop, cursor, or vscode, and exit
  --starter <name>     For init: the theme starter to copy into the folder (default folder: .)
  --list               For init: print the theme's starters with their titles and descriptions
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
| `mizzen api check [dir] --against <folder\|ref>` | Builds the site and compares its data API with the one at `--against`, a built folder or a git ref; exits `1` when a collection, a field, or a version is gone or a field changed type, and prints the file, the field, and a fix. Added fields pass. |
| `mizzen build [dir] --out <dir> --theme <dir>` | Builds `dir` (default `.`) into `--out` (default `dist`). Prints diagnostics as text. A build with an error still writes the site and exits `1`. |
| `mizzen check [dir] --format text\|json\|sarif --theme <dir>` | Builds into a temporary folder, prints only the diagnostics in the chosen format, and removes the folder. Exits `1` on an error. |
| `mizzen data changes [name] [dir] --write --check` | Lists what changed in a collection since the state in `data-changes/`; `--write` appends the events, and `--check` fails when the data changed without an entry. |
| `mizzen data fetch [dir] --check` | Fetches every `https:` collection source, stores its bytes under `.mizzen/data/`, and writes `mizzen.lock.json`; `--check` compares without writing. A source that is new, changed, or over its limit is a failure. |
| `mizzen data quality [dir] --json --write` | Checks the config's `quality` rules against the collections: a record missing a field, a field's coverage dropping more than `maxDrop` percentage points, or a collection losing more than `maxDrop` records since `data-quality.json`. `--write` records the current data as that baseline; `--json` prints every finding. Exits `1` on a diagnostic or a finding the policy marks as an error. |
| `mizzen data snapshot <name> [dir] --allow-dirty` | Records the last commit that touched a file collection, and its commit date, under `snapshots` in `mizzen.lock.json`; refuses a file with uncommitted changes unless `--allow-dirty`. See [Recorded snapshots](/data/snapshots/). |
| `mizzen data schema [dir] --format text\|json` | Compares each collection's schema with the one its snapshot recorded in `mizzen.lock.json` and names the top-level fields it added or removed, with both versions and the schema file; a collection with no recorded schema is skipped. Read-only; exits `1` on a config, lock, or schema error. See [Recorded snapshots](/data/snapshots/). |
| `mizzen data migrate [name] [dir]` | Previews moving each record to the current schema: it applies the collection's `schemaRenames`, validates every record, and prints a sample of the migrated records and each rejected one with its source line. Writes nothing; exits `1` on a config, schema, or source error. See [Recorded snapshots](/data/snapshots/). |
| `mizzen data verify [dir]` | Compares each collection with the lock and prints the first differing record with its source position; exits `1` on a difference and never writes. |
| `mizzen dev [dir] --port <number> --host <host> --theme <dir>` | Builds `dir`, serves the output with pretty URLs, watches the source and theme, rebuilds on change, and reloads the browser over Server-Sent Events. The reload script is added to HTML responses only; the files on disk stay as `build` wrote them. Ctrl-C stops the server. |
| `mizzen doctor [dir] --format text\|json\|sarif --theme <dir>` | Checks the runtime, the config, the content, the output paths, and the toolchain without writing to the site, and prints the findings in the chosen format. Exits `1` on an error. |
| `mizzen edit apply <patch.json> [dir] --dry-run --proof <path> --allow-unchecked` | Applies one span patch (the JSON shape of `src/edits/patch.ts`) to the source file its `span.file` names, resolved against `dir` and refused outside it. The patch is applied in memory and the file is replaced through a rename only when it succeeds, so a refused patch leaves it byte-identical. A patch that carries neither `expected` nor `beforeHash` is refused (exit `2`) unless `--allow-unchecked` is given; one that carries only one is still refused. Writes an edit proof (`src/edits/proof.ts`) with the SHA-256 before and after, at `--proof` or `<patch>.proof.json`, and prints its path. `--dry-run` prints a unified diff and writes neither. Exits `1` on a refused patch or path, `2` on a missing or invalid patch. `--format json` prints the same outcome as one report: `status`, `exitCode`, the file, the proof, and any `diagnostics` with their path and span. |
| `mizzen edit verify <proof.json> --site <dir> --doctor` | Re-hashes every file the edit's proof record names, under `--site` (default `.`), and compares each with its after-edit hash. The first mismatch is named, and the command exits `1`; a proof that cannot be read exits `2`. With `--doctor` it also runs `mizzen doctor --format json` and compares the level with the recorded one; without it, the hashes are checked and the command says the doctor check did not run. `--format json` prints the same outcome as one report, with the failed check, its path, and the doctor levels it compared. |
| `mizzen import <name> <dir> [--out <dir>] [--fail-on-manual] [--allow <ids>]` | Previews a migration: the importer reads `dir` and prints each file's proposed destination and URL, and the items a person still has to do. Writes nothing, or writes the mapped project to the empty `--out` folder outside the source. Exits `1` on an error and `2` on an unknown importer. `--fail-on-manual` also exits `1` while a manual item is unresolved, and `--allow <ids>` records the diagnostic ids (comma-separated) a person has reviewed, so those items no longer fail the gate. |
| `mizzen init --starter <name> [dir] --theme <dir> --lang <a,b>` | Copies the theme's `starters/<name>/` folder into `dir` (default `.`), resolving the theme the way `build` does. `--list` prints each starter with its title and description from `starter.json`; `--lang` keeps only the named optional languages. It refuses a folder that is not empty and names a missing theme or starter. |
| `mizzen mcp [dir] [--allow-edits] [--print-config <client>]` | Serves the site to an AI client over MCP on stdio. Read-only unless `--allow-edits` adds `apply_edit`. Logs go to stderr. See [MCP server](/mcp/). |
| `mizzen network check <file>` | Checks the shared network file: ids, paths, and titles. See [Several projects](/network/). |
| `mizzen network update [dir]` | Fetches the network and writes `network.lock.json`; `--check` compares without writing and `--accept` takes a changed project. |
| `mizzen network sitemap [dir]` | Writes the organization's sitemap index; `--url <origin>` names the host and `--out <dir>` the folder. |
| `mizzen stale [dir]` | Lists pages whose covered files changed since they were reviewed. `--json`, `--fail` (exit `1` when any page is stale), `--changed <files…>`, and `--git-diff <base>` choose what counts as changed. |
| `mizzen stale mark <page…>` | Records a page's covered files as reviewed; `--all` marks every page. |
| `mizzen urls check [dir]` | Compares every record page's URL with `urls.lock.json` and prints the new, changed, and removed records. Writes nothing; exits `1` on an error. `--format text\|json`. See [Stable URLs](/data/urls/). |
| `mizzen pack [dir] --topic <name> --budget <tokens> --out <file>` | Prints the context pack for one topic in `_data/context-packs.yml` to stdout, or writes it to `--out`. `--budget` overrides the topic's budget; without `--topic` the site's only topic is used, and a site with several lists them and exits `2`. Diagnostics go to stderr, so stdout stays clean Markdown. |
| `mizzen published-site check --sitemap <url> [--domain <host>] [--redirects <file>]` | Fetches every URL in a sitemap or sitemap index and reports each page's status code, canonical URL, and redirect destination. `--domain` is the only host it may request; `--redirects` names a JSON map of expected sources to final addresses. `--format text\|json`; writes nothing and exits `1` on an error. |
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
