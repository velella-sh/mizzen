---
title: Field lineage
description: Explain where a published field came from, which rule or source changed it, and where it is published.
---

# Field lineage

A published value can come from a file row, a schema rename, a transform step, a join, an aggregate, or a computed
value. `mizzen data explain` follows one field back through those stages, then names the page and API paths that publish
it.

```bash
mizzen data explain catalog sku-1 --field price
mizzen data explain catalog sku-1 --field price --json
mizzen data explain catalog sku-1 --field author.name --public
```

`--field` is required and takes a dot path such as `title` or `author.name`. The command loads the site as a build does
and writes nothing. A missing collection, record, field, or a field that a transform removed exits `2` with a message; a
config or load error exits `1`.

## What the report shows

Each stage carries the `format` version (`1`), the input reference (`collection`, plus `source`, `sha256`, `row`, or
`page`), the record, and the field as it was named then:

- `source`: the raw value and its row or API page.
- `schema-rename`: the older path a `schemaRenames` entry moved.
- `transform:<rule>`: the step that last wrote the field, by its `id`.
- `join:<collection>`: the source the join selected, the precedence `reason`, and how many inputs could have supplied
  it; rejected values are not kept.
- `aggregate:<collection>`: the group or metric, the source snapshot, and the number of contributing records.
- `derived:<name>`: a computed value and the field it reads.
- `publish`: the page URL or static API path the field appears in.

A generated value marks `generated: true` and starts at the rule that produced it. A removed field is never reported as
a value; asking for it names the step that removed it.

`--json` prints the same chain as a versioned document, identical across equivalent builds. A chain keeps at most 32
stages; past that it keeps the origin and the newest stages and sets `summarized: true` with the omitted count.

## Public reports

`--public` prints permitted metadata only: no value, no source path, no rejected inputs. It is checked against the
collection's `public` policy, so a private field is refused rather than described.

## Use it to find a wrong value

The `price` chain ends at the `transform:` stage and the `source` event names the file, hash, and row. Change the rule
and run it again: the value moves while the source hash stays, which points at the rule. For a joined field, the `join:`
stage names the selected source and its `reason`; for an aggregate, `contributors` and the snapshot name the group.

See [Field lineage](https://github.com/velella-sh/mizzen/blob/main/docs/lineage.md) for the full contract and the
[catalog fixture](https://github.com/velella-sh/mizzen/tree/main/fixtures/lineage).
