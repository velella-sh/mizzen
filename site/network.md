---
title: Several projects under one domain
description: Publish independent projects under one domain, with shared navigation input, links between projects, one search, and one sitemap, without one build depending on another.
layout: doc
permalink: /network/
---

A network is a set of independent projects published under one domain, such as `example.org/alpha` and `example.org/beta`. Each project builds on its own. They share one file, and each project builds from a pinned copy of it, so a build never reaches the network.

## The model

```text
  org repository                      each project's repository
 ┌────────────────┐   mizzen network   ┌────────────────────┐
 │  network.json  │ ── update ───────▶ │ network.lock.json  │
 │  (the list)    │    (the only       │ (pinned, hashed)   │
 └────────────────┘     fetch)         └─────────┬──────────┘
                                                 │ read by every build
                                                 ▼
                    base, project list for the theme, [[links]], search scope
```

`mizzen network update` is the only command that fetches. It reads the shared file and each public project's page list (`.mizzen/manifest.json`), and writes `network.lock.json`. A build reads only the lock, so the output stays byte-identical.

## The shared file

```json
{
  "version": 1,
  "projects": [
    { "id": "alpha", "path": "alpha", "title": "Alpha", "public": true },
    { "id": "beta", "path": "beta", "title": "Beta", "public": true, "search": "find" },
    { "id": "staging", "path": "staging", "title": "Staging", "public": false }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `version` | `1`. |
| `projects` | The projects, in the order themes list them. |
| `id` | The project's name in links and in the site config. Lowercase letters, digits, and hyphens. Unique. |
| `path` | The one URL segment the project is published under, without slashes. Unique. |
| `title` | The label shown for the project. |
| `public` | `false` keeps the project out of every shared output. |
| `analytics` | Analytics setting shared by the project, with the keys of the site config's `analytics`. |
| `manifest` | Where the project's page list is, below its path. Default `.mizzen/manifest.json`. |
| `search` | The folder of the project's search index, below its path. Default `pagefind`. |

Check the file with `mizzen network check network.json`.

## The site config

```yaml
network:
  source: https://example.org/network.json
  project: alpha
  maxAgeDays: 30
```

| Key | Meaning |
| --- | --- |
| `source` | The shared file's address: an `https` URL, or a path on disk. Required. |
| `project` | This site's `id` in the file. Required. |
| `maxAgeDays` | Days after which an old lock is a warning. Default `30`. |

The site's `base` becomes `/` plus the project's `path`. A `base` in the config that differs is the error `network.base-mismatch`.

## Commands

| Command | Does |
| --- | --- |
| `mizzen network check <file>` | Checks a local copy of the shared file. |
| `mizzen network update [dir]` | Fetches and writes `network.lock.json`; prints what changed. |
| `mizzen network update --check` | Writes nothing; exits 1 when the lock is out of date. |
| `mizzen network update --accept` | Accepts changed pages, clearing their "changed" marks. |
| `mizzen network sitemap [dir] --url <origin> --out <dir>` | Writes the organization's `sitemap.xml` index and a `robots.txt` that names it. |

The index lists the root site's own sitemaps and each public project's: run the command after the root build, in the
same output folder. A one-file root `sitemap.xml` keeps its bytes as `sitemap-pages.xml`; a split root index keeps its
child files. `robots.txt` keeps the build's other rules and replaces its `Sitemap:` line with the index. Paths are read
as URL segments, so a leading or trailing slash changes nothing, and a project is listed once.

The lock holds no date, so two updates on the same input write the same file.

## Links between projects

Write `[[beta:/guide/]]` to link a page of another project, or `[[beta:/guide/#install|how to install]]` to choose the text and keep an anchor. Without text, the link shows the page's title from the lock. A link inside code stays as written.

A link is checked against the lock, with the file and line of the link:

| Finding | Severity | Cause |
| --- | --- | --- |
| `network.link-missing-project` | error | The project is not in the lock. |
| `network.link-missing-page` | error | The project's page list has no such page. |
| `network.link-hidden` | error | A public project links to a project with `public: false`. |
| `network.link-changed` | warning | The page changed in the latest update; accept it with `--accept`. |

`mizzen doctor` counts broken and changed links.

## Search and sitemap

A build writes this project's search index under the project's `search` folder, and `pagefind-network.json` listing the other public projects' index folders. The theme merges them in the browser; nothing of another project is copied. The search results page takes `scope=project` (this project) or `scope=all`.

## Keeping the lock current

Copy `docs/recipes/network-update.yml` from the engine's repository to `.github/workflows/`. It runs weekly, and opens a pull request with the printed diff when the lock changed. It never pushes to the main branch.

## What a hidden project does

A project with `public: false` is left out of the theme's project list, the merged search, and the sitemap index. Its own build works as usual.
