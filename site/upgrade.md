---
title: Upgrade to 0.2.3
description: Upgrade a 0.2.2 site without changing its Markdown, config, existing URLs, or published output, and try the new authoring features.
layout: doc
permalink: /upgrade/
---

# Upgrade to 0.2.3

An existing `0.2.2` docs or data site needs no content migration. The new features are optional: keeping your
Markdown, `mizzen.yml`, navigation, and theme as they are builds the same pages at the same URLs.

If you are coming from `0.2.0` or `0.2.1`, collections and stable record URLs first shipped in `0.2.1`; the
[0.2.2 upgrade guide](https://github.com/velella-sh/mizzen/blob/v0.2.2/site/upgrade.md) still applies first.

## Update and check

After `0.2.3` is published, update the engine in the site's project:

```sh
npm install --save-dev @velella/mizzen@0.2.3
npx mizzen check .
npx mizzen build . --out dist
npx mizzen verify dist
```

Commit `package.json` and `package-lock.json`. Keep your existing theme; Lateen `0.2.2` is the published theme the
release was checked against. Node 24 or later is still required.

The new `versions snapshot` command is a safe way to see a 0.2.3 feature without writing anything:

```sh
npx mizzen versions snapshot v1 --dry-run
```

It prints the pages and navigation it would copy into `v1/`. Drop `--dry-run` to write the snapshot, or read
[Documentation versions](https://github.com/velella-sh/mizzen/blob/main/docs/docs-versions.md) first.

## What stays the same

- Existing CLI commands and flags remain available. You do not need a new flag for an ordinary build.
- Markdown pages, front matter, navigation, and their URLs keep working. The release compatibility test builds the
  `0.2.2` fixture with the published `0.2.2` engine and the release tarball in separate empty projects: all 197
  public files match byte for byte, including HTML, JSON, and Markdown twins. Every canonical link, `_redirects`,
  and sitemap URL also matches. The only normalized value is the engine version stamp in `agent.json`.
- The same fixture builds with the published `@velella/lateen@0.2.2` theme. Canonical links, theme assets, the
  Mermaid diagram, and redirect destinations keep the configured `base`.
- Existing output paths, including Markdown twins, page JSON, `llms.txt`, and the build manifest, remain available.
  Existing feed and sitemap shapes are retained.
- Existing JSON Schema files and their fields are retained. New features add optional fields and schemas; use the
  schemas bundled with the installed engine rather than an older copy.
- Generated JSON identifies the engine version. Consumers should read `version` from `@velella/mizzen`, not
  require the literal string `0.2.2`. The engine version is not the document's schema version.
- A build still opens no network connection. `mizzen published-site check` and the network commands are explicit.

## Optional additions since 0.2.2

None of these changes an ordinary docs site. The reference column points at the published documentation where one
exists, else at the design note in the repository.

| Feature | Keys, front matter, or files | Commands and reference |
| --- | --- | --- |
| Published-site checks | None; a published sitemap URL | `mizzen published-site check --sitemap <url>`; [Command line](/cli/), [design](https://github.com/velella-sh/mizzen/blob/main/docs/published-site-check.md) |
| Network sitemap and record links | `network.lock.json`; `[[project:collection/id]]` | `mizzen network sitemap`; [Several projects](/network/) |
| Record relations | Collection `references`; related records in templates and lists | [Collections](/data/collections/), [design](https://github.com/velella-sh/mizzen/blob/main/docs/record-relations.md) |
| Report archive | Dated collection, list `perPage`, changelog | `mizzen data snapshot`, `data changes`; [Change history](/data/changelog/), [Snapshots](/data/snapshots/) |
| Claim evidence | Collection `evidence` field and `:evidence[…]` | [design](https://github.com/velella-sh/mizzen/blob/main/docs/claim-evidence.md) |
| Documented command checks | Fence `test` meta, `examples.failOnFailure` | `mizzen check`; [Configuration](/config/), [design](https://github.com/velella-sh/mizzen/blob/main/docs/docs-command-check.md) |
| Page tools | `tool:` front matter and a site-owned file | [Outputs](/outputs/), [design](https://github.com/velella-sh/mizzen/blob/main/docs/page-tools.md) |
| Blog | `blog` config and post front matter | [design](https://github.com/velella-sh/mizzen/blob/main/docs/blog.md) |
| API reference | A pinned OpenAPI document in the config | [design](https://github.com/velella-sh/mizzen/blob/main/docs/api-reference.md) |
| Code annotations | `annotations={…}` on a code fence | [design](https://github.com/velella-sh/mizzen/blob/main/docs/code-annotations.md) |
| Code snippets | A fence or include that reads a source range | [design](https://github.com/velella-sh/mizzen/blob/main/docs/code-snippets.md) |
| Shared content | `::include` with parameters and nesting | [design](https://github.com/velella-sh/mizzen/blob/main/docs/content-includes.md) |
| Math | Inline `$…$` and block `$$` | [design](https://github.com/velella-sh/mizzen/blob/main/docs/math.md) |
| Documentation versions | `vN/` pages and navigation | `mizzen versions snapshot <vN>`; [Command line](/cli/), [design](https://github.com/velella-sh/mizzen/blob/main/docs/docs-versions.md) |
| Component imports | Docusaurus, Starlight, or VitePress sources | [Docusaurus](https://github.com/velella-sh/mizzen/blob/main/docs/import-docusaurus-components.md), [Starlight](https://github.com/velella-sh/mizzen/blob/main/docs/import-starlight-components.md), [VitePress](https://github.com/velella-sh/mizzen/blob/main/docs/import-vitepress-components.md) |
| Plugins | `mizzen.config.ts`: validator, Markdown transform, custom output | [Plugins](/plugins/), [design](https://github.com/velella-sh/mizzen/blob/main/docs/plugin-api.md) |
| API contract checks | `drift` config; cited TypeScript symbols | `mizzen check`, `mizzen doctor`; [design](https://github.com/velella-sh/mizzen/blob/main/docs/api-contract-check.md) |

Commit lock files when you opt into the feature that writes them. Review the fields a collection publishes before
enabling page JSON, raw data, feeds, or the data API; [Feeds and machine output](/data/feeds/) lists the publishing
rules.

## Publishing checks before a release

`mizzen check` proves the inputs, not the host. Once the site is deployed, point the check at its published
sitemap and keep the expected redirects in a small JSON map:

```sh
npx mizzen published-site check --sitemap https://example.com/sitemap.xml --redirects redirects.json
```

The check reports a failed status, a missing or mismatched canonical URL, and a redirect that ends somewhere other
than the mapped address. It requests only the sitemap's host unless `--domain` says otherwise, and it writes
nothing. A recipe runs it in CI after the deploy.

## Older data-site migration

If you are upgrading a `0.2.0` or `0.2.1` site that still keeps data in ordinary Markdown pages, the
[0.2.2 upgrade guide](https://github.com/velella-sh/mizzen/blob/v0.2.2/site/upgrade.md) walks through turning an
existing `_data` file into a collection, accepting its first record URLs, and restricting published fields.
