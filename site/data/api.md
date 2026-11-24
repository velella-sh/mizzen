---
title: A versioned data API
description: Publish collections as plain JSON files under /api/v1/, keyed by record id, and fail a build that would break the programs reading them.
---

# A versioned data API

Another program, such as a command-line tool or a second site, can read a collection's records from plain files at an
address that does not move. The files are static: there is no server, no query language, and no authentication. A
reader fetches a file and filters it itself. A site without an `api` key writes nothing, and a collection the key does
not name is never published, even when it has pages.

```yaml
api:
  version: v1
  collections:
    packages:
      id: id
      fields: [name, eol, latest]
```

`fields` is the whole published shape: a field not listed is never written.

### Config keys

| Key | Meaning |
| --- | --- |
| `version` | The version folder of the current API, such as `v1`. Default `v1`. |
| `collections` | The published collections by name, each with `fields` and an optional `id` key. |
| `headers` | `true` writes a `_headers` file with CORS and cache rules for `/api/*`. Default `false`. |
| `maxFileBytes` | Warn when a file is larger than this many bytes. A file is never truncated. |
| `versions` | Further versions beside the current one, each with its own `collections`. |

## Layout

```text
api/v1/index.json              the entry point: version, status, and each collection's fields, count, and links
api/v1/openapi.json            an OpenAPI 3.1 description of the files
api/v1/packages.json           every published record, ordered by id
api/v1/packages.ndjson         the same records, one per line, for a reader that streams
api/v1/packages/node.json      one record, in a file named by its id
api/v1/schemas/packages.json   the collection's JSON Schema, limited to the published fields
```

A record file is named by the record id, which does not change, never by the page address. When a page moves, the
record file keeps its name and its `previousUrls` list says where the page used to be.

## The index

`index.json` holds no records. Read it first to find the other files.

### Index keys

| Key | Meaning |
| --- | --- |
| `version` | The version of this folder. |
| `status` | `current`, or `deprecated`. |
| `sunset` | The date after which a deprecated version may be removed, or `null`. |
| `successor` | The version to move to, or `null`. |
| `collections` | One entry per published collection: `name`, `count`, `fields`, `json`, `ndjson`, `record`, `schema`, and `snapshot`. |

## A record file

```json
{
  "collection": "packages",
  "id": "node",
  "fields": { "name": "Node", "eol": "2028-04-30" },
  "url": "/docs/packages/node/",
  "previousUrls": []
}
```

The published fields sit under `fields`, so a field named `url` cannot collide with the page address.

## The compatibility rule

Within a version a field may be added, and may never be removed or change its type. To change a shape, publish a new
version beside the old one and deprecate the old one:

```yaml
api:
  version: v2
  collections:
    packages:
      fields: [name, eol, latest, lts]
  versions:
    v1:
      deprecated: true
      sunset: 2027-01-01
      successor: v2
      collections:
        packages:
          fields: [name, eol, latest]
```

Do not remove a version in the release that deprecates it: remove it in a later one.

`mizzen api check` enforces the rule. It builds the site and compares the result with an earlier API, which is a built
folder (the last release, or a deployed copy) or a git ref:

```bash
mizzen api check --against ../last-release
mizzen api check --against v1.4.0
```

It exits 1 when a collection, a field, or a version the earlier API had is gone, or a field changed type, and prints
the file, the field, and a fix for each. Added fields pass.

## Reading it from a script

```js
const base = "https://example.com/docs/api/v1";
const index = await (await fetch(`${base}/index.json`)).json();
if (index.status === "deprecated") console.warn(`move to ${index.successor} before ${index.sunset}`);

const node = await (await fetch(`${base}/packages/node.json`)).json();
console.log(node.fields.eol);
```

## Links on the pages

With Lateen `0.2.5`, list and record pages link to the collection files, the record JSON, the JSON Schema, and the
OpenAPI document of the version the page belongs to. The links follow what the build published: a collection or schema
the version does not list gets no link. See [Lateen 0.2.5](/theme/).

## Size

A collection file holds every record. When one passes `maxFileBytes`, the build warns and the advice is to read the
NDJSON file, or to fetch single records. The file is still written whole.
