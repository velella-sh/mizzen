---
title: Stale pages
description: Name the files a page describes, compare them with a committed review lock, and let the command line, the build, the theme, and an agent say which pages are out of date.
---

# Stale pages

A guide page describes a config key, a schema, a command. When the file behind it changes, the prose can go out of date
without anyone noticing. A page can name the files it describes, and Mizzen compares them with a committed lock of what
was reviewed, so `mizzen stale`, a pull request, the page itself, and an agent can say which pages need another read.

The comparison reads file contents only: no git history, no clock, no network. The same files and lock give the same
answer on any machine, on any day.

## Name the files: `covers`

List the files and globs a page describes in its front matter:

```yaml
---
title: Configuration
covers:
  - schema/config.schema.json
  - src/config/*.ts
---
```

A path is relative to `stale.root`, which is the site root by default:

```yaml
# mizzen.yml
stale:
  root: .
  severity: warning
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `stale.root` | string | `.` | The folder `covers` paths are relative to, relative to the site root. A path or glob that leaves it is an error. |
| `stale.severity` | `info`, `warning`, or `error` | `warning` | How `mizzen check` and `mizzen doctor` report a stale page. |

`*` matches within one segment, `**` across folders, and `?` one character. A glob that matches nothing is a warning,
because it usually means a rename left the page pointing at a file that is gone. `covers` is read from the page's own
front matter, not from `defaults`.

## The review lock

`docs-review.lock.json` in the site root records every page with `covers`: the date it was reviewed and the SHA-256 of
each covered file as it was then.

```json
{
  "version": 1,
  "pages": {
    "configuration.md": {
      "reviewed": "2026-03-15",
      "files": [{ "path": "schema/config.schema.json", "sha256": "…" }]
    }
  }
}
```

`version` is `1`; `pages` is keyed by the page's source path relative to the site root; each entry has `reviewed`
(`YYYY-MM-DD`) and `files`, sorted by `path` with a `sha256` for each. The file is canonical JSON with LF line ends, so
the same review writes the same bytes, and the schema is `schema/docs-review.schema.json`.

## Mark a page as reviewed

After reading the page against its files, record the current hashes:

```sh
mizzen stale mark configuration.md --reason "checked the new key"
mizzen stale mark --all
```

`--date YYYY-MM-DD` sets the review date; without it the date is the commit date of `HEAD`, never the system clock. Each
mark also appends a line to `docs-review.audit.jsonl` with the reason, so the lock shows what was marked and when, and
the audit shows why.

## The report

```sh
mizzen stale                    # every page whose covered files differ from the lock
mizzen stale --json             # the same, as version 1 JSON
mizzen stale --fail             # exit 1 when any page is stale, for a gate
mizzen stale --changed src/config/load.ts      # the pages whose covers match these files
mizzen stale --git-diff origin/main            # the pages a change on this branch touches
```

A page is stale when a covered file changed, was removed, or was added under a glob. A page with `covers` and no lock
entry was never reviewed, so its files count as added and it has no `reviewed` date. A file that only moved, with the
same content at a new path, is reported as a move and does not make the page stale; the report names the new path so
the page's `covers` can follow it.

`mizzen check` and `mizzen doctor` report the same comparison as `stale.page`, at `stale.severity`, with one finding
per page naming the files and their change. The other `stale.*` ids cover a `covers` value that cannot be read, a path
outside the root, a glob that matches nothing, and a lock that does not match its schema.

## The theme and the page JSON

The build hands the state to the layout on the ordinary page prop, and writes it to the page's `index.json`. It is
absent for a page without `covers`, for one whose files are current, and for a site that has no review lock.

| Field | Type | Meaning |
| --- | --- | --- |
| `stale.reviewed` | string | `YYYY-MM-DD` of the last review; absent when the page was never marked. |
| `stale.files` | list | The files that differ, sorted by `path`. |
| `stale.files[].path` | string | Path relative to `stale.root`, with `/` separators. |
| `stale.files[].change` | `changed`, `removed`, or `added` | What happened since the review. |

A theme can show a note on a stale page without building anything:

```ts
export default function doc({ page }) {
  const note = page.stale === undefined ? "" : `<aside class="stale">This page may be out of date.</aside>`;
  return `<!DOCTYPE html><html><body>${page.html}${note}</body></html>`;
}
```

The page's `index.json` carries the same object as `stale`, so an agent that reads the page JSON sees the review date
and the files without running a command.

## In CI and with an agent

`recipes/stale-docs.yml` runs on a pull request, asks `mizzen stale --git-diff` which pages the change touches, and
comments the list on the pull request. It never fails the pull request: a stale page is a prompt to read, not a broken
build. Nothing is commented when no page matches.

An agent connected to the MCP server calls `get_stale_pages` to get the same list: each entry has the page's `source`,
the `reviewed` date, the `files` that differ with their `change`, and a `fix` hint. It reads the page with
`get_block_source` and changes it with `propose_edit`; marking a page as reviewed stays a person's decision.

## Limits

- **File level only.** The check does not read symbols, so a changed comment in a covered file makes the page stale.
  Symbol-level detection is left for a later version.
- **Not a correctness claim.** A page that is not stale has only not been seen to change under its files. It may still
  be wrong, and `mark` records that a review happened, not that the page is right.
- **Bounded.** The number and size of covered files per page are limited, and a symbolic link is not followed out of
  `stale.root`.
