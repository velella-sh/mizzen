# Lineage sample

A two-file catalog whose price is converted to cents and whose stock is joined from inventory. `sku-1` has data in both
files; `sku-2` has a `null` price and no inventory row, so its stock is absent.

```bash
mizzen data explain catalog sku-1 --field price
mizzen data explain catalog sku-1 --field stock --json
mizzen data explain catalog sku-1 --field title --public
```

The `price` chain ends at the `transform:cents` rule and the `source` event names the catalog file, hash, and row.
Change `factor` to `1` and run it again: the value changes and the source hash does not, which points at the rule.
`stock` names `join:inventory` and its `reason`; `title` names the `schema-rename` from `name`.

Asking for a field the collection's `public` policy does not allow, without `--public`, still works; adding `--public`
refuses it with a message instead of describing a private field.
