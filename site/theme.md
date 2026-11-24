---
title: Lateen 0.2.5
description: What a Mizzen site gets from the Lateen 0.2.5 theme, what changes on screen after the upgrade, and the one thing to refresh.
layout: doc
permalink: /theme/
---

# Lateen 0.2.5

[Lateen](https://velella.sh/lateen/) is the theme Mizzen builds with by default. Version `0.2.5` is the current published release. It changes how pages look and adds a few opt-in options, and it changes no Markdown, front matter, or URL. Mizzen still never imports the theme: the engine hands it the same frozen props, and the theme draws them.

## Update

```sh
npm install --save-dev @velella/lateen@0.2.5
npx mizzen check .
npx mizzen build . --out dist
```

Commit `package.json` and `package-lock.json`. Lateen `0.2.5` needs no change to `mizzen.yml`; every option below is opt-in.

## What changes without any setting

A site that only bumps the package gets these. They are CSS and chrome changes: the HTML of the article, the Markdown twins, and `llms.txt` are the same.

- **One Page tools menu.** The stacked controls before the article are one **Page tools** disclosure on documentation and record pages. It groups *Copy*, *Open in*, and *Page*, with an icon on every row. Source mode is a toggle row in that menu; while it is on, it is the only control.
- **A calmer mobile layout.** The drawer lists every section in one open layer behind a menu button, and a phone without JavaScript keeps the sidebar above the article instead of an unreachable drawer. The closed "On this page" fold names the section in view.
- **One type scale.** Every page reads one set of sizes, line heights, a 66ch measure, and one block spacing step. Body text is now **17px**, up from 16px. See [type and rhythm](https://velella.sh/lateen/type/).
- **A single project button in the footer.** On a [network](/network/) site, the footer is one button named for the current project that opens the other projects in a popover.

### Refresh visual baselines once

Because body text and spacing moved, a site that keeps screenshot baselines should record them again after the upgrade and review the diff. A site that wants the old body size sets `--type-size-base: 1rem` in its own stylesheet.

## Data pages

These changes matter to a [data site](/data/). They show what the engine already publishes.

| Page | What Lateen 0.2.5 shows |
| --- | --- |
| Collection and record pages | Each public field's type, whether it is required, and its allowed values, read from the collection's recorded schema. See [Public fields](/data/public-fields/). |
| List and record pages | Links to the collection files, the record JSON, the JSON Schema, and the OpenAPI document of the [versioned data API](/data/api/). |
| Record pages from an API, SQLite query, or NDJSON file | The agent edit prompt and the *Report a data issue* link name the NDJSON file, the database path, or the API URL, not `.mizzen/data/<hash>`. An API or database record shows no edit prompt. |
| Aggregate records | The data-file edit link is hidden, because the record is computed from another collection. |

Schema tables also resolve a local reference to a boolean JSON Schema, showing `any` for an unconstrained value and `never` when no value is allowed.

## Fixes that affect builds

- Syntax highlighting is reproducible under load: a line-length limit replaces a wall-clock timeout, so a busy machine and an idle one write the same bytes.
- Using `heading-anchor` as a Markdown directive stops the build with a clear message instead of writing an invalid `<hundefined>` element.

## Opt-in

- [Presets and Theme Studio](/presets/): pick a preset or tune an accent, then copy the settings.
- Family identity for projects in a [network](/network/): `theme.options.network.search: false` keeps each site's search on its own index.

The theme's own [upgrade guide](https://velella.sh/lateen/upgrade/) and [changelog](https://github.com/velella-sh/lateen/blob/main/CHANGELOG.md) list every change.
