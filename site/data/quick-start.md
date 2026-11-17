---
title: Data site quick start
description: Build a site from a data file in five minutes, with a collection, a template, a list page, and a URL lock.
---

# Data site quick start

You will build a small catalogue from one YAML file. It needs Node 24 and the packages from
[Install and quickstart](/install/). The finished site is
[`examples/data-site`](https://github.com/velella-sh/mizzen/tree/main/examples/data-site).

## 1. The data

```yaml
# _data/components.yml
- slug: button
  name: Button
  summary: A **button** starts an action.
  status: stable
- slug: tabs
  name: Tabs
  summary: Tabs switch between related views.
  status: beta
```

## 2. The collection

```yaml
# mizzen.yml
title: Catalogue
url: https://example.com
exclude: [README.md]
collections:
  components:
    source: _data/components.yml
    id: slug
    template: _templates/components.md
    permalink: /components/{slug}/
    markdown: [summary]
```

## 3. The template

```md
---
title: "{name}"
description: "The {name} component."
layout: doc
---
# :field[name]

:field[summary]

Status: :field[status]
```

Save it as `_templates/components.md`.

## 4. A list page

```md
---
title: Components
layout: doc
list:
  collection: components
  sort: [name]
---
# Components

::data-table{from=components columns="name,status" sort=name}
```

Save it as `components/index.md`, and add an `index.md` for the home page.

## 5. Check, build, and lock the URLs

```sh
npx mizzen check .
npx mizzen build . --out _site --update-urls
npx mizzen build . --out _site
```

`check` reports a record that does not fit. The first build writes `_site/components/button/index.html` and
`urls.lock.json`; commit that file. The second build changes nothing: the output is byte for byte the same.

Now rename `slug: button` to `slug: action` and build again. The build stops with `urls.removed`: the page
`/components/button/` was published and no record has it any more. Add the record back, or set
`collections.components.onRemoved` to `gone` or a redirect. `npx mizzen urls check .` shows the same comparison without
building.

## Where next

[Data sites](/data/) explains the ideas, [Collections](/data/collections/) lists every key, and
[Lists](/data/lists/) covers filtering, grouping, and pagination.
