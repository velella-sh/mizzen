---
title: Stable URLs
description: The URL lock file, how a changed or removed record is handled, the renaming workflow, redirects, and urls.json.
---

# Stable URLs

A record's page address comes from its data, so editing a record can move its page. `urls.lock.json` makes that
visible: it holds every record page's current URL and the ones it had before, and every build checks against it.

## The lock file

```json
{
  "version": 1,
  "collections": {
    "components": {
      "button": { "url": "/components/button/", "previous": [] }
    }
  }
}
```

The file is written by `mizzen build --update-urls` and is meant to be committed. Without a lock file a build checks nothing; once it exists, these rules apply.

| Change | Result |
| --- | --- |
| A record's URL changed | An error, `urls.url-changed`, until you accept it. |
| A record was removed, or its id changed | An error, `urls.removed`, unless the collection says what its absence means. |
| A record is new | Reported as `urls.new-records` and added to the lock by `--update-urls`. |

`mizzen urls check` prints the same comparison as text or JSON and writes nothing, so a pipeline can run it before a
build. It exits 0 when the lock is current.

## Renaming a record safely

When a record keeps its id and a field behind its permalink changes, for example the `name` in
`/components/{name|slug}/`:

1. Change the field.
2. Run `mizzen urls check .`. It names the record, its old URL, and its new URL as `urls.url-changed`.
3. Run `mizzen build . --update-urls`. The lock keeps the old URL as a previous one.
4. Commit the data and `urls.lock.json` together.

When the id itself changes, the old record is removed and a new one is added: the build reports `urls.removed`. Keep the
old address working by listing the old id in the field named by `aliases`, or set `onRemoved` for the collection.

The next build writes a one-hop redirect from the old URL to the new, through the `redirects` output. A lock entry
that a record no longer occupies keeps its id and URL, so a new record cannot take the address over.

## When a record is removed

`collections.<name>.onRemoved` decides what the absence of a published record means:

| Value | Meaning |
| --- | --- |
| `error` | The build fails and names the record. The default once a lock file exists. |
| `gone` | A notice page at the old URL says the record was removed. |
| `redirect: /components/` | The old URL redirects to a page on the site. |

## Earlier ids with `aliases`

`collections.<name>.aliases` names a field whose string or list values are earlier ids or paths of a record. Each redirects
to the record's page, and works without the lock file.

```yaml
- slug: button
  aliases: [btn, /ui/button/]
```

## `urls.json`

`urls.json` maps each collection's record ids to their page URLs, absolute when the site sets `url`, and carries the
engine version and a hash of the data. Only the default language names a record in it. Like the rest of the data
contract, the file only gains fields, so a script that reads it keeps working.

Two records that a permalink cannot tell apart are `data.permalink-collision`; `disambiguate` appends a field to the
records that collide. See [Templates](/data/templates/).
