---
title: Upgrade to 0.2.6
description: Upgrade a 0.2.4 site without changing its Markdown, config, existing URLs, or published output, and try API, database, transform, join, aggregate, public-field, and lineage features.
layout: doc
permalink: /upgrade/
---

# Upgrade to 0.2.6

An existing `0.2.4` docs or data site needs no content migration. Every new key and command is opt-in: keeping your
Markdown, `mizzen.yml`, navigation, and theme as they are builds the same pages at the same URLs. The release
compatibility test measured 0 missing, 0 changed, and 0 added public files, with the same canonical links, redirects,
and sitemap URLs, when the committed compatibility site was built with the published `0.2.4` engine and the `0.2.5`
tarball.

If you are coming from `0.2.3` or earlier, the
[0.2.4 upgrade guide](https://github.com/velella-sh/mizzen/blob/v0.2.4/site/upgrade.md) still applies first.

## Update and check

After `0.2.5` is published, update the engine in the site's project:

```sh
npm install --save-dev @velella/mizzen@0.2.6
npx mizzen check .
npx mizzen build . --out dist
npx mizzen verify dist
```

Commit `package.json` and `package-lock.json`. Keep your existing theme; Lateen `0.2.2` is the published theme the
release was checked against. Node 24 or later is still required.

## What stays the same

- Existing CLI commands and flags remain available. An ordinary build needs no new flag and still opens no network
  connection.
- Markdown pages, front matter, navigation, and their URLs keep working. The compatibility run above covers HTML, JSON,
  Markdown twins, `_redirects`, and the sitemap.
- The same fixture builds with the published `@velella/lateen@0.2.2` theme; canonical links, theme assets, the Mermaid
  diagram, and redirect destinations keep the configured `base`.
- Existing output paths, JSON Schema files, and fields are retained. New features add optional keys and documents; use
  the schemas bundled with the installed engine rather than an older copy.
- Generated JSON reports the engine as `0.2.5`; consumers should read `version` from `@velella/mizzen`, not pin the
  literal string. Document-format versions are separate: lineage reports use `format: 1`, refresh reports use
  `mizzen-refresh/1`, and build reports use format `1`.

## Optional additions

None of these changes an ordinary docs site. Each example is a valid addition to `mizzen.yml`; the linked page has the
full contract.

### Fetch a paginated API source

A collection whose `source` is an `https://` URL declares where its records sit and how pages advance. Fetch once,
commit the lock and store, and build offline from then on.

```yaml
collections:
  items:
    source: https://api.example.com/items
    records: data.items
    id: id
    pagination:
      mode: page
      param: page
      start: 1
      pageSize: 100
      stop: short
```

```sh
npx mizzen data fetch .
npx mizzen data fetch . --check
```

`--check` exits `1` when the API or its bytes changed. See [Command line](/cli/).

### Read SQLite or NDJSON

A local database is read through one configured query; an NDJSON file holds one JSON object per line. Both are
extracted before a build and locked like any other input.

```yaml
collections:
  parts:
    source: _data/parts.sqlite
    id: sku
    sqlite:
      query: SELECT sku, name, price FROM parts ORDER BY sku
  products:
    source: _data/products.ndjson
    id: sku
```

```sh
npx mizzen data extract .
npx mizzen data extract . --check
```

A build refuses a missing, stale, or mismatched extraction instead of reading the source. See
[SQLite and NDJSON inputs](https://github.com/velella-sh/mizzen/blob/main/docs/db-input.md).

### Transform, join, and summarize

Rules run in order before validation and publication. A join enriches a record from other collections, and an
aggregate publishes groups as a normal collection.

```yaml
collections:
  catalog:
    source: _data/catalog.yml
    id: sku
    transform:
      steps:
        - id: cents
          op: unit
          field: price
          factor: 100
        - id: title
          op: normalize
          field: title
          case: upper
    join:
      type: left
      key: sku
      sources:
        - collection: inventory
          fields: { stock: stock }
  inventory:
    source: _data/inventory.yml
    id: sku
  sales:
    source: _data/sales.yml
    dates: [date]
  monthly:
    source: sales
    aggregate:
      by:
        - { field: date, period: month, timezone: Europe/Berlin }
      metrics:
        orders: { op: count }
        revenue: { op: sum, field: amount, decimals: 2 }
```

```sh
npx mizzen data transform catalog .
npx mizzen data transform-diff mizzen.yml rules/proposed.yml . --collection catalog --check
```

See [Transforming data](https://github.com/velella-sh/mizzen/blob/main/docs/transform.md),
[Joining data](https://github.com/velella-sh/mizzen/blob/main/docs/join.md), and
[Aggregating data](https://github.com/velella-sh/mizzen/blob/main/docs/aggregate.md).

### Publish only allowed fields

A `public` allowlist names the dot paths every public output may publish. The record keeps every field internally, so
transforms, joins, permalinks, and filters still read it.

```yaml
collections:
  people:
    source: _data/people.yml
    public: [name, role, author.name]
```

Pages, Markdown twins, page JSON, collection indexes, search, feeds, changelog, and the static API apply the same view.
`id` is always public, and an absent policy publishes every field as before. See [Public fields](/data/public-fields/).

### Explain a field and reproduce a build

`data explain` follows one field from its input hash and row through renames, rules, joins, and aggregates to the page
and API paths that publish it. `--public` prints metadata only and refuses a private field.

```sh
npx mizzen data explain catalog sku-1 --field price
npx mizzen data explain catalog sku-1 --field price --json
npx mizzen build . --diagnose
npx mizzen compare .mizzen/build-report.json ci-report.json
npx mizzen reproduce .mizzen/build-report.json . --check
```

`build --diagnose` writes `.mizzen/build-report.json`, `compare` groups differences under inputs, config, tools,
environment, or outputs, and `reproduce --check` preflights a recorded build. See [Field lineage](/data/lineage/).

### Refresh data in CI

`data refresh` fetches selected sources, validates the site, and writes one deterministic report. The checked-in
recipe separates `contents: read` download from a final `contents: write` job that commits the lock and store and
updates one review pull request.

```sh
npx mizzen data refresh . --collections items --report refresh.json
```

See [Refreshing data in CI](/data/refresh/).

## Compatibility evidence

- Baseline: published `@velella/mizzen@0.2.4`, built in a separate empty project from the committed fixture.
- Candidate: the `0.2.5` tarball that the release workflow publishes.
- Result: 0 missing, 0 changed, 0 added files; canonical links, `_redirects`, and sitemap URLs match. The only
  normalized value is the engine version stamp in generated JSON.
- Theme: published `@velella/lateen@0.2.2`; base assets, canonical links, Mermaid, and redirects keep the base.
- Node: 24 or later.
