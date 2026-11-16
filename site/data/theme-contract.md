---
title: Theme contract for data pages
description: What a theme receives for record and list pages, the search filter file, the collection index, and what a theme must do.
---

# Theme contract for data pages

A theme draws data pages with the same layouts it draws any page with. The engine reads, validates, and positions the
data; the theme only turns what it receives into HTML. A data site adds two optional props and a few files to the
ordinary [theme contract](/plugins/).

## Layouts

A record page uses the layout named in its template's front matter, otherwise the layout `record`. A list page uses the
layout named in its own front matter, otherwise the layout `list`. These are layout names, not page kinds: the page
itself stays a `doc` page. A theme without those layouts must be told one with `layout:`, as the
[example site](https://github.com/velella-sh/mizzen/tree/main/examples/data-site) does.

## `LayoutProps.record`

Set on a record page; unset on every other page.

| Field | Type | Meaning |
| --- | --- | --- |
| `collection` | string | The collection's name. |
| `id` | string | The record's id. |
| `url` | string | The record page's URL, including `base`. |
| `fields` | object | The record's fields, or only those the page named. |
| `links` | object | Reference fields resolved to the URL of the record page they point at, keyed by field. |
| `views` | object | URL of every view of this record, keyed by view name. Main page only. |

## `LayoutProps.list`

Set on a list page; unset on every other page.

| Field | Type | Meaning |
| --- | --- | --- |
| `collection` | string | The collection's name. |
| `records` | list of record | The records on this page, in the list's order, with the `fields` the list named. |
| `groups` | list of group | The same records grouped: `key`, `records`, and for an expanded list the group's own `url` and `count`. |
| `pagination` | object | `page`, `total`, and `previous` and `next` URLs when there are any. |

On the index page of an expanded list, each group's `records` is empty and its `count` and `url` are how the page
links to every value.

## Files a theme reads

| File | Read for |
| --- | --- |
| `search-facets.json` | The filter names and values with counts, and the query parameter names. See [Search](/data/search/). |
| `data/<collection>.index.json` | A compact column layout of a collection's records and page URLs, for a client-side list. Written for a collection with `index`. |
| `urls.json` | Each record id and its page URL, for links between sites. See [Stable URLs](/data/urls/). |

## What a theme must do

- Rely on the field names a site declared, never on a fixed list of fields.
- Print values as text. The theme does not receive HTML built from field values, nor the template's source.
- Treat `record` and `list` as optional: a page that is neither has neither.
- Draw filters from `search-facets.json` and send the choice with the parameters in `query`.
- Keep words, labels, and translations in the theme: the engine writes none for filters.

## What stays in the engine

Reading sources, positions, validation, unique ids, queries, grouping, pagination, URLs, redirects, feeds, search
indexing, SEO tags, and share images are the engine's. A theme that needs one of them reads the model; it never
recomputes it.

## A shared fixture

[`fixtures/data-site`](https://github.com/velella-sh/mizzen/tree/main/fixtures/data-site) is a small site with three data
files and thirty records. The engine's tests read it, and a theme repository can copy it to test its `record` and `list`
layouts.
