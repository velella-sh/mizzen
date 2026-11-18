# Joining collections

A collection's `join` key enriches its records with records of other collections. The collection's own source is the
primary side, so its record ids, positions, order, URLs, and pages stay the same; each source in `sources` is one more
join step, applied after the collection's own source is read and transformed.

```yaml
collections:
  catalog:
    source: data/catalog.yml
    id: sku
    template: _templates/catalog.md
    permalink: /catalog/{sku}/
    join:
      type: left
      key: sku
      fields:
        sku: sku
        title: name          # output field ← primary field
        price: price
      sources:
        - collection: inventory
          key: sku
          fields:
            stock: stock
      onMissingKey: skip
      onConflict: precedence
  inventory:
    source: data/inventory.yml
    id: sku
```

`fields` maps an output name to a field on that side. Without it every top-level field is kept under its own name.
A destination that two sides supply is a conflict: `onConflict: precedence` (the default) keeps the first source in
order, primary first; `onConflict: error` reports `data.join-conflict` with the record key, the field, and both inputs.
`onNull: keep` (the default) treats `null` as a value; `onNull: fallthrough` treats it as absent and takes the next
source that has a value. A truly absent field stays absent.

`key` is one field or a list of fields on each side, compared by value and by type. A number never matches a string,
and composite keys are one tuple, so `["a", "bc"]` never matches `["ab", "c"]`. A source without its own `key` uses the
join's key. A record whose key is absent or `null` is reported as `data.join-missing-key` and left out; with
`onMissingKey: skip` the finding is a warning.

`type` is `inner` (the default) or `left`. An inner join leaves out a primary record that matched no source. A left join
keeps it with the primary fields and with no secondary field for the missing match.

More than one secondary record with the same key is a one-to-one violation. `many: error` (the default) reports
`data.join-many` and still picks the first record by id; `many: first` and `many: last` choose by id, not by row order;
`many: list` writes every match under `manyField` (default: the source's collection name), sorted by id. Reordering a
secondary file therefore changes no id, value, or URL.

Every joined record carries `joined` on the internal data contract: its key values and, for each output field, the
selected source and input, every input that could have supplied it, and the reason (`only`, `precedence`, or
`null-fallthrough`). A joined collection's schema, `unique`, `dates`, and `derived` rules read the joined output.

A source may itself be a joined collection, which makes a chain of join steps. A cycle is rejected as
`config.join-cycle`, and a build that reaches one reports `data.join-cycle` instead of looping. A secondary source file
is part of the build key, so changing or deleting its rows refreshes the dependent output and an incremental build
matches a full one.

[`examples/data-join`](../examples/data-join/README.md) builds a two-local-file catalog with a visible title conflict.
