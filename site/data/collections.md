---
title: Collections
description: Every key of collections in mizzen.yml, with type, default, and an example, the source kinds, and the lock file.
---

# Collections

A collection is declared under `collections` in `mizzen.yml`, keyed by its name: lowercase letters, digits, and
hyphens. Only `source` is required. A collection with both `template` and `permalink` builds one page per record.

```yaml
collections:
  components:
    source: _data/components.yml
    id: slug
    template: _templates/components.md
    permalink: /components/{slug}/
    markdown: [summary]
    dates: [released]
    unique: [name]
    onInvalid: error
```

## Keys

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `source` | string | required | Where the records come from: a file in the site, an `https://` URL, or an `npm:` address. |
| `id` | string | the mapping key | Field that holds a record's id. A source that is a mapping of id to record needs none. |
| `template` | string | | Markdown template under `_templates/`. Example: `_templates/components.md`. |
| `permalink` | string | | URL pattern of a record page, such as `/components/{slug}/`. See [Templates](/data/templates/). |
| `disambiguate` | string | | Field appended to the URL of a record whose pattern gives another record's URL, such as `id`. |
| `aliases` | string | | Field that holds earlier ids or paths of a record; each redirects to the record's page. See [Stable URLs](/data/urls/). |
| `schema` | string | | JSON Schema file, relative to the site root, that validates every record. |
| `schemaRenames` | object | `{}` | Fields an earlier record may still hold under an old name, keyed by the new name: `{ slug: path }` reads `path` as `slug`. A record that holds both keeps the new one and earns a warning naming its line. |
| `onSchemaChange` | `error` or `warn` | `error` | What a schema change that earlier records may not satisfy does: `error` fails the build, `warn` reports a warning. A rename mapped by `schemaRenames` is a warning either way. |
| `unique` | list of string | `[]` | Fields whose values must be unique; a duplicate is an error naming both records. |
| `references` | object | `{}` | Fields that hold the id of another collection's record, keyed by field: `component: components`. |
| `dates` | list of string | `[]` | Fields that hold a date, written `YYYY-MM-DD`, `YYYY-MM`, or `YYYY`, or as a full ISO 8601 instant. |
| `derived` | object | `{}` | Values computed once per build from a date field against the as-of date, keyed by name: a count (`kind: days-left` or `days-since`) or `bands`. See [Dated data](/data/dates/). |
| `referenceDate` | string | | The date a list's `before` and `after` compare against: `YYYY-MM-DD`, or the dot path of a `_data` value. See [Lists](/data/lists/). |
| `markdown` | list of string | `[]` | Fields that hold Markdown, rendered through the page pipeline with their positions in the data file. |
| `llms` | boolean | `true` | `false` keeps the collection's record pages out of `llms-full.txt`. |
| `json` | object | every field | `json.fields` lists the record fields the page JSON publishes, in order; an empty list publishes none. |
| `evidence` | string | | Top-level field that maps a record's fields to the claims that back them. Each claim has an `id`, `title`, and `url`, and the page JSON publishes the same claims. |
| `onInvalid` | `error` or `skip` | `error` | What an invalid record does: `error` fails the build, `skip` leaves it out of the site with a warning. |
| `onRemoved` | `error`, `gone`, or `{redirect}` | `error` once `urls.lock.json` exists | What a record that was published and is no longer in the collection does. See [Stable URLs](/data/urls/). |
| `lifecycle` | object | | A record's state and what retirement does: `lifecycle.field` (default `state`), `lifecycle.states`, `lifecycle.retired`, `lifecycle.replacement`, `lifecycle.url` (`retain` or `redirect`), and `lifecycle.machine`. Unset, every record is published. |
| `limits` | object | | Limits on the source: `limits.bytes` (default 2097152), `limits.records` (default 10000), and `limits.field` (default 100000 characters). |
| `views` | object | `{}` | Extra named pages built from every record, each with its own `template`, `permalink`, and optional `layout`. |
| `search` | object | | How record pages take part in search. See [Search](/data/search/). |
| `seo` | object | | How record and list pages are described to search engines. See [SEO](/data/seo/). |
| `changelog` | object | | How a record's changes are recorded: `changelog.track` and `changelog.ignore` name the fields, `changelog.labels` writes each event's summary, and `changelog.pages` builds the history pages and feed. See [Change history](/data/changelog/). |
| `raw` | `false` or object | `{}` | The raw data written as `data/<name>.raw.json`, `.csv`, and `.sha256`; `raw.private` lists fields left out; `false` writes none. |
| `index` | object | | A compact JSON index for the theme: `index.fields` and `index.bytes`. See [Feeds and machine output](/data/feeds/). |

The same keys, with their types, are in the published
[configuration schema](https://github.com/velella-sh/mizzen/blob/main/schema/config.schema.json) and in
[Configuration](/config/).

## Source kinds

A source is read, never written, by a build. The extension decides the format:

- **YAML** (`.yml`, `.yaml`) and **JSON** (`.json`): a list of records, or a mapping of id to record. A list needs an
  `id` field, or `id:` in the collection names another.
- **CSV** (`.csv`): a header row, then one record per row. The first column is the id unless `id` names another.
- **`https://` address**: a remote file of one of those formats. A build never opens a network connection. You run
  `mizzen data fetch`, which stores the bytes under `.mizzen/data/` and pins their hash in `mizzen.lock.json`.
- **`npm:<package>/<path>`**: a file inside an installed dependency, read from `node_modules`. Nothing is installed or
  fetched, and the file must stay inside the package folder.

A path that leaves the site, a scheme other than `https`, and a file over its limit are each one error naming the key.

## The lock file

`mizzen.lock.json` pins every remote and package source: the address, the SHA-256, and the size, plus an optional
`snapshots` entry per collection. A build trusts no stored file whose hash differs from the lock, and a missing or
changed one is `data.lock-mismatch` or `data.store-mismatch`.

```sh
mizzen data fetch      # fetch, store, and pin; --check compares without writing
mizzen data verify     # compare the lock with the data; changes nothing
```

The lock's shape is published as [`data-lock.schema.json`](https://github.com/velella-sh/mizzen/blob/main/schema/data-lock.schema.json).
[Recorded snapshots](/data/snapshots/) explains the `snapshots` entries.

## What an invalid record does

With a `schema`, every record is validated. By default a record that fails stops the build and the finding names the
field and its line. `onInvalid: skip` leaves the record out, warns, and ends the build with `data.records-skipped`, so
a skip is never silent. Every finding is in [Data findings](/data/validation/).
