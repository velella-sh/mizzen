---
title: Templates
description: Every template directive with an example and its output, front matter substitution, and permalink patterns with the slug filter.
---

# Templates

A template is a Markdown file under `_templates/`, named by `collections.<name>.template`. It becomes one page per
record. Its front matter fills from the record, and its body uses the directives below. Text every page shares lives in
the template; text that differs lives in the record.

Take this record and this template:

```yaml
- slug: button
  name: Button
  status: stable
  tags: [action, form]
  parent: input
```

```md
---
title: "{name}"
description: "The {name} component."
---
# :field[name]

Status: :field[status]
```

The page at `/components/button/` has the title `Button` and the heading `Button`.

## Front matter substitution

In a string value of the front matter, `{field}` becomes the record's value, so one template gives each page its own
title, description, image, language, and theme keys. A dotted path such as `{owner.name}` reads a nested value. `{{` and
`}}` are literal braces. `layout` and `permalink` are fixed text and are never filled. A field the record lacks, or a
value that is empty once filled, is an error at the template (`data.frontmatter-missing-field`,
`data.frontmatter-empty`), and a page never carries the placeholder.

## Directives

| Directive | Output |
| --- | --- |
| `:field[path]` | One field of the record as text. `data-src` on it names the line in the data file. |
| `:::if{field=path}` | Keeps its body only when the field has a value. |
| `:::each{field=path}` | Repeats its body once per item of a list field. |
| `:::records{from=… where=… sort=… limit=…}` | Repeats its body for records of another collection. |
| `:count{from=… where=…}` | How many records of a collection match. |
| `::data-table{from=… columns=…}` | A table of records. |
| `:data[path]` | One value from `_data` or from a record, as text. |
| `:snapshot[field]` | A field of the collection's recorded snapshot. |

### `:field[path]`

```md
Status: :field[status]
```

renders `Status: stable`. A dotted path reads a nested value, and an absent optional field renders nothing. A field the
schema does not declare, or a value that is not a scalar, is an error at the directive. A field named under
`collections.<name>.markdown` is rendered as Markdown and keeps each block's line in the data file.

### `:::if{field=path}` and `:::each{field=path}`

```md
:::if{field=parent}
Part of :field[parent].
:::

:::each{field=tags}
- :field[value]
:::
```

renders `Part of input.` and a list of `action` and `form`. Inside `each`, the item's own fields come first, and a scalar
item is `value`. There are no expressions, comparisons, or calls: a template is not a program. A block nested more than
one level deep is `data.block-nesting`, and `each` on a field that is not a list is `data.each-not-list`.

### `:::records{from=… where=… sort=… limit=…}`

Shows related records. `from` names one other collection. `where` is one pair, `field=other`: the left side is read from
the candidate record, and the right side from the current record when it names a field there, otherwise it is a literal.

```md
## Releases

:::records{from=releases where="component=slug" sort=date limit=5}
- Release :field[id], :field[date]
:::
```

lists the releases whose `component` is this record's `slug`. `sort` names one field and falls back to the id; `limit`
keeps the first N; without `sort`, records keep their source order.

### `:count{from=… where=…}`

```md
There are :count{from=components where="status=stable"} stable components.
```

renders `There are 8 stable components.` and changes when the data does.

### `::data-table{from=… columns=…}`

```md
::data-table{from=components columns="name,status" sort=name where="status=stable"}
```

renders a Markdown table of the matching records. `columns` is a comma-separated list of field paths, `sort` names one
field, and `where` is one pair with its value quoted. `id` is a column of every collection.

### `:data[path]`

`:data[site.owner]` shows a value from `_data/site.yml`. When `_data` has no such path, the first segment may name a
collection and the second a record, so `:data[components.button.name]` reads one field of one record. The resolved text
is written into the Markdown twin too.

### `:snapshot[field]`

Shows a field of the collection's recorded snapshot, such as `ref` or `capturedAt`. See
[Recorded snapshots](/data/snapshots/).

## URL patterns

A collection's `permalink` is a URL pattern. `{field}` is the record's value as written. `{field|slug}` is its URL-safe
slug: lowercase, with the letters and digits of every script kept and each run of anything else made one hyphen. Nothing
is transliterated, and a slug never holds a `/`.

| Pattern | Record | URL |
| --- | --- | --- |
| `/components/{slug}/` | `slug: button` | `/components/button/` |
| `/components/{name\|slug}/` | `name: Code block` | `/components/code-block/` |
| `/p/{scope\|slug}/{name\|slug}/` | `scope: Team A`, `name: Docs` | `/p/team-a/docs/` |

A field the record lacks is `data.permalink-field`, a filter other than `slug` is `data.permalink-filter`, and a slug
that comes out empty is `data.permalink-slug`. When a pattern gives two records one URL, `disambiguate` appends a field
to the records that collide, and without it both are `data.permalink-collision`. `{field|slug}` is also what an `expand`
list uses as `{value|slug}`; see [Lists](/data/lists/).

## Views and languages

`collections.<name>.views` builds extra pages from the same record, each with its own template, URL pattern, and
layout. A view's canonical URL is the record's main page. With `languages` configured, a record gets one page per
language: `<template>.<lang>.md` is used when it exists, `<field>.<lang>` is read from a mapping and falls back to the
default language.

A link written `record:<collection>/<id>` becomes the record page's URL, and a link to a missing record is a broken link
at its position in the template.
