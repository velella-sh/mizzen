---
title: Public fields
description: Publish an allowlist of fields from a collection, and keep the rest of each record internal to transforms, joins, and the build.
---

# Public fields

A collection can publish an allowlist of its fields. A record keeps every field it read, so transforms, derived values,
permalinks, and list filters still see the whole record; the policy is applied where data leaves the engine. A field that
is not on the list is absent from pages, search, feeds, downloads, the page JSON, and the API. A new field is therefore
private until someone adds it.

```yaml
collections:
  people:
    source: _data/people.yml
    template: _templates/person.md
    permalink: /people/{id}/
    public: [title, summary, author.name, publishedAt]
```

`id` is the record's identity and is always public. A collection without `public` publishes every field, as earlier
versions did. `public: []` is an empty allowlist: only `id` is published, and every other field stays internal.

## Nested paths

An entry is a dot path. It names one leaf (`author.name`) or a whole subtree (`author`). A container of a named leaf is
kept, with only the public leaves under it, so `public: [author.name]` publishes `author: { name: … }` and drops
`author.email`. Lists are filtered item by item: `authors.name` keeps the name of every author and drops the rest.

The list order follows the data file, and a path that no record holds matches nothing.

## Derived and joined fields

A derived value is computed from the whole record and is published only when the policy names it: add `daysLeft` to the
list when `derived.daysLeft` should appear. The same rule applies to a field produced by a transform or a join, and to a
relation's target fields: the target collection's own `public` list filters what its related records show.

## What the policy covers

Every public boundary applies the same view:

- page HTML, the Markdown twin, and `llms-full.txt`;
- page JSON (`<url>/index.json`) and the collection index (`data/<name>.json`, `.csv`, `.raw.json`, `.index.json`);
- search documents, metadata, filters, and `search-facets.json`;
- feeds and the changelog feed;
- the static API, its record files, its published schema, and `openapi.json`;
- changelog pages and report payloads, which keep an event's identity but drop the values of a private field.

Field references in public settings are checked before anything is written. A permalink, view URL, `seo.canonical`,
`seo.noindex`, `seo.lastmod`, `seo.jsonLd`, search filter or sort, `json.fields`, `index.fields`, an API field, a feed
field, or a `:field[…]`/`:::each{field=…}` in a template that names a private field is `data.public-reference` (or
`api.private-field`) and fails the build. Add the field to `public`, or stop referencing it.

## Site output, caches, and raw input

The policy is about **site output**: the folder a build writes and every file an output produces. Two other places hold
the same values and are deliberately different:

- **Caches.** The build cache is keyed by the config and the data, so changing `public` invalidates what it touched, and
  a build replaces the output folder rather than editing files in place. A field that becomes private is rewritten out
  of every managed file; there is no stale copy to delete by hand.
- **Raw input packages.** `_data`, the fetched store under `.mizzen/data`, `mizzen.lock.json`, and an input pack keep the
  raw records, including private fields. They are inputs to a build, not public output; keep the artifact private. A
  package source is read with every field, so a private field can still drive a transform or a derived value.
- **Repository history.** `data-changes/<collection>.jsonl` records the raw old and new values of a tracked field.
  Mizzen reads it as the `<name>.changes` collection and never copies the folder into the output, even though it sits at
  the site root. The file itself is still in the repository: keep the repository private, or track only fields that may
  be public.

`raw.private` remains a narrower switch for the raw JSON and CSV only. When a collection sets both, the public policy
applies first and `raw.private` removes fields from the downloaded files only.

## Upgrading an existing collection

1. Add `public` to the collection with the fields its pages, feeds, API, and search already use.
2. Run `mizzen build` (or `mizzen check site`). Every reference outside the list is reported before publication; add the
   field or remove the reference.
3. Compare the built site with the previous one. The difference is the data that left the public boundary; keep it in
   the input package and the repository, not in the output.
