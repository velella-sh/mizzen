import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportedPage } from "../src/import/contract.ts";
import { rewriteLinks } from "../src/import/links.ts";
import type { ImportMapping } from "../src/import/mapping.ts";

const mappings: readonly ImportMapping[] = [
  { source: "index.md", kind: "content", destination: "index.md", url: "/" },
  { source: "guide/intro.mdx", kind: "content", destination: "guide/about.md", url: "/guide/about/" },
  { source: "guide/setup.md", kind: "content", destination: "guide/setup.md", url: "/guide/setup/" },
  { source: "logo.png", kind: "asset", destination: "logo.png", url: "/logo.png" },
  { source: "guide/old.mdx", kind: "content", reason: "the destination is invalid" },
];

test("relative and root-absolute page links become the mapped destination, keeping query and anchor", () => {
  const page: ImportedPage = {
    source: "guide/setup.md",
    destination: "guide/setup.md",
    contents: [
      "---",
      "title: Setup",
      "---",
      "[intro](../guide/intro.mdx?tab=1#install) and [home](/guide/intro.mdx#top).",
      "[intro](../guide/intro.mdx) and [../guide/intro.mdx](../guide/intro.mdx).",
      "[external](https://example.com/guide/intro.md) and [asset](../logo.png).",
      "`[code](../guide/intro.mdx)` and [anchor](#install).",
      "",
      "```md",
      "[fenced](../guide/intro.mdx)",
      "```",
      "",
      "[ref]: ../guide/intro.mdx \"Intro\"",
      "",
    ].join("\n"),
  };

  const { pages, diagnostics } = rewriteLinks([page], mappings);

  assert.deepEqual(diagnostics, []);
  assert.equal(
    pages[0]!.contents,
    [
      "---",
      "title: Setup",
      "---",
      "[intro](/guide/about/?tab=1#install) and [home](/guide/about/#top).",
      "[intro](/guide/about/) and [../guide/intro.mdx](/guide/about/).",
      "[external](https://example.com/guide/intro.md) and [asset](../logo.png).",
      "`[code](../guide/intro.mdx)` and [anchor](#install).",
      "",
      "```md",
      "[fenced](../guide/intro.mdx)",
      "```",
      "",
      "[ref]: /guide/about/ \"Intro\"",
      "",
    ].join("\n"),
  );
});

test("an internal page link with no destination is reported at its source line and left as written", () => {
  const page: ImportedPage = {
    source: "guide/setup.md",
    destination: "guide/setup.md",
    contents: "line one\n\n[missing](./missing.md#x) and [old](./old.mdx)\n",
  };

  const { pages, diagnostics } = rewriteLinks([page], mappings);

  assert.equal(pages[0]!.contents, page.contents);
  assert.deepEqual(
    diagnostics.map((finding) => [finding.id, finding.severity, finding.pos?.file, finding.pos?.line]),
    [
      ["import.unresolved-link", "warning", "guide/setup.md", 3],
      ["import.unresolved-link", "warning", "guide/setup.md", 3],
    ],
  );
});
