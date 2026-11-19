# Field lineage

Every published value comes from somewhere: a row in a file, a rule that renamed or filled it, a source chosen by a
join, a group built by an aggregate, or a value the engine computed. `mizzen data explain` shows that history as one
chain, from the input to the page and API paths that publish it.

```bash
mizzen data explain catalog sku-1 --field price
mizzen data explain catalog sku-1 --field price --json
mizzen data explain catalog sku-1 --field author.name --public
```

`--field` is required and takes a dot path. A missing collection, record, field, or a field a transform removed exits
`2` with a message naming the target; a config or load error exits `1`. The command loads the site as a build does and
writes nothing.

## The report

A report is versioned with `format: 1`, so a consumer can read it without guessing:

```json
{
  "format": 1,
  "collection": "catalog",
  "record": "sku-1",
  "field": "price",
  "value": 1000,
  "generated": false,
  "chain": [
    {
      "format": 1,
      "stage": "source",
      "op": "origin",
      "input": { "collection": "catalog", "source": "_data/catalog.yml", "sha256": "…", "row": 3 },
      "record": "sku-1",
      "field": "price"
    },
    {
      "format": 1,
      "stage": "transform:cents",
      "op": "unit",
      "input": { "collection": "catalog", "source": "_data/catalog.yml", "sha256": "…", "row": 3 },
      "record": "sku-1",
      "field": "price",
      "rule": "cents"
    },
    {
      "format": 1,
      "stage": "publish",
      "op": "publish",
      "input": { "collection": "catalog", "source": "_data/catalog.yml", "sha256": "…", "row": 3 },
      "record": "sku-1",
      "field": "price",
      "output": { "kind": "page", "path": "/catalog/sku-1/" }
    }
  ],
  "outputs": [{ "kind": "page", "path": "/catalog/sku-1/" }],
  "summarized": false,
  "omitted": 0
}
```

Each event carries the `format`, its `stage`, and `op`, the `input` it read (`collection`, plus `source`, `sha256`,
`row`, or `page` when known), the `record`, and the `field` as it was named at that stage. Later stages add `rule`,
`from`, `reason`, `contributors`, `source`, or `output`.

Equivalent builds produce identical reports. Nothing reads the clock or the host timezone, and the order of the chain
is the order the stages ran.

## Stages

| Stage | What it records |
| --- | --- |
| `source` | The raw value: its collection, source reference, input hash, and the record's row or the API page. |
| `schema-rename` | A `schemaRenames` entry that moved an older field to its current path; `from` names the old path. |
| `transform:<rule>` | The step that last wrote the field: `rename`, `default`, `cast`, `normalize`, `map`, `date`, `unit`, or another operator. `rule` is the step's `id`. |
| `join:<collection>` | The source the join selected for the field, the input field (`from`), the precedence `reason` (`only`, `precedence`, or `null-fallthrough`), and how many inputs could have supplied it. Rejected values are never kept. |
| `aggregate:<collection>` | The group or metric rule that produced the value (`by:<field>` or `metric:<name>`), the source snapshot, and the number of contributing records. |
| `derived:<name>` | A value computed from another field, naming the rule and its source field. |
| `publish` | One page URL or static API path the field appears in. A field published in both has two publish events. |

A generated value (a `default`, `derived` value, join selection, or aggregate) sets `generated: true` and starts the
chain at the rule that produced it instead of inventing a raw origin. A removed field is never reported as a value;
asking for it names the step that removed it.

A join chain follows the selected record into its own collection, so its origin, transforms, and earlier joins show
first. An aggregate chain follows the first contributing record and the source collection's own history.

## Public reports

`--public` prints only permitted metadata. It never includes `value`, a source path, a rejected input's values, or a
secret. It is checked against the collection's `public` policy and refused for a field the policy does not allow, which
keeps a private field from being described through its lineage.

## Cost

A chain keeps at most 32 events (`LINEAGE_EVENT_LIMIT`). Beyond that the report keeps the origin and the newest stages,
and sets `summarized: true` with the count in `omitted`. A report is built for one record and one field, and a chain
follows at most eight collection levels, so explaining a field in a large site reads only the collections the value
touches. The CLI holds that one report; no per-build event log is written.

## Incremental builds

Lineage is computed from the loaded records in memory, from the same source, lock, transform events, and joins a full
build sees. An incremental build that reuses an unchanged output keeps no stale chain, and a changed input refreshes the
record and its chain. A field's chain is therefore the same whether the build was full or incremental; the lock's input
hash changes only when the bytes did.

## Diagnosing an incorrect value

The catalog sample in [`fixtures/lineage`](../fixtures/lineage/README.md) has a price written in cents and a stock
value joined from inventory. To find why a page shows the wrong price:

1. Run `mizzen data explain catalog sku-1 --field price` and read the chain.
2. The last `transform:` stage names the rule and its `id`; the `source` stage names the file, hash, and row.
3. Change the rule, then run the command again. A new hash means the input changed; the same hash with a different value
   means the rule did.

For a joined field, the `join:` stage names the selected collection and its `reason`. A `reason` of `precedence` means
the primary value won; `null-fallthrough` means an earlier `null` was skipped. For an aggregate, `contributors` and the
snapshot name the group's inputs, so a wrong sum points at the input rows, not the summary.

Compare two rule versions on the same input with `mizzen data transform-diff`, and check the build's own record with
`mizzen data verify`.
