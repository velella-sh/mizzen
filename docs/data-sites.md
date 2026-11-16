# Data sites

This note fixes the words and the rules a site built from data uses. It describes any site; it names
no product and no data set. The types it refers to are in [`src/contracts/data.ts`](../src/contracts/data.ts).

## Terms

- **Source** is one data file the site owns or pulls in, such as a YAML, JSON, or CSV file. A source is
  read; it is never written by a build.
- **Collection** is one source, read into records, and given the rules that turn it into pages: the
  field that is the record's id, its template, its URL pattern, and its schema. A collection has a
  name, lowercase letters, digits, and hyphens.
- **Record** is one mapping inside a collection: an `id` and its fields. The fields are data. A record
  is keyed by its id, compared by code point, without case folding.
- **Position** is where a record, or one of its fields, sits in its source: the file, the start line
  and column, and the end line and column, inclusive. Positions count Unicode code points, so an
  astral character is one column.
- **Template** is a Markdown page under `_templates/` with front matter and body. It is not a page and
  not an asset: it is instantiated, once per record, into a page.
- **Record page** is one page built from one record and its collection's template.
- **List page** is one page that shows records of a collection: filtered, sorted, grouped, and
  paginated. It is an ordinary page whose front matter asks for the list.

## Rules

1. **Records are data.** A record's fields are values, not HTML. The engine hands them to the layout;
   the theme decides how they look. A field the config marks as Markdown is rendered by the same
   Markdown pipeline as a page body.
2. **A record page keeps the position of its record.** The page's source is the record's position in
   the data file, and every value the page renders carries the position of the field it came from.
   That is what makes a data page editable by an agent: the page names the file and the span to edit.
3. **The template is the place for shared wording.** Text that every page of a collection shares lives
   in the template; text that differs lives in the record. An edit that changes one page changes the
   record; an edit that changes all of them changes the template.
4. **Nothing reads the clock.** Not the current time, not the current date, not a file's modification
   time, and not the build's start. A date in output comes from the config or from a record field, so
   two builds of the same input, on different days, give the same bytes.
5. **Order is fixed.** Records keep their source order unless a query names a sort; a sort falls back
   to the id for ties; files are written sorted by path. Two builds of the same input are byte for
   byte the same site.
6. **A content problem is a diagnostic, not a crash.** A missing field, a broken reference, an invalid
   record, a colliding URL, or an unreadable source carries its file and span. A throw is a bug in the
   engine.
7. **A build reads only what it can prove.** Local sources are read in place; a remote source is read
   from the store the lock file names, and a build never opens a network connection. The cache key
   covers every source that was read.
8. **Adding is allowed; removing is not.** A contract field, a config key, or an output file may gain
   a field in a later version. An existing name keeps its meaning.

## Showing data in a page

- `:data[path]` shows one value as text. `path` is dot-separated and is read from `_data` first, where a number
  indexes a list; when that finds nothing, the first segment may name a collection and the second a record id, so
  `components.button.name` reads one field of one record. The resolved text is written into the Markdown twin too.
- `::data-table{from=… columns=…}` renders records as the table a Markdown table produces. `columns` is a
  comma-separated list of field paths, `sort` names one field, and `where` filters on one pair written with its value
  quoted: `where="status=stable"`. Every collection row carries the record's own id as `id`, so `columns=id` works for
  a list and for a mapping of id to record; equal sort values fall back to the id and then to source order.

## List pages

An ordinary page becomes a list page when its front matter declares `list`:

```yaml
list:
  collection: posts
  where:
    status: published
    tags: [news, release]
    date: { after: reference-30d }
  sort: [date desc, title]
  group: { field: date, by: month, order: key, missing: Undated }
  perPage: 10
  splitGroups: false
  fields: [title, date]
  expand: { field: tags, permalink: /tags/{value|slug}/, title: Tagged {value} }
```

`where` keeps the records every entry matches: a scalar is equality, a list is "one of", and a mapping is `exists`,
`before`, or `after`. A date is `YYYY-MM-DD`, an ISO 8601 instant, or `reference` with an optional `+Nd`, `-Nd`, `+Nm`,
or `-Nm`; `reference` is `collections.<name>.referenceDate`, either a fixed date or the dot path of a `_data` value, so a
query never reads the clock. `sort` names one or two fields, each optionally followed by `asc` or `desc`; text compares
by code point, a record without the field sorts last, and ties fall back to the id and then to source order.

`group` builds one group per value of a field, or per `year` or `month` of a date field. A record with a list value joins
every group it names, and a record without a value stays in the group named by `missing` (default `(missing)`). Groups
order by `key` or, with `order: size`, largest first and then by key. `perPage` writes page two onwards at
`<url>page/<n>/`; a grouped page keeps each group whole unless `splitGroups` is true. `fields` is what the layout and the
Markdown twin receive, so the props stay small.

