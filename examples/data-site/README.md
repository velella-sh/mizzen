# Example data site

A small catalogue built from two data files. It is generic: every value is invented, and nothing names a product or a
company. The site shows the whole data path: collections, record pages from templates, list pages, a feed, and search
filters. [Data sites](../../site/data/index.md) explains each idea, and
[Start a data site](../../site/data/quick-start.md) walks the same files.

Build it from the repository root:

```sh
node bin/mizzen.ts build examples/data-site --out dist
node bin/mizzen.ts urls check examples/data-site
```

CI builds it from the packed tarballs with `scripts/smoke-example.sh`: two builds, the same build hash, a passing
`mizzen verify`, and a clean `mizzen urls check`. `test/example-data-site.test.ts` runs the same checks from a checkout.

## The files

| File | What it is |
| --- | --- |
| `mizzen.yml` | The site config: the two collections, their URL patterns, search filters, the compact index, the reference date, and the feed. |
| `_data/components.yml` | The `components` collection: a YAML list, one record each, with `slug` as the id. `summary` is Markdown. |
| `_data/releases.json` | The `releases` collection: a JSON object keyed by release id. `component` refers to a component by id. |
| `_templates/components.md` | The template of a component page: front matter filled from the record, `:field[…]` values, and a `:::records` block listing the releases of that component. |
| `_templates/releases.md` | The template of a release page. |
| `index.md` | The home page, which counts records with `:count{from=…}`. |
| `components/index.md` | A list page: every component sorted by name, plus a `::data-table` of the same records. |
| `releases/index.md` | A list page grouped by month and paginated, five releases a page. |
| `status/index.md` | A list page that expands one page per component status, such as `/status/stable/`. |
| `urls.lock.json` | The URL lock. It holds every record page's URL, so a rename is caught by `mizzen build` and `mizzen urls check`. |

Every page here sets `layout: doc`, so the site builds with any theme that has a `doc` layout. A theme with `record`
and `list` layouts can draw the records and groups itself: remove the `layout` lines and it receives
`LayoutProps.record` and `LayoutProps.list`.

## What a build writes

Besides the pages, the build writes `feeds/releases.xml` and `feeds/releases.json`, `search-facets.json` and the
search index, `urls.json` (record id to URL), `data/<collection>.json`, `.csv`, `.raw.json`, and `.sha256`,
`data/components.index.json`, and a sitemap. Run `mizzen build` twice and the output is byte for byte the same.
