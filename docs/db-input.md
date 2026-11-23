# Importing SQLite and NDJSON

A collection can read a local SQLite database or an NDJSON file. Both are extracted outside a build, stored as one
canonical result under `.mizzen/data/`, and pinned in `mizzen.lock.json`. A build reads only the locked result: it
never opens the database, streams the input again, or touches the network.

```yaml
collections:
  products:
    source: _data/catalog.sqlite
    id: sku
    sqlite:
      query: SELECT sku, name, price, released FROM products WHERE published = 1
      id: catalog-products
      order: [name]
```

```yaml
collections:
  products:
    source: _data/products.ndjson
    id: sku
```

Run `mizzen data extract` after changing a source or a query. `mizzen data extract --check` reads the same sources and
compares the results with the lock without writing; it exits `1` when a result is new, changed, or unreadable, and `2`
for a usage problem.

## What the format is

The extension decides:

- **SQLite** (`.sqlite`, `.sqlite3`, `.db`): one configured read query. `sqlite.query` is required; setting `sqlite`
  on another kind of source is a config error.
- **NDJSON** (`.ndjson`, `.jsonl`): one complete JSON object per line. Blank lines are ignored. Every other line must be
  an object with a scalar id.

`records` and `pagination` belong to an API source and are refused on both kinds.

## SQLite

The database is opened read-only, with `PRAGMA query_only = ON`, inside one read transaction. A write statement is
refused before the file is opened, and the read-only connection refuses anything the shape check misses. The file's
bytes are never changed.

| `sqlite` key | Default | What it does |
| --- | --- | --- |
| `query` | required | One `SELECT` (or `WITH … SELECT`) statement. |
| `id` | the collection name | The query id the lock records. |
| `params` | `[]` | Fixed values bound to the query's `?` placeholders, in order: strings, numbers, or `null`. |
| `key` | the collection's `id`, else `id` | Column that holds each row's id. |
| `order` | `[]` | Further columns that order the rows, ascending; ties fall back to the key. |
| `binary` | `base64` | Write a BLOB as base64, or `error` to reject it with the column name. |

Rows are ordered by `order`, then by the key, so two extractions with the same key and order write the same bytes even
when the query has no `ORDER BY`. A repeated key is an error naming both rows.

### Types

| SQLite value | Result |
| --- | --- |
| `NULL` | `null` |
| `INTEGER` / `REAL` | a finite JSON number; an integer outside the safe range is an error naming the column |
| `TEXT` | a string |
| `BLOB` | base64 with `binary: base64` (the default), else an error naming the column |
| anything else | an error naming the column |

## NDJSON

The file is read line by line; it is never loaded whole. When the record or byte limit is passed, the reader stops at
that line and the extraction fails, so no partial result is stored. A line that is not valid JSON, is not an object,
or has no scalar id is an error with its line number.

## Limits

Both kinds use the collection's usual limits: `limits.records` (default 10,000), `limits.bytes` (default 2 MiB for a
source and for the result), and `limits.field` (default 100,000 characters). An over-limit extraction is one error
naming the key that raises it; nothing is written.

## The lock and the build

`mizzen.lock.json` holds an `extractions` entry per collection:

```json
{
  "extractions": {
    "products": {
      "source": "_data/catalog.sqlite",
      "query": "catalog-products",
      "querySha256": "…",
      "bytes": 512,
      "sha256": "…",
      "records": 2
    }
  }
}
```

`query` is the configured query id, and `sha256` is the result the build reads. A build refuses a missing entry with
`data.extraction-missing`, a changed source or query with `data.extraction-stale`, and stored bytes that no longer
match with `data.store-mismatch`. It never reads the source file.

The result is canonical NDJSON: one object per line, field keys sorted at every level, one LF after each record, and no
line for an empty collection. Equivalent SQLite and NDJSON records therefore produce the same result bytes, the same
lock entry, and the same catalog.

Extracted records carry their row in the locked result, so a schema error names both the record key and the row and
points at that row. A row is the record's position in the sorted result, not a line in the database.

For an NDJSON source the line is the line of the stored result, not of the source file: the result is sorted, has
blank lines dropped, and has its keys sorted, so the two differ. The record's position therefore names the stored copy
in `file` (`.mizzen/data/<sha256>`), the configured source in `source`, and `editable: false`, so a theme does not
offer an "edit this record" link into a file whose line numbers it does not match. The same holds for a pinned `https:`
source and a package source. A record read from a file in the site has `source` set to that file's path and
`editable: true`.

## Errors

| Id | What happened |
| --- | --- |
| `config.sqlite-query` | The configured query is not one read statement. |
| `data.sqlite-query` | SQLite refused the query, or a write reached the read-only connection. |
| `data.sqlite-type` | A value has no contract; the message names the column. |
| `data.sqlite-key` / `data.sqlite-column` | The key column is not selected, or a column name repeats. |
| `data.record-duplicate-id` | Two rows use one id; the message names both. |
| `data.invalid-json` | An NDJSON line is not valid JSON; the message names the line. |
| `data.record-not-mapping` | An NDJSON line is not a JSON object. |
| `data.record-missing-id` | A row or line has no scalar id. |
| `data.too-many-records` / `data.source-too-large` | A record or byte limit was passed; no result is stored. |
| `data.extraction-missing` / `data.extraction-stale` | A build has no current locked result; run `mizzen data extract`. |
| `data.store-missing` / `data.store-mismatch` | The stored result is absent or does not match the lock. |

## Example

`fixtures/db-input/example/` holds the same two records as NDJSON and as a SQL script that builds the SQLite file.
Create `_data/products.sqlite` with `sqlite3 _data/products.sqlite < catalog.sql`, then run `mizzen data extract` in
either site.
