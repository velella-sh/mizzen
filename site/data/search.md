---
title: Search
description: Make record pages searchable, add filters and sort fields, and the files the build writes for a theme.
---

# Search

Record pages join the site's search index with no extra setup. `collections.<name>.search` decides what readers can
filter and sort by. The build writes the index, a list of filter values, and an OpenSearch description; the theme draws
the search box and the filters.

```yaml
collections:
  components:
    source: _data/components.yml
    template: _templates/components.md
    permalink: /components/{slug}/
    search:
      meta: [status, region]
      filters: [status, region]
      sort: [released]
      aliases: aka
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `meta` | list of string | `[]` | Fields written as result metadata under the field's own name, so a result can show them. |
| `filters` | list of string | `[]` | Fields a reader can filter by. A list field gives one filter value per item. |
| `sort` | list of string | `[]` | Fields results can be ordered by: dates, numbers, or short text. |
| `aliases` | string | | Field that holds other names of a record, indexed so a search for one finds the page. |

`search: false` at the top level of `mizzen.yml` builds no index. `search.text` sets how many characters of each page's
body the index keeps (default 300); titles and headings are always indexed.

## Files written

| File | What it holds |
| --- | --- |
| `pagefind/` | The search index and its client, loaded as `/pagefind/pagefind.js`. |
| `search-facets.json` | The filter names and values, with the number of record pages that hold each value. |
| `opensearch.xml` | The browser's search description, pointing at the results page. |

`search-facets.json` is the file a theme reads to draw filters:

```json
{
  "query": { "text": "q", "filter": "filter.{field}", "sort": "sort", "order": "order" },
  "filters": {
    "collection": { "components": 12, "releases": 10 },
    "status": { "beta": 2, "stable": 8 }
  }
}
```

The `collection` filter is always first and every other filter follows in code-point order. Labels and translations are
not written: the theme owns the words. `query` names the parameters of the results page, so the theme and the browser
agree. A site with no record pages gets no file.

## What the theme does

The theme reads `search-facets.json`, draws one control per filter, and passes the reader's choice to the index with
the parameters in `query`. Nothing in a record page's HTML is hidden from the index. See the
[theme contract](/data/theme-contract/).

## Findings

| Id | Meaning |
| --- | --- |
| `search.filter-too-many` | A filter field has too many distinct values, so it is not written as a filter. |
| `search.sort-unsupported` | A sort field holds long text or mixed types. |
| `search.index-failed` | The index could not be built. |

Every finding is in [Data findings](/data/validation/).
