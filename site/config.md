---
title: Configuration
description: The mizzen.yml keys Mizzen reads.
layout: doc
permalink: /config/
date: 2026-10-26
author: Velella
---

A collection also accepts a `transform` key: ordered steps that rewrite its records before validation, covering field
selection and removal, renames, defaults, type, date, and unit conversion, string normalization, categorical mapping,
filtering, and deduplication. It is documented in the repository's
[transformation guide](https://github.com/velella-sh/mizzen/blob/main/docs/transform.md) and previewed with
`mizzen data transform`.

<!-- Generated from packages/engine/schema/config.schema.json by tools/config-ref/run.ts. Do not edit below this line. -->

The site config file. Every key is optional; an unknown key is an error.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | string |  | Site name for the header, page titles, llms.txt, and JSON-LD. Default: the folder name. |
| `description` | string |  | One-sentence summary of the site, for the home page's meta description and llms.txt. |
| `url` | string |  | Scheme and host of the published site, without a trailing slash, such as https://example.github.io. Without it canonical links, the sitemap, and social images are relative or left out, with a warning. |
| `base` | string | `` | Path the site lives under, starting with / and without a trailing slash; empty at a domain root. Every URL the engine writes carries it. |
| `lang` | string | `en` | Default language of every page, as a BCP 47 tag. A page's lang wins. |
| `dir` | `ltr` or `rtl` |  | Default text direction. Unset, it comes from lang (rtl for fa, ar, he, ur, and the other right-to-left languages). A page's dir wins. |
| `languages` | list of object | `[]` | The site's languages in switcher order. Leave it out for a one-language site. |
| `languages[].code` | string | required | BCP 47 tag, such as fa. |
| `languages[].name` | string | required | Name shown in the language switcher, in that language. |
| `languages[].prefix` | string | required | URL prefix of this language's pages, such as /fa; empty for the default language. |
| `source` | string | `.` | Folder that holds the content, relative to the site root. Files outside it are not pages. |
| `include` | list of string | `[]` | Paths under source that discovery would skip (names starting with . or _) but should be copied or built, such as .well-known. |
| `exclude` | list of string | `[]` | Paths under source that are neither pages nor copied. node_modules, the output folder, and the config file are always excluded. |
| `navigation` | string | `_data/navigation.yml` | Navigation file, relative to the site root. When it does not exist, navigation is built from folders and each page's order. |
| `defaults` | list of object | `[]` | Front matter applied to every page under a path unless the page sets the key itself. Later entries win over earlier ones; a page always wins. |
| `defaults[].path` | string | required | Folder relative to source; empty for every page. |
| `defaults[].values` | object | required | Front matter keys and values to apply. |
| `repository` | object |  | Where the source lives, for Edit this page links and the Edit with your agent prompt. |
| `repository.url` | string | required | The repository's web URL, such as https://github.com/example/example. |
| `repository.branch` | string | `main` | Branch that edit links point to. |
| `repository.dir` | string | `` | The site root's folder inside the repository, such as docs. |
| `theme` | object |  | The theme that builds the site and the options handed to it. |
| `theme.name` | string |  | Theme package or folder. Default: the theme that ships with the engine. |
| `theme.options` | object |  | Handed to the theme unread; the theme validates it against its own schema. |
| `theme.overrides` | object |  | Site modules that replace selected theme units. The path is relative to the site root; a missing file, a path outside the root, or a name the theme does not have is an error. A replacement may add a `<file>.css` sidecar beside it; it brings no client island. Every unit not named here stays the theme's. |
| `theme.overrides.layouts` | object |  | Layout name → the site module that replaces it. |
| `theme.overrides.components` | object |  | Component name → the site module that replaces it. |
| `search` | `false` or object | `{}` | false builds no search index. As an object, text sets how much of each page's body the index keeps. |
| `search.text` | integer | `300` | The most characters of a page's body the index keeps. Titles and headings are always indexed. |
| `examples` | object | none | Controls failed-example diagnostics, [executable examples](/example-results/), and pinned results. |
| `examples.failOnFailure` | boolean | `false` | true reports a failed example as an error at its fence, so `mizzen check` exits 1; false keeps it a warning and the build succeeds. |
| `examples.pinned` | boolean | `false` | Read `.mizzen-examples.json` during the build instead of running fences; `mizzen examples record` writes it. |
| `examples.execute` | boolean | `false` | Run the opt-in `test` fences during the build and attach their evidence to each page, `examples.json`, and page JSON. |
| `examples.lock` | boolean | `true` when `execute` | Require `.mizzen-env.json` and fail a run whose host differs from it. |
| `examples.timeoutMs` | integer | `10000` | Milliseconds each block may run before the process group is killed. |
| `examples.memoryMb` | integer | `0` | V8 old-space limit in MiB; `0` keeps V8's default. |
| `examples.network` | `deny` or `allow` | `deny` | Whether a block may reach the network. |
| `examples.typeCheck` | boolean | `true` | Type-check visible `ts`/`js` blocks against their imports before running them. |
| `examples.allowlist` | list of string | `[]` | Commands a runbook's shell steps may run; a step outside it is refused before it runs. |
| `federation` | object | none | Read knowledge from other independent projects: `manifest` names the federation manifest, `project` names this site's id, `bundle` names where this site publishes its own, and `compatible` names a version or range it accepts. A normal build reads only `federation.lock.json` and the locally locked bundles. See [Federated knowledge](https://github.com/velella-sh/mizzen/blob/main/docs/federated-knowledge.md). |
| `analytics` | object | none | A cookieless analytics tool, written as one script tag. See [Analytics and verification](/analytics/). |
| `verify` | object | none | Search engine verification tags and files. See [Analytics and verification](/analytics/). |
| `social` | object | none | Generated share images: `template` names a file in `_templates/social/`, `fonts` lists the font files the images are drawn with. Without the key no image is written. |
| `redirects` | object | `{}` | Redirect pages: each key is an old path under base, each value a path on the site or an https URL. |
| `outputs` | object | `{}` | Turns an output off by its name (false), such as twins or llms. The loader checks the names against the output registry; an unknown name is an error. |
