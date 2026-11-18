---
title: Compare two builds
description: "Run mizzen diff to see which pages, blocks, URLs, files, and records changed between two builds, as text, JSON, or a pull request comment."
layout: doc
permalink: /site-diff/
---

`mizzen diff <a> <b>` compares two built folders and reports what changed on the site: which page, which block, which URL. It reads each folder's `.mizzen/manifest.json`, so it does not rebuild anything, and because a build is deterministic every difference is a real change.

## Compare two folders

```bash
mizzen build site --out base
# change something, then:
mizzen build site --out head
mizzen diff base head
```

A folder without a `.mizzen/manifest.json` is a usage error (exit `2`): build the site into it first. Equal builds answer "identical" at once.

## Compare with a git ref

```bash
mizzen diff --base main site
```

`--base <ref>` checks the ref out into a temporary detached worktree, builds it and your current tree, compares them, and removes the worktree and the temporary folders, whether the build succeeds or fails. Your working tree and index are never touched. Both builds share the site's build cache (`.mizzen/cache`), so a page that did not change is rendered once. The theme is resolved as for `mizzen build`; pass `--theme <dir>` to name it.

## Formats

`--format` picks the report:

- `text` (default): a summary line, then one section per kind of change.
- `json`: the report format below.
- `markdown`: a pull request comment, a summary line and a table with one row per page, file, or record. `--max-entries <n>` (default 50) caps the rows and says how many it left out; `--link-base <url>` links page URLs under that base. Cell text is escaped, so page content cannot add markup to the comment. The comment starts with `<!-- mizzen-diff -->`, which the recipe uses to find and update it.

## Exit codes

`mizzen diff` exits `0` whenever it ran, whatever it found. `--fail-on` takes a comma-separated list of kinds and exits `1` when the report holds one of them:

| Kind | Fails when |
| --- | --- |
| `removed-pages` | a page of the first build has no page in the second and did not move |
| `broken-urls` | an old URL is no longer answered: a removed page, or a moved page without a redirect at its old URL |
| `render-only` | a page's HTML changed while its Markdown did not |

Exit `2` is a usage problem: a folder without a manifest, an unknown kind or format, or a ref that does not exist.

## A pull request comment

`recipes/site-diff.yml` is a GitHub Actions workflow. Copy it to `.github/workflows/site-diff.yml`, set `SITE` to your site folder, and it comments on every pull request and edits that one comment on each push. The job that builds the pull request's code has a read-only token; the job that posts the comment has `pull-requests: write`, runs none of the pull request's code, and does not run for forks.

## The report format

`--format json` prints one JSON object that validates against `schema/site-diff.schema.json` (shipped in the package). It names the two build hashes and lists pages added, removed, changed, and moved:

```json
{
  "schemaVersion": 1,
  "version": 1,
  "base": { "hash": "1111111111111111111111111111111111111111111111111111111111111111" },
  "head": { "hash": "2222222222222222222222222222222222222222222222222222222222222222" },
  "identical": false,
  "summary": {
    "pages": { "added": 1, "removed": 0, "changed": 1, "moved": 0 },
    "files": { "added": 0, "removed": 0, "changed": 1 },
    "records": { "added": 0, "removed": 0, "changed": 0 },
    "brokenUrls": 0,
    "renderOnly": 0
  },
  "pages": {
    "added": [{ "url": "/guide/new/", "source": "guide/new.md", "title": "New" }],
    "removed": [],
    "changed": [
      {
        "url": "/install/",
        "source": "install.md",
        "title": "Install",
        "changes": ["text", "html"],
        "renderOnly": false,
        "blocks": [{ "heading": "Requirements", "id": "requirements", "kind": "edited", "range": { "start": 5, "end": 12 } }]
      }
    ],
    "moved": []
  },
  "brokenUrls": [],
  "files": {
    "added": [],
    "removed": [],
    "changed": [
      {
        "name": "assets/theme/base.css",
        "group": "assets",
        "path": "assets/theme/base-0123456789abcdef.css",
        "size": { "before": 1200, "after": 1260 }
      }
    ]
  },
  "records": []
}
```

A changed page has its URL, its source file, and its changed blocks. A build that carries block ids is compared by those ids, so a block that kept its id is the same block after a heading edit or a reorder. Each block names its heading, its stable id, and the kind of change: `added`, `removed`, `edited`, `moved` (a pure move), `moved-edited`, `heading`, `code`, `code-language`, `table` (with the changed `cell`), `link` or `image` (with the `destination`), `record` (with the `field` and the `value` it produced), or `uncertain` when two blocks could match. `before` and `after` carry the source file and line range of each side. A page whose rendered HTML changed while its Markdown twin did not is `renderOnly`. `--change-type <type>` keeps only one kind in the printed report.

The report holds no page content: it names pages, headings, and line ranges. It never contains an absolute local path.

### The format only gains fields

Version 1 of the format only gains fields. A reader ignores a field it does not know, and a field a reader knows keeps its meaning and stays present. A change that removes or reinterprets a field would be version 2. Every list is sorted, so the same two builds give the same bytes.
