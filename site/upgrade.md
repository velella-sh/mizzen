---
title: Upgrade to 0.2.2
description: Upgrade a 0.2.0 or 0.2.1 site without changing its Markdown, config, or existing URLs, and optionally turn a data file into a collection.
layout: doc
permalink: /upgrade/
---

# Upgrade to 0.2.2

An existing `0.2.0` or `0.2.1` docs site needs no content migration. The data-site features are optional:
keeping your Markdown, `mizzen.yml`, and navigation as they are does not turn any `_data` file into a collection.

## Update and check

After `0.2.2` is published, update the engine in the site's project:

```sh
npm install --save-dev @velella/mizzen@0.2.2
npx mizzen check .
npx mizzen build . --out dist
npx mizzen verify dist
```

Commit `package.json` and `package-lock.json`. Keep your existing theme; a theme that draws record or list pages
must support the [data theme contract](/data/theme-contract/). Node 24 or later is still required.

## What stays the same

- Existing CLI commands and flags remain available. You do not need a new flag for an ordinary docs build.
- Markdown pages, front matter, navigation, and their URLs keep working. The compatibility test compares all
  594 HTML pages of the `0.2.0` docs fixture, including its app page, against the old engine's output with a fixed
  render fixture; it does not assert that two different theme versions look the same.
- Existing output paths, including Markdown twins, page JSON, `llms.txt`, and the build manifest, remain available.
  `changes.xml` and `changelog.xml` retain their existing feed shapes.
- Existing JSON Schema files and their fields are retained. New features add schemas and fields; use the schemas
  bundled with the installed engine rather than an older copy.
- Generated JSON identifies the engine version. Consumers should read `version` from `@velella/mizzen`, not
  require the literal string `0.2.0`. The engine version is not the document's schema version.

## Optional additions since 0.2.0

Collections, templates, lists, collection search, and stable record URLs first shipped in `0.2.1`.
`0.2.2` extends data publishing and adds the tools below. None requires a change to an ordinary docs site.

| Feature | Keys or files to add | Commands and reference |
| --- | --- | --- |
| Record and list pages | `collections` in `mizzen.yml`, `_templates/*.md`, and `list` front matter | [Data site quick start](/data/quick-start/); `mizzen urls check`, `build --update-urls` |
| Feeds and search metadata | `feeds`, collection `search`, `seo`, and `index` | [Feeds](/data/feeds/), [Search](/data/search/), [SEO](/data/seo/) |
| Social share images | `social`, an SVG template, and declared fonts | [Social images](/data/social-images/) |
| Recorded data sources | `mizzen.lock.json` | `mizzen data fetch`, `data snapshot`, `data verify`; [Snapshots](/data/snapshots/) |
| Dated records and calendars | `asOf`, `dates`, collection date fields and `derived`, `calendars` | `build --as-of`; [Dated data](/data/dates/), [Calendars](/data/calendars/) |
| Versioned data API | `api` | `mizzen api check --against`; [Data API](/data/api/) |
| Recorded change history | Collection `changelog` and `data-changes/` | `mizzen data changes`; [Change history](/data/changelog/) |
| Several projects | `network` and `network.lock.json` | `mizzen network check`, `network update`, `network sitemap`; [Networks](/network/) |
| Analytics and ownership verification | `analytics` and `verify` | [Analytics and verification](/analytics/) |
| Stale page detection | `covers` front matter, optional `stale`, and `docs-review.lock.json` | `mizzen stale`, `stale mark`; [Stale pages](/data/stale-docs/) |
| AI access and build comparisons | No required config | `mizzen mcp`, `mizzen diff`; [MCP](/mcp/), [Compare two builds](/site-diff/) |
| Starter sites | A starter supplied by the theme | `mizzen init --list`, `init --starter`; [Install](/install/) |

Commit lock files when you opt into the feature that writes them. A build does not fetch remote data or
refresh snapshots, review dates, or history; the corresponding command does that explicitly.

## Turn an existing data file into a collection

Suppose `_data/components.yml` already holds these records:

```yaml
- slug: button
  name: Button
  summary: A **button** starts an action.
- slug: tabs
  name: Tabs
  summary: Tabs switch between related views.
```

Keep that file where it is. Add a collection to the existing `mizzen.yml`, leaving its other keys in place:

```yaml
collections:
  components:
    source: _data/components.yml
    id: slug
    template: _templates/components.md
    permalink: /components/{slug}/
    markdown: [summary]
```

Add `_templates/components.md`:

```md
---
title: "{name}"
description: "The {name} component."
layout: doc
---
# :field[name]

:field[summary]
```

Then check the records and accept their initial URLs:

```sh
npx mizzen check .
npx mizzen build . --out dist --update-urls
npx mizzen urls check .
```

This adds `/components/button/` and `/components/tabs/`. It does not replace existing Markdown pages; choose a
different `permalink` if those URLs are already occupied. Commit `urls.lock.json`: later URL changes need an
explicit `build --update-urls`, and removed records follow the collection's `onRemoved` policy.

Every record field is published by default in the record's page JSON and raw-data downloads. Before using private
data, restrict `collections.components.json.fields` and `raw.private`, or set `raw: false`.
These settings do not redact template content or separately configured search, feeds, and API output.
See [Collections](/data/collections/) and [Feeds and machine output](/data/feeds/).
