# Link to a record on another site

A target site publishes `urls.json`, mapping each collection and stable record id to its page URL. A source site pins
that map in a record-link lock and resolves links by id, so a renamed slug does not break the link. The two-site
fixture is `fixtures/record-links/`: Ebb is the target and Offing the source.

## Setup

On the target, give the collection a stable `id` and a permalink built from another field:

```yaml
collections:
  items:
    source: _data/items.yml
    template: _templates/item.md
    permalink: /items/{name|slug}/
```

The build writes `urls.json` with the record's current URL. Publish that file, and keep `urls.lock.json` beside it.
Copy both into the source repository so the source build stays offline, then name them in
`record-links.lock.json`:

```json
{
  "version": 1,
  "targets": [
    {
      "project": "ebb",
      "public": true,
      "urls": "../target/urls.json",
      "previous": "../target/urls.lock.json"
    }
  ]
}
```

Paths are relative to the source site. A target must be `public`; its URL map is read by `recordTargets`, and a
`collection/id` reference is resolved by `resolveRecordReference`. The acceptance test
`test/record-links/rename.test.ts` shows the wiring.

## A renamed record

1. Change the field the slug uses on the target and run `mizzen build --update-urls`. The new URL goes into
   `urls.json`; the old URL moves into the record's `previous` entry in `urls.lock.json`, and the redirects output
   answers the old URL with a 301 to the new one.
2. Publish the refreshed `urls.json` and `urls.lock.json` to the source. Because the reference names the record id,
   it now resolves to the new URL without editing the source page.

## A removed record

Remove the record and set the collection's `onRemoved` to `gone` or a redirect target. The target's `urls.json` drops
the id and its URL lock keeps the last URL with `"removed": true`; the old target URL answers with a removal notice or
the configured redirect. The source resolver reports `network.record-removed` at the reference's file and line. An id
neither lock holds is `network.record-missing`.
