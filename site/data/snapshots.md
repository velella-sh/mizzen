---
title: Recorded snapshots of data
description: Record where each collection's data came from, show it on pages, ship it with the raw data, and check that it still matches.
---

# Recorded snapshots of data

A snapshot says where a collection's data was recorded from: the commit or the package version, the date, and the tool.
It is written to `mizzen.lock.json` by a command you run, never by a build, and the date always comes from the data
itself (a commit's time, a response's `Last-Modified` header), never from the build clock. So a build with the same data
and the same lock writes the same bytes.

## Commands

```bash
mizzen data snapshot posts      # a file collection: the last commit of its file, and that commit's date
mizzen data fetch               # npm: and https: collections: the pinned version or hash, and the date of the data
mizzen data verify              # compare the lock with the data as it is now; changes nothing
```

`data snapshot <name>` records the last commit that touched the collection's file and its commit time. It refuses a file
with uncommitted changes, because the recorded commit would not describe the data; pass `--allow-dirty` to record it
anyway. `data fetch` records a snapshot for every package and URL collection as part of writing the lock. For a URL the
date is the response's `Last-Modified` header, or its `Date` header when there is none, and an unchanged source keeps the
date the lock already holds.

`data verify` compares each collection with what the lock records. For a package or URL collection it compares the
content hash. For a file collection with a git snapshot it compares the file with the file at the recorded commit and
prints the first differing record with its position in the data file. It exits 1 on any difference and never rewrites the
lock. A file collection with no snapshot is skipped.

## What is recorded

The lock keeps one entry per collection under `snapshots`. A lock without snapshots stays valid.

| Field | Meaning |
| --- | --- |
| `source` | The path, URL, or `npm:` address the data was recorded from. |
| `ref` | The commit, or the package and exact version. |
| `capturedAt` | A `YYYY-MM-DD` date, or a UTC instant to the second. A millisecond timestamp is refused. |
| `tool` | The tool that recorded it, such as `git` or `npm`. |
| `toolVersion` | That tool's version. |

## Show it on a page

In a record template, `:snapshot[field]` prints one field of the collection's snapshot. `capturedAt` is printed as a
date in the page's language and calendar, and every other field as the lock holds it.

```md
Data from commit :snapshot[ref], recorded :snapshot[capturedAt].
```

A page theme also receives the snapshot as `snapshot` on the collection. A field the lock does not hold prints nothing and
adds a `data.snapshot-field` finding.

## Raw data

Each collection also writes its data as files you can download and check:

- `data/<name>.raw.json`: every record, with the snapshot.
- `data/<name>.csv`: the same records as CSV.
- `data/<name>.sha256`: a checksum for each file, in the format `sha256sum -c` reads.

```yaml
collections:
  posts:
    source: _data/posts.yml
    raw:
      private: [email]   # fields left out of both files
  drafts:
    source: _data/drafts.yml
    raw: false           # write no raw files
```

## Keep snapshots fresh

```yaml
snapshot:
  maxAgeDays: 90
```

`mizzen doctor` reports each collection whose `capturedAt` is more than `maxAgeDays` days before today. Without the option
nothing is reported. The build itself never reads the clock; only `doctor`, which does not write, is given today's date.

## Reproduce a build

```bash
mizzen data snapshot posts
git add mizzen.lock.json && git commit -m "Record the posts snapshot"
mizzen build
sha256sum -c _site/data/posts.sha256
mizzen data verify
```

Anyone with the repository can build again and get the same raw files and checksums, because the recorded date and commit
come from the data.
