---
title: Data sites
description: Build pages from data files. Collections, records, templates, and list pages, with one small example and the path from a data file to a built page.
---

# Data sites

A data site builds pages from data instead of writing each one by hand. You keep the facts in a YAML, JSON, or CSV
file, write one template for the pages that share a shape, and Mizzen builds a page for every record. Every value on
a page keeps the position of the field it came from, so a page can be edited at its source.

This guide explains the four ideas, then walks one small example from a data file to a built page. Every file in it is in
[`examples/data-site`](https://github.com/velella-sh/mizzen/tree/main/examples/data-site), which CI builds twice and
checks for the same bytes.

## The four ideas

- A **collection** is one data file, read into records and given the rules that turn them into pages: which field is the
  record's id, which template to use, and what URL a page gets. It is declared under `collections` in `mizzen.yml`.
  See [Collections](/data/collections/) and [Public fields](/data/public-fields/).
- A **record** is one entry of the collection: an id and its fields. A record is data, not HTML.
- A **template** is a Markdown file under `_templates/`. It is instantiated once per record into a **record page**. Its
  front matter and directives take their values from the record. See [Templates](/data/templates/).
- A **list page** is an ordinary page whose front matter asks for a list of records: filtered, sorted, grouped, and
  paginated. See [Lists](/data/lists/).

Around those four sit the [feeds and machine output](/data/feeds/), [calendar feeds](/data/calendars/),
[change history](/data/changelog/), [search](/data/search/), [SEO](/data/seo/), [social images](/data/social-images/),
and [stable URLs](/data/urls/). A theme draws the pages from the [theme contract](/data/theme-contract/).

## One small example

The data is a YAML list. Each entry is a record, and `slug` is its id:

```yaml
# _data/components.yml
- slug: button
  name: Button
  summary: A **button** starts an action.
  status: stable
  released: 2026-01-12
```

The collection says where the records live and how a page is built:

```yaml
# mizzen.yml
collections:
  components:
    source: _data/components.yml
    id: slug
    template: _templates/components.md
    permalink: /components/{slug}/
    markdown: [summary]
```

The template is the wording every page shares:

```md
---
title: "{name}"
description: "The {name} component."
---
# :field[name]

:field[summary]

Status: :field[status]
```

A list page shows the same records together:

```md
---
title: Components
list:
  collection: components
  sort: [name]
---
# Components

::data-table{from=components columns="name,status" sort=name}
```

## From a data file to a built page

1. Put the records in a file inside the site, such as `_data/components.yml`.
2. Declare the collection in `mizzen.yml` with its `source`, `id`, `template`, and `permalink`.
3. Write the template under `_templates/`. Put the shared wording in it and the facts in `:field[…]`.
4. Run `mizzen check .`. A record that does not fit, a missing field, or two pages with one URL is a finding with the
   file and the line.
5. Add a list page with `list:` in its front matter where readers need to browse.
6. Run `mizzen build . --out _site`. The page for `button` is `_site/components/button/index.html`.
7. Commit `urls.lock.json` once you publish, so a later rename cannot move a URL without you knowing. See
   [Stable URLs](/data/urls/).

To change one page, edit the record. To change every page, edit the template. The [quick start](/data/quick-start/)
runs these steps in an empty folder.

## Where to go next

| You want to | Read |
| --- | --- |
| Declare a collection, its sources, and its checks | [Collections](/data/collections/) |
| Use directives and URL patterns in a template | [Templates](/data/templates/) |
| Filter, sort, group, and paginate | [Lists](/data/lists/) |
| Count days, derive a state, and format a date | [Dated data](/data/dates/) |
| Publish Atom, RSS, and JSON | [Feeds](/data/feeds/) |
| Search and filter records | [Search](/data/search/) |
| Describe pages to search engines | [SEO](/data/seo/) |
| Draw a share image per page | [Social images](/data/social-images/) |
| Keep URLs from moving | [Stable URLs](/data/urls/) |
| Write a layout for records and lists | [Theme contract](/data/theme-contract/) |
| Understand a finding | [Data findings](/data/validation/) |
