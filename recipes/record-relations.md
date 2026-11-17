# Record relations

Three collections that point at each other by id. A product names its rule, and a release line names its product and
the rules it follows. Nothing is copied between the data files, so the page, the timeline, the feed, and the page JSON
all read the same records.

## Configure the collections

```yaml
# mizzen.yml
collections:
  products:
    source: _data/products.yml
    template: _templates/products.md
    permalink: /products/{id}/
    references:
      rule: rules
  release-lines:
    source: _data/release-lines.yml
    template: _templates/release-lines.md
    permalink: /releases/{id}/
    dates: [date]
    references:
      product: products
      rules: rules
  rules:
    source: _data/rules.yml
    template: _templates/rules.md
    permalink: /rules/{id}/
```

A field under `references` holds an id of the target collection, or a list of ids. The build checks every id and
reports a missing one as `data.reference-missing` at the field.

```yaml
# _data/release-lines.yml
- id: rel-1
  product: starling
  rules: [draft, hold]
  date: 2026-03-10
```

## Read a relation in a layout

A record page and each record of a list get a `related` prop: one entry per configured field, in the order the record
writes its ids, and each entry carries the target's `collection`, `id`, `url`, and `fields`. A site without configured
relations has no `related` prop, and the props stay exactly as they were.

```ts
const rules = props.record?.related?.rules ?? [];
for (const rule of rules) {
  console.log(rule.id, rule.url, rule.fields.title);
}
```

`props.links` still carries the URL of a scalar relation, such as `product`, for a layout that only needs the link.

## Rebuilds

A record page and a list page depend on every record their relations point at. Changing a related record's field, or
removing it, rebuilds those pages and the list; a warm build writes the same bytes as a clean one. An incremental build
therefore shows a new rule title, or a new date, on the dependent page, the timeline list, the feed, and the page JSON
without rebuilding unrelated records.
