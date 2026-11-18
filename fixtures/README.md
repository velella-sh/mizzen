# Fixtures

Shared inputs for tests, benchmarks, and screenshots. Every epic builds against the same two sites, so a number measured in one task means the same thing in another.

| Folder | What it is |
| --- | --- |
| `docs-site/` | An Evergreen-shaped docs site of about 600 pages: the hand-written Beacon pages, 30 reference pages, 550 generated rule pages under `rules/`, an app page (`dashboard/`) with its own HTML, CSS, and JavaScript, a site-owned `llms.txt`, and `features.md`, which uses every Markdown construct the components support. Some pages have no front matter and start with an `h1`. |
| `rtl-site/` | Five Persian pages, right to left, mixing Persian and English, code blocks, and numbers. |
| `docs-versions/` | Current docs, an old release, and the default release, each version keeping its navigation; see its README and `docs/docs-versions.md`. |
| `compat-0.2/` | The `0.2.0` docs-site HTML hashes and a fixed test-only render fixture; see its README for provenance and the intentional-difference policy. |
| `compat-0.2.2/` | A small `0.2.2` data site and the published package's public-output hashes, canonical links, redirects, and sitemap; see its README and `scripts/release-compat.ts`. |
| `import-vitepress/` | A VitePress page with a container, a mapped Vue component, and a dynamic part, plus the expected import; see its README. |

## Rules

- **Fixtures are read-only.** A task does not edit a fixture file to suit itself, because every other task reads the same file. A task that needs new content adds a new fixture folder next to these and says why in its pull request.
- **Generated output is committed.** `node fixtures/docs-site/generate.ts` rewrites `docs-site/rules/` deterministically (a fixed seed, no clock), so running it twice gives no diff. `--check` fails when the folder is stale.
- **Each site has its own `mizzen.yml`** and builds on its own: `mizzen build fixtures/docs-site`.
