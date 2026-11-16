# Design note: stale pages

Epic: stale-docs (#461). Status: accepted.

## Problem

A page describes files: a config reader, a schema, a command. Nothing in `0.2.0` knows that. When the file changes
the page is silently out of date. The engine should say which pages to look at, and exactly which files moved.

## Definitions

- **`covers`** is a front matter key: a list of paths and globs, relative to `stale.root` (default: the site root). A page names the files it describes.
- **The review lock**, `docs-review.lock.json` in the site root, records for every page with `covers` each covered
  file's SHA-256 and the review date. `mizzen stale mark` writes it; a person or an agent runs it after reading the
  page against the files.
- **Stale** means one thing: *a covered file's content differs from the locked hash*. A covered file that was
  removed, or a new file that a glob now matches, also differs from the lock, so it counts too. A file that only
  moved (same hash at a new path) is reported as a move, not as staleness.

## Why a content hash, not git history

- No git history is needed: a shallow clone, a tarball, or a site built outside a repository gives the same answer.
- No clock and no network: the same files and lock give the same report. The review date is the commit date of
  `HEAD` or `--date`, never the system clock, so the lock is reproducible.
- Content, not commits: a reformat that git calls a change but that normalizes to the same bytes (line endings are
  normalized before hashing) is not stale; a revert to the reviewed content is clean again.
- The lock is committed, so a pull request shows what was marked reviewed and why.

## Limits

- **File level only.** The check does not read symbols; a changed comment in a covered file makes the page stale.
  Symbol-level detection is left for a later version.
- **A report, not a build failure**, unless the site asks: `stale.severity` chooses info, warning, or error, and the
  default is never error. `mizzen stale --fail` exits `1` for a script that wants a gate.
- **Bounded:** the number and size of covered files per page are limited, and symbolic links are not followed out of
  `stale.root`.
- **Not a correctness claim.** A page that is not stale has only not been *seen to change under* its files. It may
  still be wrong, and `mark` records that a review happened, not that the page is right.

## Pieces

| Piece | Where |
| --- | --- |
| Expand `covers` | `src/stale/covers.ts` |
| Hash files | `src/stale/hash.ts` |
| Read and write the lock | `src/stale/lock.ts`, `schema/docs-review.schema.json` |
| `mizzen stale`, `stale mark` | `src/cli/stale.ts`, `src/stale/report.ts` |
| Moves | `src/stale/moves.ts` |
| Diagnostics for `check` and `doctor` | `src/stale/diagnostics.ts` |
| Pages a change touches | `src/stale/changed.ts` |
