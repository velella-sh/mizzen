# Baseline: latest report and reproducible archive

Epic: #521. Baseline for #522, before the archive work in #523 to #526.

## Fixture

A site with a `scans` collection (`_data/scans.yml`), a `date` field, `changelog.track: [status]`, a per-record
template, a latest list (`perPage: 1`) and an archive list. Two runs are published with the real commands:

```bash
mizzen data snapshot --name scans
mizzen data changes --write
```

Each run adds one record, commits `_data/scans.yml`, and pins a snapshot. The test lives in
[`test/report-archive/baseline.test.ts`](../test/report-archive/baseline.test.ts).

## What already worked

- `data snapshot` pins one snapshot per collection: the source, the git ref, the capture time, and the tool version.
  A second run replaces that single entry; the lock never grows a second snapshot for the same collection.
- `data changes --write` writes `data-changes/scans.jsonl`: an `imported` event for the first run and an `added` event
  for each later record, each with the date, the commit ref, and the changed fields.
- A latest list with `perPage: 1` shows the newest run; page 2 shows the earlier one. The archive list keeps both,
  newest first, and the filter and sort are ordinary list settings.
- Each record page keeps its URL when a second run is published, and its Markdown and HTML bytes are unchanged.
- A record page exposes its own change events through `changes`, and `/changes/scans/` lists events newest first.
- Two builds from the same data and lock write the same bytes.

## Confirmed gaps

1. **Only the newest snapshot survives.** `_data/.lock` has one entry per collection, so the earlier run's pinned
   commit is gone after the second snapshot. The archived record page shows the newest snapshot ref, not the one it
   was published with.
2. **A run has no identity.** There is no record for "run" and no URL or id a report can be archived under. #523 has to
   derive one from the pinned inputs.
3. **An archived URL is not stable by itself.** The URL is stable while the record stays in the data file, but nothing
   keeps the record or its snapshot after it leaves the file. #524 owns that.
4. **There is no gallery.** The archive list is a plain collection list; filtering by run, status, or date is manual
   front matter. #525 owns the consumer.
5. **A change event has no fields.** A template that asks for `:field[...]` on `/changes/scans/` gets a
   `data.list-field` warning, because a change record carries `type`, `record`, `date`, and `fields`, not the
   collection's own fields. The baseline treats it as a warning, not an error, and records it here instead of hiding it.

## Next

- #523 identifies an archived run from its pinned commit and date.
- #524 keeps latest and archived URLs stable when a record leaves the source file.
- #525 consumes the runs in a filterable gallery.
- #526 rebuilds an archived report from its inputs.