`expand` builds one page per value of a field at its own pattern, and the declaring page keeps an index of the values
with their counts. A value that has no records gets no page, and two values that fill one URL are a duplicate-URL error.
Each list page defaults to the layout `list` (or the page's own `layout`), receives `LayoutProps.list`, and gets a
Markdown twin whose table holds the fields the page named. Only a list's first page enters `llms.txt`, and list pages are
left out of `llms-full.txt` because their records are already there.

## Record pages
A collection that names both `template` and `permalink` builds one page per record. The template is Markdown under
`_templates/`; its body may use these directives, and its front matter fills `{field}` placeholders from the record
(`{{` and `}}` are literal braces):

- `:field[path]` shows one field, with `data-src` naming the value's line in the data file. A dotted path reads a nested
  value; an absent optional field renders nothing. A field the schema does not declare, or a value that is not a scalar,
  is an error at the directive. A field under `collections.<name>.markdown` is rendered through the Markdown pipeline and
  keeps each block's line in the data file.
- `:::if{field=path}` keeps its body only when the field has a value. `:::each{field=path}` repeats its body once per
  item of a list, with the item's own fields first. A template may nest one block inside another, not more.
- `:::records{from=collection where="field=field" sort=field limit=n}` repeats its body for records of one other
  collection; `where` compares a candidate field with a field of the current record.

A record page's front matter layout is the template's `layout`, else `record`. Its `Page.record` names the collection, the
id, the record's position, the template, and the fields that fell back to the default language. `LayoutProps.record`
carries the fields in the page's language and a `links` map that resolves each configured reference field to the URL of
the record it points at.

A collection may declare `views`: extra named pages built from the same record, each with its own template, URL pattern,
and layout. A view page's canonical URL is the record's main page, and the main page's `Page.record.views` (also
`LayoutProps.record.views`) maps each view name to its URL. View pages stay out of navigation, the search index, the
sitemap, the feeds, and `llms.txt`/`llms-full.txt`; their manifest entry names the view. A view never changes the record
and is not built when the record's main page is not built.

## Search over data

A collection's record pages enter the Pagefind index with their title, description, and body like any doc page. Its
`search` key adds what the theme can filter, sort, and show:

```yaml
collections:
  posts:
    source: _data/posts.yml
    template: _templates/posts.md
    permalink: /posts/{id}/
    dates: [date]
    search:
      meta: [author, date]
      filters: [status, tags]
      sort: [date, rank]
      aliases: aka
```

`search.meta` writes each field as result metadata under its own name. `search.filters` writes each field as a Pagefind
filter, with one value per item for a list; every record page also carries `collection` as a filter. A field with more
than 100 distinct values is free text, so it is reported as `search.filter-too-many` and left out. `search.sort` writes
a sort key for a field the collection marks under `dates`, a field whose values are all numbers, or a field whose values
are short text; anything else is reported as `search.sort-unsupported` and left out. `search.aliases` names a string or
list field of other names, which is indexed as the `aliases` metadata and never shown as page text.

A record whose own `search` field is `false`, a page whose front matter says `search: false`, and a named view stay out
of the index. `search: false` in the site config writes no index at all.

`search-facets.json` lists each filter and the number of record pages per value, with the collection filter first and
every name and value in code-point order; it holds no labels or translations:

```json
{
  "query": { "text": "q", "filter": "filter.{field}", "sort": "sort", "order": "order" },
  "filters": {
    "collection": { "posts": 3 },
    "status": { "draft": 1, "published": 2 },
    "tags": { "news": 2, "release": 2 }
  }
}
```

Its `query` object names the search results page's parameters, and `opensearch.xml` uses the same text parameter:

| Purpose | Parameter | Example |
| --- | --- | --- |
| Search text | `q` | `?q=cache` |
| A filter | `filter.<field>` | `&filter.status=published` |
| Sort field | `sort` | `&sort=date` |
| Sort direction | `order` | `&order=desc` |

A result page the theme builds reads those names; a parameter it does not know is ignored, never an error. The theme
owns the results page, the engine only publishes the index and the names.

## A compact index for the theme

`collections.<name>.index` writes `data/<name>.index.json`: a column layout for the theme's data explorer, with the
declared fields once in `columns` and one array per record in `rows`, ending with the record's page URL.

```yaml
collections:
  posts:
    source: _data/posts.yml
    index:
      fields: [title, date, status]
      bytes: 100000
```

Rows keep the collection's source order, and a record with pages in several languages is written once with the default
language's URL. A file over `index.bytes` (default `100000`) is split by bytes, never by record count, into
`data/<name>.index.1.json`, `.2.json`, and so on; the head file then lists them under `chunks` and carries no `rows`.
Each written file's plain and gzipped size is reported as `collection-index.size`. A collection without the key writes
no file.

