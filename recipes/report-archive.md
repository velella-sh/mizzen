# Publish a reproducible report archive

Offing writes the scan; Mizzen publishes it. Offing appends one record per scan to a collection, and the site turns
those records into a latest page whose URL never moves, an archived page per run addressed by the run id, and a
gallery the reader can filter. Every archived report can be rebuilt from the inputs its run pinned.

## The records Offing writes

`_data/scans.yml`, one record per scan, committed with the data it describes:

```yaml
- id: scan-2026-03-01
  date: 2026-03-01
  commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  status: clean
```

`id` is the run's address and names its archived page. `date` is the day the scan is for; `commit` is the revision the
scan read. A record missing one of the three is reported as `data.report-run-invalid`, and two records with one id as
`data.report-run-duplicate-id`; neither is archived.

```yaml
collections:
  scans:
    source: _data/scans.yml
    template: _templates/scan.md
    permalink: /scans/{id}/
    dates: [date]
```

`latest/index.md` lists one run (`perPage: 1`), and `gallery/index.md` lists every run with `date`, `commit`, and
`status`. The filter pages are ordinary list front matter:

```md
---
title: Recent scans
list:
  collection: scans
  where: { date: { after: 2026-03-05 } }
  sort: date desc
  fields: [date, commit, status]
---
```

## Publish a run

```bash
mizzen data snapshot scans   # pins the commit and date of _data/scans.yml in mizzen.lock.json
mizzen data changes --write  # records the run's ref and date in data-changes/scans.jsonl
mizzen build
git add _data/scans.yml mizzen.lock.json data-changes/scans.jsonl
git commit -m "Publish the 2026-03-01 scan"
```

A build never reads the clock and never fetches. The run's `id`, `date`, and `commit` are in the record; its locked
inputs are the snapshot taken when it was published. Keep that snapshot: `mizzen.lock.json` holds one entry per
collection, so the next `data snapshot scans` replaces it, and `data-changes/scans.jsonl` is where the run's ref
survives.

## Rebuild an archived report

Check out the ref the run was published from, restore that run's `snapshots.scans` entry into the lock, and build:

```bash
git worktree add ../scan-2026-03-01 <ref>
cd ../scan-2026-03-01
npx mizzen build
sha256sum -c _site/data/scans.sha256   # optional: the raw files and checksums
```

The archived page (`/scans/scan-2026-03-01/`) comes out byte for byte as it was published: same Markdown, same HTML,
same URL. The latest page is not a reproduction target; it follows the newest run. `mizzen data verify` checks that the
current data still matches the current lock, and `node --test test/report-archive/rebuild.test.ts` in the engine publishes
two runs and compares a rebuilt first report with its published output.
