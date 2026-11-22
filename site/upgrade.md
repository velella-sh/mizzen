---
title: Upgrade to 0.2.6
description: Upgrade a 0.2.5 site without changing its Markdown, config, existing URLs, or published output, and adopt tasks, context packs, proofs, traces, evaluations, and readiness when you need them.
layout: doc
permalink: /upgrade/
---

# Upgrade to 0.2.6

An existing `0.2.5` docs or data site needs no content migration. Every new key, contract, and command is opt-in:
keeping your Markdown, `mizzen.yml`, navigation, and theme as they are builds the same pages at the same URLs. The
release compatibility test measured 0 missing, 0 changed, and 0 added public files, with the same canonical links,
redirects, and sitemap URLs, when the committed compatibility site was built with the published `0.2.5` engine and the
`0.2.6` tarball.

If you are coming from `0.2.4` or earlier, the
[0.2.5 upgrade guide](https://github.com/velella-sh/mizzen/blob/v0.2.5/site/upgrade.md) still applies first.

## Update and check

After `0.2.6` is published, update the engine in the site's project:

```sh
npm install --save-dev @velella/mizzen@0.2.6
npx mizzen check .
npx mizzen build . --out dist
npx mizzen verify dist
```

Commit `package.json` and `package-lock.json`. Keep your existing theme; Lateen `0.2.4` is the published theme the
release was checked against, and Lateen `0.2.3` and `0.2.2` still build. Node 24 or later is still required.

## What Lateen 0.2.4 adds

Lateen `0.2.4` redraws the theme with the Sailcloth design and keeps every option and URL. This site uses the new parts
where they help a reader:

- [Steps](https://velella.sh/lateen/components/steps/) give each step a stable anchor, and the
  [install page](/install/) uses them for check, preview, and build.
- [Code tabs](https://velella.sh/lateen/components/code-tabs/) take a `group`, so choosing pnpm in one example
  switches the other package-manager examples on the page.
- [Quote](https://velella.sh/lateen/components/quote/) sets a quotation apart with an optional name and source.
- Tables can carry a caption and description, code blocks have a wrap toggle, and the article ends with a back-to-top
  link and next-step cards.

:::quote{name="Lateen 0.2.4" source="https://github.com/velella-sh/lateen/releases/tag/v0.2.4"}
A site that only bumps the package keeps its pages and URLs.
:::

## What stays the same

- Existing CLI commands and flags remain available. An ordinary build needs no new flag and still opens no network
  connection.
- Markdown pages, front matter, navigation, and their URLs keep working. The compatibility run covers HTML, JSON,
  Markdown twins, `_redirects`, and the sitemap.
- Existing output paths and schema files are retained. Read `schema/` from the installed package rather than pinning an
  older copy; no field was removed.
- Generated reports keep their document-format versions: build reports stay format `1`, lineage stays `format: 1`, and
  refresh stays `mizzen-refresh/1`. Only the engine version in `package.json` changes.

## New capabilities

None of these changes an ordinary docs site. Each is a separate entry point with its own contract and tests.

- **Tasks and the agent CLI.** `mizzen agent capabilities` reports the installed surface, and
  `mizzen agent task register` reads a version 1 contract. See [the agent CLI](/cli/).
- **Task-aware context.** `mizzen pack --task <file>` compiles a ranked pack from a task's scope, reports the exact
  budget accounting, and names what it omitted. See [MCP and context](/mcp/).
- **MCP.** `mizzen mcp` negotiates contract version 1, announces its fallbacks, pins a session to one snapshot, and
  makes `apply_edit` idempotent. `mizzen mcp . --print-config cursor` writes the client entry. See [MCP server](/mcp/).
- **Atomic edits and proofs.** `mizzen edit transaction` applies a multi-file transaction all or nothing, and
  `mizzen edit verify` checks its version 2 proof independently. See [Agent editing](https://github.com/velella-sh/mizzen/blob/main/docs/agent-editing.md).
- **Traces.** `mizzen trace replay` checks a recorded trace without writing; `export` prints only authorized fields.
- **Evaluations.** `mizzen eval` runs the deterministic reference suite; the live-model runner is opt-in and outside
  the engine. See [Readiness](https://github.com/velella-sh/mizzen/blob/main/docs/readiness.md).
- **Readiness.** `mizzen readiness dist --report readiness.json --badge readiness.svg` scores a built folder against
  rubric 1.0.0 and never turns missing evidence into a pass.
- **Permissions.** `--policy <file>` enforces a least-privilege access policy on edits and MCP.

The full contract review, the measured compatibility table, executable examples, and the
[determinism and performance measurements](https://github.com/velella-sh/mizzen/blob/main/docs/determinism-0.2.6.md)
are in [the 0.2.6 upgrade notes](https://github.com/velella-sh/mizzen/blob/main/docs/upgrade-0.2.6.md).

## Compatibility evidence

The published baseline is `@velella/mizzen@0.2.5`. The release uses the committed compatibility site and the fixed
test theme:

- 197 public files compared: 0 missing, 0 changed, 0 added.
- 2 canonical links, 2 redirect rules, and 31 sitemap URLs: no differences.
- `@velella/lateen@0.2.4`: canonical links, theme assets, the Mermaid diagram, and redirect destinations keep the
  configured `base`.

Automated maintenance and multi-agent coordination are library modules and recipe data in this release; they have
tests but no public command yet, and are listed as such in `release/scope.json`.
