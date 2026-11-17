# Design: the published site check

Status: accepted. Epic: #503 (published-site-check). Version: 0.2.3.

A build proves its own inputs. It cannot prove that the host serves the built pages, that each page names itself as
canonical, or that an old address still redirects where the site intends. This check starts at a published sitemap and
asks the host those questions. It never runs as part of a build: a build still opens no network connection.

## Inputs

| Input | Flag | Required | Meaning |
| --- | --- | --- | --- |
| Sitemap | `--sitemap <url>` | yes | One absolute `http` or `https` URL of a sitemap or a sitemap index. This is the only source of addresses to check. |
| Allowed domain | `--domain <host>` | no | The one host the check may request, such as `example.org`. Default: the sitemap URL's hostname. |
| Redirect map | `--redirects <file>` | no | A JSON object from a source address to the final address it must reach. |

The allowed domain is a hostname, not an origin: scheme, port, and path are not part of it, and a request on the same
host may move from `http` to `https`. Comparison is on the parsed URL's lower-cased hostname with a trailing dot
removed, so an international name is compared in its punycode form. The sitemap URL itself is the entry point and may
be on any host; every address it yields, every redirect source or target, and every redirect hop must be on the allowed
domain. An address on another host is never requested.

An input that cannot be read or parsed is a usage error and exits `2`, before the first request:

- `--sitemap` is not an absolute `http`/`https` URL, or carries credentials or a fragment;
- `--domain` is not a bare hostname;
- `--redirects` is not a JSON object of non-empty strings, or an address in it is not on the allowed domain.

## Sitemap forms

A standalone sitemap is a `<urlset>` whose `<loc>` values are page URLs:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.test/</loc></url>
  <url><loc>https://example.test/guide/</loc></url>
</urlset>
```

An index is a `<sitemapindex>` whose `<loc>` values are sitemaps, not pages:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.test/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://example.test/sitemap-guides.xml</loc></sitemap>
</sitemapindex>
```

An index may name a sitemap or another index. A sitemap address already read is a cycle. The page URLs are the union
of every `<urlset>` reached, in sitemap order; a URL written twice is checked once and reported.

Only `<loc>` is read; `lastmod`, `changefreq`, `priority`, and every other element are ignored. A response is read as
XML whether or not its `Content-Type` says so, and a `.xml.gz` address is decompressed first.

| Limit | Value |
| --- | --- |
| A sitemap file | 50,000 `<loc>` values and 50 MB uncompressed |
| Sitemap files per check | 100 |
| Index depth | 5 |
| Page URLs per check | 50,000 |
| Redirect hops per address | 5 |
| Time per request | 10 seconds |

Passing a limit is a finding and stops reading that file or the check; it is never silently truncated.

## Redirect map

```json
{
  "/old/": "/new/",
  "https://example.test/legacy/": "https://example.test/guides/"
}
```

A key is the address requested; its value is the final address it must reach after redirects. Both may be an absolute
URL on the allowed domain or a path, which is resolved against the sitemap URL's origin. Addresses are compared after
URL normalization: lower-cased scheme and host, no default port, no fragment, and an empty path read as `/`.

Every map entry is requested whether or not its source is in the sitemap, so an old address can be checked after it
leaves the sitemap. A sitemap URL that redirects must also have an entry; its final address must match the entry.

## What is checked

- **The page answers.** Every sitemap URL, and every redirect source, ends with a `2xx` status.
- **The page names itself.** The final page has exactly one `<link rel="canonical">`, and its absolute URL equals the
  page's own URL. A relative `href` is resolved against the page URL. More than one canonical, or a different one, is
  one mismatch.
- **A redirect lands where the map says.** The final URL equals the map's value. A loop and a chain longer than the
  hop limit are reported separately from a wrong destination.

A redirect to another host is reported as a domain finding at the hop that leaves the allowed domain, and that hop is
not requested. The check does not execute JavaScript, keep cookies, authenticate, or follow links inside a page. It
reads HTML only for the canonical element and the response status.

## Findings

Each finding carries a stable id, the address it concerns, and, when the check knows them, the expected and actual
values. Every finding is an error unless its row says warning.

| Id | Severity | Meaning |
| --- | --- | --- |
| `published-site.sitemap` | error | A sitemap or index could not be fetched, is not XML, or has no `<loc>`. |
| `published-site.sitemap-cycle` | error | An index reaches a sitemap address already read. |
| `published-site.sitemap-limit` | error | A file, file count, depth, or page count passes its limit. |
| `published-site.sitemap-duplicate` | warning | The same page URL appears more than once. It is checked once. |
| `published-site.domain` | error | A sitemap, redirect, or redirect-target address is not on the allowed domain. It is not requested. |
| `published-site.unreachable` | error | A request timed out or failed before a response. |
| `published-site.status` | error | A page ended with a status other than `2xx`. |
| `published-site.canonical-missing` | error | A page has no canonical element. |
| `published-site.canonical-mismatch` | error | A page has more than one canonical, or one that is not the page's own URL. |
| `published-site.redirect-mismatch` | error | A redirect ends somewhere other than the map's value. |
| `published-site.redirect-loop` | error | A redirect returns to an address already visited. |
| `published-site.redirect-chain` | error | A redirect chain is longer than the hop limit. |
| `published-site.redirect-unexpected` | error | A sitemap URL redirects and the map has no entry for it. |

A failed sitemap fetch is a finding, not a usage error: the check ran, and the site did not answer. Only an input that
cannot start the check exits `2`.

## Report

The command writes text by default and JSON with `--format json`. Findings are sorted by address, then id, in
code-point order. Two runs over the same site state write the same bytes: the report holds no timestamp, duration, or
request order.

Text is one line per finding, then a summary:

```text
error published-site.status https://example.test/gone/: The page returned 404, expected 2xx.
URLs checked: 1; errors: 1; warnings: 0.
```

JSON is the machine contract:

```json
{
  "version": 1,
  "sitemap": "https://example.test/sitemap.xml",
  "domain": "example.test",
  "urls": 1,
  "findings": [
    {
      "id": "published-site.status",
      "severity": "error",
      "url": "https://example.test/gone/",
      "message": "The page returned 404, expected 2xx.",
      "expected": "2xx",
      "actual": "404"
    }
  ]
}
```

`urls` counts the addresses requested as pages or redirect sources, once each. `expected` and `actual` are left out
when a finding has no value for them. Keys are written in the order above.

## Exit behavior

| Code | Meaning |
| --- | --- |
| `0` | The check ran and no finding has severity `error`. |
| `1` | The check ran and at least one finding has severity `error`. |
| `2` | The check could not start because an input is invalid or unreadable. |

`2` wins over `1`; a usage error is written to stderr and no report is written.

## Not promised

The check does not discover pages outside the sitemap, prove that a page's content is current, check external links,
or stand in for a browser. A correct check says the host answers, names each page as canonical, and sends the mapped
redirects; it says nothing about what the page means.
