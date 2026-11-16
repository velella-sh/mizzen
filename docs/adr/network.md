# ADR: how projects share one network file

Status: accepted (option A, 2026-11-15). Epic: multi-project.

## Context

Independent projects live under one domain (`example.org/alpha`, `example.org/beta`). Each is built in its own
repository. They need the same list of projects for navigation, cross-project links, search, a sitemap and a label per
project, and no build may depend on another build running first.

## Decision

One file, `network.json`, lives in the organization site's repository. Each project takes a **locked copy** of it.

- `mizzen network check <file>` validates the shared file (local file, no network).
- `mizzen network update [dir]` is the **only** command that fetches. It reads the network file and, for every public
  project, that project's page list and writes both, with SHA-256 hashes, to `network.lock.json` at the site root.
- A build reads `network.lock.json` and nothing else. It never touches the network.

### The format of `network.json`

```json
{
  "version": 1,
  "projects": [
    { "id": "alpha", "path": "alpha", "title": "Alpha", "public": true },
    { "id": "beta", "path": "beta", "title": "Beta", "public": false,
      "analytics": { "provider": "goatcounter", "site": "example" } }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `id` | Stable name other projects use in links, `[[alpha:guide/]]`. Lower case letters, digits, hyphens. Unique. |
| `path` | One URL segment the project is published under; its base is `/<path>`. Unique. |
| `title` | Human label for navigation and search. |
| `public` | `false` keeps the project out of every shared output. |
| `analytics` | Optional shared analytics setting; the project's own key wins. |
| `manifest` | Optional path of the page list below the project, default `.mizzen/manifest.json`. |
| `search` | Optional folder of the search index below the project, default `pagefind`. |

The JSON Schema is `schema/network.schema.json`; the lock's is `schema/network-lock.schema.json`.

### What each project publishes

1. **Its page list**: the build manifest (`<path>/.mizzen/manifest.json`), which already carries every page's URL,
   title and hashes. Other projects read it only through `mizzen network update`.
2. **Its search index folder** (`<path>/pagefind/`), which the theme merges in the browser. No project copies another's
   index.

### Why the build reads a locked copy and never the live file

- **Determinism.** The same repository state must give the same bytes. A live file changes under a build.
- **Independence.** A build works offline and while another project is down or mid-deploy.
- **Review.** A change in the network (a renamed project, a changed page) arrives as a reviewable diff of the lock,
  opened by a scheduled workflow, not as a surprise build failure.
- **Integrity.** The lock holds hashes, so a tampered or half-written copy is noticed.

The lock holds no timestamps and is written in a stable order, so two updates on the same input give the same bytes.

## Consequences

- Browser UI (navigation bar, search scope selector) belongs to the theme and is outside the engine.
- A link to a page that moved fails the build only after the next `network update` brings the move in.
- A site without a `network` key builds exactly as before.
