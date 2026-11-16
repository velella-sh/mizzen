---
title: Analytics and verification
description: Attach a cookieless analytics tool with one setting, see every outside origin a site contacts, and prove ownership to search engines.
layout: doc
permalink: /analytics/
---

The engine collects nothing and runs no server. The `analytics` key makes it write one deferred `<script>` tag into the head of each page; the tool you choose does the counting. A site without the key gets no script, and the engine does not recommend a provider.

## The `analytics` key

```yaml
analytics:
  provider: plausible
  site: example.com
```

| Key | Meaning |
| --- | --- |
| `provider` | One of `goatcounter`, `plausible`, `umami`, `cloudflare`, `custom`. Required. |
| `site` | GoatCounter code, Plausible domain, Umami website id, or Cloudflare beacon token. Required for every provider except `custom`. |
| `host` | Origin of a self-hosted tool, such as `https://stats.example.com`. |
| `src` | `custom` only, required: the script's `https` URL. |
| `attrs` | `custom` only: attributes written on the tag. |
| `allowedOrigins` | Outside origins the site may contact. Default `[]`. |

The tag is the same on every page of a build, never carries a timestamp, and the engine does not inline any provider code. The tag is part of the page's `Head` (`head.scripts`), and a theme prints it.

## Which pages get no script

A page has no script when its front matter says `analytics: false`, when it is built with the `embedded` layout, or when its project is not public in a network. The engine decides by those, never by the page's URL.

## One label per project

A site in a network that sets no `analytics` of its own takes the network's setting from the locked network file, and sends the project's `path` as `data-project`, so each project has its own numbers. A site's own `analytics` key wins. The build reads the lock only, never the network.

## Outside origins

When `analytics` is set, `mizzen doctor` lists every outside origin the built pages load scripts, styles, fonts, images or media from, plus the analytics tool's own. The list is also written to `.mizzen/manifest.json` as `origins`. An origin outside `analytics.allowedOrigins` earns the warning `origins.unlisted`; a warning never stops a build.

## Search engine verification

```yaml
verify:
  google: <token>
  bing: <32 hex characters>
```

`google` and `bing` write the `google-site-verification` and `msvalidate.01` meta tags on the home page. `googleFile` (such as `google0123456789abcdef.html`) and `bingFile` (the Bing user id) write the verification file at the site root instead. A provider you do not set gets neither a tag nor a file, and a value outside the provider's format is a config error.
