---
title: Compare two builds
description: "Run mizzen diff to see which pages, blocks, URLs, files, and records changed between two builds, as text, JSON, or a pull request comment."
layout: doc
permalink: /site-diff/
---

`mizzen diff <a> <b>` compares two built folders and reports what changed on the site: which page, which block, which URL. It reads each folder's `.mizzen/manifest.json`, so it does not rebuild anything, and because a build is deterministic every difference is a real change.

## The report format

`--format json` prints one JSON object that validates against `schema/site-diff.schema.json` (shipped in the package). It names the two build hashes and lists pages added, removed, changed, and moved:

```json
{
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

A changed page has its URL, its source file, and its changed blocks: for each section its heading, its anchor id, the kind of change (`added`, `removed`, `edited`, or `moved`), and its line range in the Markdown twin of the second build (of the first build for a removed section). A page whose rendered HTML changed while its Markdown twin did not is `renderOnly`.

The report holds no page content: it names pages, headings, and line ranges. It never contains an absolute local path.

### The format only gains fields

Version 1 of the format only gains fields. A reader ignores a field it does not know, and a field a reader knows keeps its meaning and stays present. A change that removes or reinterprets a field would be version 2. Every list is sorted, so the same two builds give the same bytes.
