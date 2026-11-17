---
title: Lists
description: List pages. The list front matter, every where operator, sorting, grouping, pagination, expand, and the reference date that replaces the clock.
---

# Lists

An ordinary page becomes a list page when its front matter declares `list`. The page shows records of one collection,
filtered, sorted, grouped, and paginated. The examples are the pages of
[`examples/data-site`](https://github.com/velella-sh/mizzen/tree/main/examples/data-site).

```yaml
---
title: Releases
list:
  collection: releases
  sort: [date desc]
  group: { field: date, by: month }
  perPage: 5
  fields: [id, date, status, component]
---
```

| Key | What it does |
| --- | --- |
| `collection` | The collection to list. Required. |
| `where` | Keeps the records that every entry matches. |
| `sort` | One or two fields, each optionally followed by `asc` or `desc`. |
| `group` | Groups by a field, or by the `year` or `month` of a date field. |
| `perPage` | Splits the list into pages of this many records. |
| `splitGroups` | Lets a group continue across pages. Default `false`. |
| `fields` | The fields the layout and the Markdown twin receive. |
| `expand` | Builds one page per value of a field. |

## Filtering with `where`

`where` is a mapping of field to condition. A record is kept when every entry matches.

| Condition | Written | Matches |
| --- | --- | --- |
| Equality | `status: stable` | The field equals the value. |
| One of | `tags: [news, release]` | The field equals one of the values, or a list field holds one. |
| `exists` | `summary: { exists: true }` | The field has a value; `false` matches records without one. |
| `before` | `date: { before: 2026-01-01 }` | The date is earlier than the given date. |
| `after` | `date: { after: reference-30d }` | The date is later than the given date. |

A date is `YYYY-MM-DD`, an ISO 8601 instant, or `reference` with an optional `+Nd`, `-Nd`, `+Nm`, or `-Nm`: days or
months from the reference date. A condition on a field the collection does not declare is `data.list-field`.

## The reference date

A list never reads the clock. `reference` is `collections.<name>.referenceDate`: a fixed date, or the dot path of a value
in `_data`.

```yaml
collections:
  releases:
    referenceDate: 2026-07-01
```

With that, `after: reference-30d` always means "after 2026-06-01". Building the same data twice gives the same bytes on
any day, and the lists change only when you change the date, which is a diff you can read. Use a `_data` path such as
`site.today` when a pipeline sets the date. A `reference` with no `referenceDate` is an error, never a guess.

## Sorting

`sort: [date desc, title]` sorts by date, newest first, then by title. Text compares by code point, not by locale, so the
order is the same on every machine. A record without the field sorts last. Ties fall back to the record's id and then to
its place in the source, so the order is always total.

## Grouping

`group: { field: status, order: key }` builds one group per value of the field. With `by: year` or `by: month` on a date
field, one group per year or month, keyed `2026` or `2026-07`.

| Key | Default | What it does |
| --- | --- | --- |
| `field` | required | The field to group by. |
| `by` | the value | `year` or `month`, for a date field. |
| `order` | `key` | `key` orders by group key; `size` puts the largest group first, then by key. |
| `missing` | `(missing)` | The title of the group of records that have no value. |

A record with a list value joins every group it names.

## Pagination

`perPage: 5` writes the first page at the page's own URL and page two onwards at `<url>/page/2/`. A grouped page keeps
each group whole unless `splitGroups` is `true`. The layout receives the page number, the total, and the previous and next
URLs in `LayoutProps.list`. A list with no records still builds one page.

## Expanding a field into pages

```yaml
list:
  collection: components
  group: { field: status }
  expand:
    field: status
    permalink: "/status/{value|slug}/"
    title: "Status {value}"
```

`expand` builds one page for each value of the field, at its own permalink, and the declaring page keeps an index of the
values with their counts. `{value|slug}` is the URL-safe form of the value; see [Templates](/data/templates/). A value
with no records gets no page, and two values that make one URL are a duplicate-URL error.

## What a list page becomes

A list page uses the layout named in its own front matter, otherwise the layout `list`, and receives `LayoutProps.list`.
Its Markdown twin has a table of the `fields` the page named. Only a list's first page enters `llms.txt`, and list pages
are left out of `llms-full.txt` because their records are already there. See the [theme contract](/data/theme-contract/).
