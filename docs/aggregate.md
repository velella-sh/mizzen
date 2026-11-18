# Aggregating data

An aggregate collection summarizes another collection instead of reading a file. It declares `source` as the source
collection's name and an `aggregate` block; the summary is a normal collection, so a list page, a record page, a feed,
search, and the static API read it exactly as they read a file-backed one.

```yaml
collections:
  sales:
    source: _data/sales.yml
    dates: [date]
  monthly:
    source: sales
    aggregate:
      by:
        - { field: region }
        - { field: date, period: month, timezone: Europe/Berlin }
      metrics:
        orders: { op: count }
        customers: { op: count-distinct, field: customer }
        revenue: { op: sum, field: amount, decimals: 2 }
        average: { op: average, field: amount, decimals: 2 }
        first: { op: min, field: amount }
        last: { op: max, field: amount }
      where: { channel: web }
      missing: skip
      empty: keep
```

The source must be a collection read from a file. An aggregate of an aggregate is reported and left out, so the
dependency chain stays one level deep and deterministic.

## Grouping

`by` is one field or a list of fields. Every distinct combination of typed values is its own group, so `1` and `"1"`
are different keys. A field without a value follows `missing`:

- `skip` (default) leaves the record out of every group.
- `group` puts it in a group whose missing key is `null`, one group per distinct combination.

A `by` entry may bucket a date field by `month` or `year`. `timezone` is required and must be an IANA zone: an ISO 8601
instant is placed in that zone before its month or year is read. A civil date (`YYYY-MM-DD`, `YYYY-MM`, `YYYY`) has no
zone and keeps the month it writes. Nothing reads the host zone or the clock, so a monthly report is repeatable.

## Metrics

| `op` | Reads | Result |
| --- | --- | --- |
| `count` | every record | the group's size |
| `count-distinct` | `field` | how many distinct scalar values the group holds |
| `sum` | `field` | the sum of finite numbers, rounded to `decimals` |
| `average` | `field` | the sum divided by the number of values read, rounded to `decimals` |
| `min` | `field` | the lowest number or text, by code point |
| `max` | `field` | the highest number or text, by code point |

`decimals` is from 0 to 12 and defaults to 2. A sum or average is a JSON number: trailing zeros are not written.
A null or absent value is skipped by every metric; for `average` it is also left out of the denominator. A value that
is not a finite number where `sum` or `average` needs one is a `data.aggregate-number` error naming the record and the
field. `min` and `max` accept text or numbers, all of one kind in a group; a boolean, list, mapping, or a mixed group is
a `data.aggregate-bound` error rather than a guessed bound.

A group whose metrics are all null follows `empty`: `keep` (default) publishes it with null values, and `omit` leaves it
out. A count is never null, so it keeps a group that would otherwise be empty.

## Filtering

`where` uses the same shape as a list page's `where`: a scalar is equality, a list is "one of", and a mapping may name
`exists`, `before`, or `after`. The filter runs before grouping, so a record it removes contributes to no metric. A
before/after test reads the source collection's `referenceDate` or the site's `asOf` date; a `_data` path is not
resolved here.

## Ids and order

A group id is built from its key values, slugged and joined with hyphens, such as `eu-2026-01` or `missing`. A slug
collision, an id that is unsafe as a file name, or a value that slugs to nothing adds eight hexadecimal characters of a
hash of the typed key. Groups are ordered by their key values, numbers first, then text, then booleans, then missing.
The order and every id are independent of the order the source rows arrived in.

The summary record carries the grouping fields, the metrics, and the collection's id field. Its source position is the
aggregate's line in `mizzen.yml`, because that is the file to edit when the rule changes.

## Incremental builds

An aggregate collection depends on its source collection as a whole and on the source records that feed each summary
record. A record that moves between groups therefore refreshes both summaries: the new group names it, and the
collection-wide edge reaches the old group too. The dependency graph and the invalidation plan carry those edges, so an
incremental build writes the same bytes as a full one.

The aggregate's configuration is part of the build key, so changing `by`, a metric, or `where` refreshes the summary.
The source collection's `transform`, schema, dates, and derived values run before aggregation; the aggregate's own
`transform`, schema, `unique`, `dates`, and `derived` rules run on the summary records, like any other collection.

## Publication

Declare the aggregate like any collection, then name it where a collection is named:

- a list page's `list.collection` shows the summary;
- `template` and `permalink` build one page per summary record;
- `api.collections.<name>` publishes it at `/api/v1/<name>.json`, with the same count as the list page;
- `feeds`, `search`, `index`, and `raw` read it through the same collection hooks.

See [`examples/monthly-report/`](../examples/monthly-report/) for raw rows, a monthly summary, a summary page, an
archive page, and the static API in one runnable site.
