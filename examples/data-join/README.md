# Multi-source catalog

A two-file catalog built without an API fetch. `data/catalog.yml` is the primary collection and `data/inventory.yml`
is joined into it by `sku` from the local filesystem only.

```bash
node bin/mizzen.ts build examples/data-join --out /tmp/data-join-out --theme ../lateen
```

The join keeps the catalog record's id, order, and page URL. A source that changes refreshes the page on the next
build, and an incremental build writes the same bytes as a full one.

## Inspect the sample conflict

`field-lamp` is named `Field Lamp` in the catalog and `Field Lamp (warehouse)` in inventory, and both names target the
joined `title`. With `onConflict: precedence` (the default) the catalog wins, so the built record and
`data/catalog.raw.json` show `Field Lamp`; inventory still supplies `stock`.

To see the unresolved form, change the example's `onConflict` to `error` and build again. The build reports
`data.join-conflict` with the record key (`sku="field-lamp"`), the ambiguous field (`title`), and both inputs
(`catalog.title` and `inventory.label`). `pack-bag` has no inventory row and stays in the output because the join is a
left join; `retired-lamp` has no catalog row and is never added.
