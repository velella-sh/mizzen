---
title: Change history of data
description: Record every change to a collection, show a record's own history, and build changelog pages and a feed from it.
---

# Change history of data

A collection's history is an append-only file committed with the site. The build only reads it: it never computes a
change and never reads the clock. The date of every event comes from the collection's snapshot, so the same data and
the same lock write the same history and the same pages.

## The history file

`data-changes/<collection>.jsonl` holds one JSON object per line, keys in a fixed order, LF endings. A line is never
rewritten; the file only grows. Every event has an id, a type, a record, and a date:

| Field | Meaning |
| --- | --- |
| `id` | The first 16 hex characters of the SHA-256 of the collection, record, type, field, and date. |
| `type` | `added`, `removed`, `changed`, `renamed`, or `imported`. |
| `record` | The record's id; for `imported`, the collection's name. |
| `field` | The changed field, for `changed`. |
| `old` | The earlier value, for `changed`; absent when the field did not exist. |
| `new` | The current value, for `changed`; absent when the field was removed. |
| `from` | The earlier id, for `renamed`. |
| `fields` | The tracked fields' values, for `added`. |
| `count` | How many records were loaded, for `imported`. |
| `ref` | The git ref of the import's snapshot. |
| `date` | The collection's snapshot `capturedAt`, never the build clock. |

A rename is one `renamed` event, not a removal and an addition. Records are matched by id, never by position, so
reordering a source records nothing.

## Record changes

```bash
mizzen data changes                # list what changed since the recorded state
mizzen data changes --write        # append the events to data-changes/<collection>.jsonl
mizzen data changes --check        # fail when tracked data changed without an entry
mizzen diff --base origin/main     # preview the entries that the next run would append
```

`--check` is the CI gate: a pull request that changes a tracked field fails until the history entry is committed with
it. `data changes` needs a snapshot date for the collection, written by `mizzen data snapshot` or `mizzen data fetch`.

## Show a record's own history

A record template repeats its own events, newest first, with a `:::changes` block:

```md
## History

:::changes
- :field[date] — :field[type] :field[record]
:::
```

The block reads the event's fields like a record's fields. A renamed record follows its earlier ids, so a chain of
renames still shows the first `added` event. A record with no events gets no block, and the history is not read for a
page whose template does not use `:::changes`.

The theme receives the same events as `LayoutProps.record.changes` and `Page.record.changes`, newest first.

## Changelog pages and feed

Turn the ready-made pages on for a collection:

```yaml
collections:
  packages:
    source: _data/packages.yml
    changelog:
      track: [title, eol]
      pages: true
```

The build writes `/changes/<collection>/` with the newest events, one page per snapshot date at
`/changes/<collection>/<date>/`, and an Atom feed at `feeds/<collection>-changes.xml`. A page uses the `list` layout and
a list query over `<collection>.changes`, so a theme renders it like any other list page. The feed's entry id is the
event id. A collection with no history file builds no page and writes no feed.

The history is also a read-only collection named `<collection>.changes`: lists, filters, grouping, feeds, and search
read it like any other collection, while no template or page is built from it and it is never written back to the
source.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `track` | list | `[]` | Fields whose changes are recorded. |
| `ignore` | list | `[]` | Fields never recorded, even when `track` names them. |
| `labels` | object | | A summary template per event type; `{field}`, `{old}`, `{new}`, `{from}`, `{count}`, and record fields are replaced. |
| `importThreshold` | integer | no limit | A run that finds more events than this is written as one `imported` event. A first load is always one. |
| `pages` | boolean | `false` | Build the changelog pages and the Atom feed. |

## Checks

`mizzen check site` reports a history line that is not a valid event, with its file and line. `mizzen data changes
--check` fails CI when tracked data changed without an entry. The pages and the feed are deterministic: the same data,
lock, and as-of date write the same bytes.

The history is file level only: it records a change to a record's fields, not to a line inside a field.
