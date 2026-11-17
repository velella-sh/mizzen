# Record relations baseline

Epic: #515. Baseline: #516, before the work in #517 and #518.

A relation is a field a collection marks under `collections.<name>.references`: the field holds the id of a
record in another collection, or a list of such ids. The fixture in
[`test/record-relations/baseline.test.ts`](../test/record-relations/baseline.test.ts) has three collections:
`products` points at `rules`, and `release-lines` points at `products` and at a list of `rules`.

## What already works

- A relation is validated where it is written: a scalar id and every item of a list are checked, and a missing id is
  one `data.reference-missing` error at the field's source position, naming the field, the record, and both
  collections. A value that is neither an id nor a list of ids is `data.reference-invalid`.
- A **scalar** relation resolves to the target page's URL in `RecordProps.links`, on a record page and on each record
  a list page hands to its layout. The URL follows the target collection's permalink and the page language.
- An absent relation and an empty list are valid. They add no entry to `links`, and the field stays absent or `[]`.
- An empty string or an empty scalar (`product: ""`, `product:`) is not treated as an absent relation: the first is
  `data.reference-missing`, the second `data.reference-invalid`.

## The confirmed gap

A relation that holds a list of ids is validated but not resolved. `RecordProps.links` has no entry for it, so a
template or list cannot follow the ids, keep their order, or show the related records' fields. Resolving configured
relations, and exposing related records to template and list queries, is #517 and #518. The baseline asserts the
current absence so those changes have to update this test on purpose.

An inverse relation is not part of the config either: a `rules` page cannot list the release lines that point at it
without an explicit `:::records` query. Change propagation through a relation, and the page, timeline, feed, and JSON
views of a related record, are left to #519 and #520.