## URLs that do not move

A URL pattern may filter a field with `|slug`: `{name|slug}` lowercases the value, keeps the letters and digits of every
script, and turns each run of anything else into one hyphen. Nothing is transliterated, and a slug never holds a `/`, so
`{scope|slug}/{name|slug}` gives a scoped name two segments with no other change.

Two records a pattern cannot tell apart would write one file, so both are reported. `collections.<name>.disambiguate`
names a field, such as `id`, that is appended to the URL of each record whose pattern gives the same URL as another
record's: a record with an address of its own keeps it, so adding a colliding record does not move the pages already
published. `/items/jane/` becomes `/items/jane-42/` for the records that collided, and the result does not depend on the
order of the records.

`urls.lock.json` holds every record page's current URL and the ones it had before. Every build checks against it: a
changed URL is an error until `mizzen build --update-urls` accepts it and keeps the old one as a redirect, and a removed
record is an error unless the collection says what its absence means. `urls check` prints the same comparison as text or
JSON without writing anything. `Page.record.previousUrls` carries each record page's earlier URLs, which the redirects
output writes as one-hop redirects; a lock entry a record no longer occupies keeps its id and URL, so a new record cannot
take the address over.

`collections.<name>.aliases` names a field whose string or list values are earlier ids or paths of a record; each one
redirects to the record's page without the lock file. `collections.<name>.onRemoved` is `error` (the default once a lock
file exists), `gone` (a notice at each old URL that says the record was removed), or a `redirect` to a page on the site.

`urls.json` maps each collection's record ids to their page URLs, absolute when the site sets `url`, and carries the
engine version and a hash of the data. Only the default language names a record in it. Like the rest of the data
contract, the file only gains fields.

With `languages` configured, every record gets one page per language: `<template>.<lang>.md` is used when it exists,
`<field>.<lang>` is read from a mapping and falls back to the default language, and pages that share a record carry the
same `translation_key`. `collections.<name>.llms: false` keeps a collection's pages out of `llms-full.txt`.

A navigation entry `- collection: <name>` expands to that collection's record pages, optionally ordered by `order`,
cut to `limit`, and titled by `title`. A link written `record:<collection>/<id>` becomes the record page's URL; a link to
a missing record is a broken link at its position in the page or template.

The data API (`/api/v1/`) is the stable, versioned way for another program to read records; its design is in
[design/data-api.md](design/data-api.md).

## Limits

A collection source is bounded by default at 2 MiB, 10,000 records, and 100,000 characters per field. Raise one
limit with `collections.<name>.limits.bytes`, `.records`, or `.field`; a source over a limit is one error naming the
limit and the key, never a silently truncated file.

## What the theme receives

- A record page uses the layout named in its template's front matter, else the layout `record`. A list
  page uses the layout named in its front matter, else the layout `list`. Both are layout names, not
  page kinds: the page itself stays a `doc` page.
- `LayoutProps.record` on a record page: the collection's name, the record's id, its URL, its
  fields as data, and on the main page the URL of each named view.
- `LayoutProps.list` on a list page: the records selected for that page, the groups, and the page's
  number, total, and previous and next URLs. A group of an expanded list also carries the URL of its own
  page and its count, which is how the index page links to each value.
- `Site.collections` on every page: each collection's records with their ids and positions. A collection read
  from an `npm:` source also carries `package.name` and `package.version`.
- A record's `keyPositions`: where each field's key sits, so a rename can point at the key and never at the value — the
  YAML or JSON key, or the CSV header cell, which every row shares.
- A record's `normalizedDates`: each field the config marks under `dates`, written `YYYY-MM-DD` as it is in the
  source, or as a UTC ISO 8601 instant when the source holds one. The field itself keeps the value as written.
- `Page.record` on a record page: the collection name, the record id, and the record's position.
- The ordinary contract, unchanged: navigation, pager, head, islands, and the site model.

The theme does not receive HTML built from field values, and it does not receive the template's
source. It may rely on the field names a site declared, never on a fixed list of fields.

## What stays in the engine

- Reading sources, keeping positions, validating records against a schema, and checking unique ids
  and references.
- Choosing which records become pages, filling URL patterns, detecting collisions, and keeping the
  URL lock file.
- Queries: filters, sorts, grouping, pagination, and the reference date that replaces the clock.
- The generated artifacts: Markdown twins, page JSON, feeds, sitemap entries, search metadata, and
  the source map, each of which names the data file and the record's span.
- Every diagnostic and every token of the cache and dependency graph.

## Frozen on

Frozen on 2026-11-15. The contract in `src/contracts/data.ts` is guarded by
`test/data-contract-freeze.test.ts`; a field is removed or retyped only with a new note here.
