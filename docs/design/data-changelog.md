# Data changelog

Status: accepted for 0.3.0 (`data-changelog`, #447).

A collection's history is an append-only file committed with the site. `mizzen data changes` finds what changed
between the recorded state and the current data and appends those events, dated by the collection's snapshot. The
build only reads the file; it never computes a change and never reads the clock.

## Events

One event describes one change to one record. Every event has an `id`, a `type`, a `record` id, and a `date`.

| `type`     | Extra fields                    | Meaning                                                              |
| ---------- | ------------------------------- | -------------------------------------------------------------------- |
| `added`    |                                 | The record id is new.                                                |
| `removed`  |                                 | The record id is gone and no other record names it as an earlier id. |
| `changed`  | `field`, `old`, `new`           | One tracked field has another value. An absent value has no key.     |
| `renamed`  | `from`                          | The record's id appears in another record's earlier ids (`aliases`). |
| `imported` | `count`, optional `ref`         | The first load of a collection, written once instead of many `added`.|

A `renamed` record is not also `removed` and `added`; its fields are still compared under its new id. Records are
matched by id, never by position, so reordering a file records nothing.

## Where the history lives

`data-changes/<collection>.jsonl` at the site root: one JSON object per line, keys in a fixed order, LF endings,
validated by `schema/data-changes.schema.json`. It is a normal file in the repository, so the build reads it from there
and nowhere else. A line is never rewritten; the file only grows.

## Event id

`id` is the first 16 hex characters of the SHA-256 of `collection`, `record`, `type`, `field` (or empty), and `date`,
joined by a line feed. Old and new values are not part of it. A repeated run produces the same id and appends
nothing; an id that is already in the file is never written twice.

## Dates

The date of every event is the collection's snapshot `capturedAt` from `mizzen.lock.json` (a commit's date, a
`Last-Modified`), as written there. A collection with no snapshot date gets no events: the command refuses and says so.
The system date is never used, so the same data and the same lock give the same file.

## Recorded state

The default state to compare with is the last recorded one, rebuilt by replaying the history over an empty collection.
An `imported` event carries no records, so it names the git `ref` of the snapshot it summarizes, and the replay starts from
the data at that ref. `--from <git-ref|folder>` compares with an earlier state instead. Only the fields the collection
tracks are compared (`collections.<name>.changelog.track` and `ignore`); none are tracked by default.

## Compared with `mizzen diff` and the snapshot

- `mizzen diff` is a report for one pull request, between two builds. It writes nothing and is not kept.
- The snapshot says where the current data came from and when. It is one record per collection and is replaced on update.
- The history is the sum of all changes ever recorded, kept in the repository and shown on the site. The snapshot
  gives it dates; `mizzen diff` previews the entries that the next run would append.

## Checking

`mizzen data changes --check` fails when the data differs from the recorded state in a tracked field, so a pull request
cannot change data without an entry.
