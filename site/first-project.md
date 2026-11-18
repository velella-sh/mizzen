---
title: From a data file to a page
description: Take the catalogue sample from one YAML file to a generated record page and a list page, with the exact commands and output paths.
layout: doc
permalink: /first-project/
---

# From a data file to a page

This walkthrough starts from `examples/first-project/catalog/` in the repository and ends with seven generated
sensor pages and one list page. It uses configuration, Markdown, and data only: there is no layout or theme code in
the sample.

## 1. Build the sample

From the repository root:

```sh
node bin/mizzen.ts check examples/first-project/catalog
node bin/mizzen.ts build examples/first-project/catalog --out dist/catalog
```

`check` prints `0 errors, 0 warnings`. `build` writes this folder, which is also the URL each page is served at
(the sample sets `url: https://example.com`, so the canonical URL of the first row is
`https://example.com/sensors/thermometer/`):

| File | URL |
| --- | --- |
| `dist/catalog/index.html` | `/` |
| `dist/catalog/sensors/index.html` | `/sensors/` |
| `dist/catalog/sensors/thermometer/index.html` | `/sensors/thermometer/` |
| `dist/catalog/sensors/hygrometer/index.html` | `/sensors/hygrometer/` |
| `dist/catalog/sensors/barometer/index.html` | `/sensors/barometer/` |
| `dist/catalog/sensors/anemometer/index.html` | `/sensors/anemometer/` |
| `dist/catalog/sensors/light-meter/index.html` | `/sensors/light-meter/` |
| `dist/catalog/sensors/ph-probe/index.html` | `/sensors/ph-probe/` |
| `dist/catalog/sensors/current-clamp/index.html` | `/sensors/current-clamp/` |

Seven of those files are record pages, one per sensor; the other two are the home page and the list page.

## 2. The data file

`_data/sensors.yml` holds one list item per record. The file has seven; this is the first:

```yaml
# _data/sensors.yml
- slug: thermometer
  name: Thermometer
  summary: |
    A **thermometer** reports the temperature of a probe. It reads between
    -40 °C and 125 °C and needs no calibration after the first burn-in.
  interface: I2C
  range: -40 to 125 °C
  status: stable
  released: 2026-01-15
```

`slug` is the record's id, and the collection below says so with `id: slug`. Every other key is a field the page
can read.

## 3. The collection

```yaml
# mizzen.yml
title: Sample catalogue
description: A catalogue of sensors built from one data file.
lang: en
url: https://example.com
collections:
  sensors:
    source: _data/sensors.yml
    id: slug
    template: _templates/sensors.md
    permalink: /sensors/{slug}/
    markdown: [summary]
    dates: [released]
    unique: [name]
```

The keys that make the pages:

| Key | What it does |
| --- | --- |
| `source` | Reads the records from `_data/sensors.yml`, relative to the site root. |
| `id: slug` | Makes `slug` the record's identity and fills `{slug}` in the permalink. |
| `template` | The Markdown file every record page is built from. |
| `permalink` | `/sensors/{slug}/` gives each record its own URL, such as `/sensors/thermometer/`. |
| `markdown: [summary]` | Renders `summary` as Markdown. A field not listed here is plain text. |
| `dates: [released]` | Reads `released` as a date rather than a string. |
| `unique: [name]` | Fails the build when two records share a name. |

## 4. The template

```md
---
title: "{name}"
description: "The {name} sensor."
layout: doc
---
# :field[name]

:field[summary]

Interface: :field[interface] · Range: :field[range] · Status: :field[status] · Released: :field[released]
```

The front matter is shared by every record: `{name}` is replaced with the record's `name`, so the thermometer page
gets the title `Thermometer`. In the body, `:field[summary]` reads one field, and renders it as Markdown because the
collection lists it in `markdown`.

## 5. The list page

```md
---
title: Sensors
layout: doc
list:
  collection: sensors
  sort: [name]
  fields: [name, interface, status]
---
# Sensors

Every sensor in the catalogue, by name.

::data-table{from=sensors columns="name,interface,status" sort=name}
```

`list` tells the theme which records the page shows and in what order. `::data-table` writes the same records as a
table in the page itself, so the list also works with a theme that has no list layout.

## 6. The short reference

A record page has three inputs: a record in a data file, a `collections` entry naming where it goes, and a template.
A list page has one input: front matter naming the collection.

| In a record template | Result |
| --- | --- |
| `{name}` in front matter | The field's value in the page title or description, without Markdown. |
| `:field[name]` | The field's value; Markdown when the collection's `markdown` includes the field. |

| In a list page | Result |
| --- | --- |
| `list.collection` | The collection the page lists. |
| `list.sort`, `list.where`, `list.fields` | Order, filter, and fields passed to the theme. |
| `::data-table{from=sensors columns="name,status" sort=name}` | A table written into the page. |

Copy the sample into a site of your own and change the data file. When the pages look right, commit `urls.lock.json`
after the first `--update-urls` build so a later data edit cannot move a published URL without a diagnostic.

## Where next

[Collections](/data/collections/) lists every collection key, [Templates](/data/templates/) covers record pages, and
[Lists](/data/lists/) covers filtering, groups, and pagination.
