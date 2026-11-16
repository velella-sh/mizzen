# Design: the data API

Status: accepted. Epic: data-api.

## Purpose

Another program (a CLI that reads a lifecycle table, another site) needs a collection's records at an address that
does not move and in a shape it can rely on. The page JSON and the collection pointer file do not give it that: they
follow page addresses and may change with the site. The data API is a set of plain files under `/api/v1/`, keyed by
record id, with a check that stops a build from removing or retyping a field its readers use.

It is **static files only**. There is no server, no query language, and no authentication. A reader fetches a file and
filters it itself.

## Opt in

A site without an `api` key writes nothing under `api/`. A collection the config does not name is never published, even
when it has pages.

```yaml
api:
  version: v1            # default v1
  collections:
    packages:
      id: id             # the key the record id is published under; default id
      fields: [name, eol, latest]
```

`fields` is the whole published shape: a field not listed is not written. `api.versions`, `api.headers`, and
`api.maxFileBytes` are added by later issues of the epic and are described where they are written.

## Layout

Every path is relative to the output folder, and every URL includes the site `base`.

| Path | Holds |
| --- | --- |
| `api/v1/index.json` | The version, each collection with its record count and links, the schema link, and the collection's snapshot. No records. |
| `api/v1/<collection>.json` | Every published record, ordered by id, with the published fields. |
| `api/v1/<collection>.ndjson` | The same records, one JSON object per line, for large collections. |
| `api/v1/<collection>/<id>.json` | One record: its fields, its current page address, and its earlier addresses. |
| `api/v1/schemas/<collection>.json` | The collection's JSON Schema limited to the published fields; `$id` is its published address. |
| `api/v1/openapi.json` | An OpenAPI 3.1 description of the files above. |
| `_headers` | Only with `api.headers: true` and only when the site has no `_headers` of its own. |

Every file is deterministic: records ordered by id (code point order), keys in a fixed order, two-space indent, one
final line feed.

## Keyed by record id

A file is named by the record id and never by the page URL or the slug. The page address of a record may change (a
renamed title, a new URL pattern); the id does not, and `urls.lock.json` already holds the id-to-URL map the record file
reads its address from. A record file carries the current address and the earlier ones so a reader can follow a move,
but it never depends on them to be found.

An id that is not safe as a file name (empty, `.` or `..`, a `/` or `\`, a control character, or a name an operating
system reserves) fails the build with a diagnostic naming the record. Nothing is encoded or rewritten, because an id
that changed spelling would no longer be the id.

## The compatibility rule

Within a version a field is only **added**. A published field is never removed, and its type never changes; a
collection is never removed. A change that does any of these needs a new version (`v2`), and the old version stays
published while it is deprecated (`deprecated`, a `sunset` date, and a `successor` in the index). A value may change at
any build: the rule guards the shape, not the data.

`mizzen api check --against <folder|ref>` compares the published fields and their types with an earlier build and fails
on a removed collection, a removed field, or a changed type. An added field passes.

## Which file to use

| Need | Use |
| --- | --- |
| A page's content for an agent or a theme | The page JSON (`<page>/index.json`). It follows the page address. |
| Which pages a collection has, and where | The collection pointer file (`data/<collection>.json`). It lists ids and page addresses, not fields. |
| A collection's records for another program | The data API. Ids never change and the shape is guarded. |
| The raw data with its snapshot and checksum | `data/<collection>.raw.json`. Not versioned and not checked. |

## Not promised

No server, no query or filter syntax, no pagination, no authentication, and no claim that any host serves the files
with particular headers. The optional `_headers` file is written for hosts that read one; the docs name which do.
