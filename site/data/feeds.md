---
title: Feeds and machine output
description: Declare Atom, RSS, and JSON feeds for a collection, and read every record and list page as JSON.
---

# Feeds and machine output

A data site publishes its collections twice: as pages for people, and as feeds and JSON for tools. Both come from the
same model, so a change to a record appears in both, and a build with the same data writes the same bytes.

## Declare a feed

```yaml
collections:
  posts:
    source: _data/posts.yml
    template: _templates/post.md
    permalink: /posts/{id}/

feeds:
  posts:
    collection: posts
    date: published
    formats: [atom, rss, json]
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `collection` | string | required | Collection whose records the feed lists. |
| `where` | object | every record | Which records it lists, written like a list page's `where`. |
| `date` | string | required | Record field that holds the entry date; a record without a valid date is left out. |
| `limit` | integer | `50` | Largest number of entries. |
| `title` | string | the site title | Feed title. |
| `formats` | list | `[atom]` | Any of `atom`, `rss`, and `json`. |
| `idField` | string | | Record field whose value extends the entry id, so a new event of the same record is a new entry. |
| `fields` | list | `[]` | Record fields written under the JSON Feed extension key. |

Entries are ordered by the date field, newest first, and ties are ordered by entry id. A record with no main page, or
without a date the engine can read, is left out. A feed with no entry writes no file, and a site with feeds but no
`url` writes none and reports `feeds.no-url`, because a reader has no page against which to resolve a relative link.
Selected `fields` are written on each JSON Feed item under the `_mizzen` extension key, never as core keys.

| Format | File | Media type |
| --- | --- | --- |
| Atom | `feeds/<name>.xml` | `application/atom+xml` |
| RSS 2.0 | `feeds/<name>.rss.xml` | `application/rss+xml` |
| JSON Feed 1.1 | `feeds/<name>.json` | `application/feed+json` |

## Entry ids

An entry's id is a tag URI built from the site's host, the collection, and the record id:

```text
tag:example.com:posts/hello
```

It never contains the record's page URL, so renaming the URL keeps readers' unread state. `idField` adds one field to
the end, which is how a record that publishes several events over time gives each event its own entry:

```text
tag:example.com:releases/v1/1.2.0
```

## Advertise the feed

A record page or list page of the feed's collection gets one `<link rel="alternate">` for each declared format, with
the format's media type. Other pages, including a file page, get none. The address is absolute when the site has a
`url` and carries `base` either way.

## Read a record as JSON

Every document page already writes a page JSON beside its HTML. On a record page the same file adds the record:

```json
{
  "url": "/posts/hello/",
  "title": "Hello",
  "record": {
    "collection": "posts",
    "id": "hello",
    "fields": { "title": "Hello", "published": "2026-01-01" }
  }
}
```

Every field is published by default. A collection can name the fields it publishes:

```yaml
collections:
  posts:
    source: _data/posts.yml
    json:
      fields: [title, published]
```

A list page adds a `list` object instead, with the ids of the records it shows, its groups, and its pagination. The
shape is published in `schema/page-json.schema.json`.

## Read a collection as JSON

Each collection writes `data/<collection>.json`: every record's id, URL, and page JSON address, sorted by id. The file
deliberately does not copy record fields; they are in the page JSON it points at. `llms.txt` links the file under a
`Data` section. The shape is published in `schema/collection-json.schema.json`.

A build links only to files it writes. With `outputs.page-json: false` each record's `page` is `null`; with
`outputs.collection-json: false` `llms.txt` has no `Data` section; and a feed's `alternate` links appear only when the
feed file exists, so none are written with `outputs.feeds: false`, without a valid `url`, or when no record qualifies.
