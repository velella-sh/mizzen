---
title: SEO for data pages
description: Describe record and list pages to search engines from their data, with limits, canonical URLs, noindex, lastmod, JSON-LD, and breadcrumbs.
---

# SEO for data pages

`collections.<name>.seo` describes a collection's record and list pages to search engines from the fields of the data.
The head carries the result; nothing is filled in at run time.

```yaml
collections:
  components:
    source: _data/components.yml
    template: _templates/components.md
    permalink: /components/{slug}/
    seo:
      titleMax: 60
      descriptionMax: 155
      noindex: hidden
      lastmod: updated
      jsonLd:
        "@type": SoftwareApplication
        name: "{name}"
        description: "{summary}"
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `titleMax` | integer | `70` | Longest title a record page may have before a warning. |
| `descriptionMax` | integer | `160` | Longest description a record page may have before a warning. |
| `canonical` | string | | Field that holds a record's own canonical URL. Front matter `canonical_url` still wins. |
| `noindex` | string | | Field that marks a record as not to be indexed. A true value writes `noindex` and leaves the page out of the sitemap. |
| `lastmod` | string | | Field that holds the date of a record's last change, written as the sitemap's `lastmod`. |
| `jsonLd` | object | | Structured data of each record page: a mapping with an `@type`, whose string values may name fields as `{field}`. |
| `breadcrumbs` | boolean | `true` | `false` leaves the `BreadcrumbList` off record and list pages. |
| `itemList` | boolean | `true` | `false` leaves the `ItemList` off list pages. |

## What the build writes

- The head of every page: title, description, canonical URL, Open Graph and Twitter tags, and `hreflang` links that name
  only real translations of one record.
- JSON-LD on record pages from `jsonLd`, a `BreadcrumbList` on record and list pages, and an `ItemList` on list pages.
- `sitemap.xml`, with `lastmod` from the field named by `lastmod`. Pages marked `noindex` are left out. A sitemap
  over 50,000 URLs or 50 MB is split into an index and per-collection files.
- A warning for a title or description over its limit, and for duplicate titles and descriptions across record pages,
  so two records are never described the same way.

A site with no `url` cannot write absolute URLs: the sitemap and canonical links are skipped and reported, never
guessed. Share images are a separate step: see [Social images](/data/social-images/).
