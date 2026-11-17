---
title: Plugin API example
description: A site whose mizzen.config.ts validates pages, numbers sections, and writes a page index.
layout: doc
---

# Plugin API example

This site has no build script. Its behavior comes from `mizzen.config.ts` and three plugins that use only the hooks in
`@velella/mizzen/contracts`.

## What the plugins do

- `check-descriptions` warns about a page without a description.
- `number-sections` numbers every second-level heading before Markdown is parsed.
- `write-page-index` adds `plugin-api/pages.json` to the build.
