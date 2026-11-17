# Audit: the network sitemap command

Epic: #497. Audited command: `mizzen network sitemap [dir] --url <origin> --out <dir>`, before the fixes in #499 and
#500.

## Fixture

One root site, built first, with a home page. A lock file beside it with:

| Project | Path in the lock | Public |
| --- | --- | --- |
| Docs | `docs` | yes |
| Blog | `/blog/` | yes |
| Internal | `internal` | no |

Run:

```bash
mizzen network sitemap . --url https://example.org --out out
```

## What already worked

- The index is a canonical `<sitemapindex>`: sorted, LF endings, no timestamp; two runs write the same bytes.
- Every public project is listed at `<origin>/<path>/sitemap.xml`; a project with `public: false` is left out.
- `robots.txt` names the index with an absolute `Sitemap:` line.
- The origin comes from `--url`, or from an `https` `source` in the lock; a path source without `--url` is an error.
- A missing or invalid lock exits 1, an unreadable input folder exits 2.

## Confirmed gaps

1. **The root site's own pages were lost.** The build's `sitemap.xml` was overwritten by the index, so no crawler
   could reach the root page sitemap. This is the gap the epic's goal names.
2. **A path with a slash at either end produced a broken address.** `/blog/` became
   `https://example.org//blog//sitemap.xml`.
3. **The same project could be listed twice.** `docs` and `/docs/` are one address but wrote two entries.
4. **A root project could make the index list itself.** A path of `/` produced the index's own address, which a
   sitemap index must not do.
5. **The root site's robots rules were dropped.** The command wrote its own `User-agent: *` / `Allow: /` and lost any
   `Disallow:` or other rule the build had written.

## Resolution

- #499 fixes gaps 1 to 4 in `src/network/sitemap.ts` and covers each case in
  `test/network-discovery/index.test.ts`. A one-file root sitemap keeps its bytes as `sitemap-pages.xml`; a split root
  sitemap keeps its child files; paths are read as URL segments, duplicates are written once, and the index never
  lists itself.
- #500 fixes gap 5 and covers the reference in `test/network-discovery/robots.test.ts`; the recipe and its test are
  #501.
