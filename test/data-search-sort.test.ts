import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { search } from "../src/outputs/search.ts";
import { withSite } from "./data-record-site.ts";
import { SEARCH_FILES } from "./search-fixture.ts";
import { urlsOf, withIndexedSite } from "./search-runtime.ts";

test("results order by a declared date field", async () => {
  await withIndexedSite(SEARCH_FILES, async (_result, runtime) => {
    const found = await runtime.search("Searchable", { sort: { date: "asc" } });
    assert.deepEqual(await urlsOf(found), ["/posts/alpha/", "/posts/beta/", "/posts/gamma/"]);
  });
});

test("results order by a number as a number, not as text", async () => {
  await withIndexedSite(SEARCH_FILES, async (_result, runtime) => {
    const found = await runtime.search("Searchable", { sort: { rank: "asc" } });
    assert.deepEqual(await urlsOf(found), ["/posts/gamma/", "/posts/alpha/", "/posts/beta/"]);
  });
});

test("a sort field that is long text is reported and left out", async () => {
  const body = "This field is far too long to be used as a sort key because it holds a whole paragraph of prose. ".repeat(2);
  const files = {
    "mizzen.yml": [
      "collections:",
      "  posts:",
      "    source: _data/posts.yml",
      "    template: _templates/posts.md",
      "    permalink: /posts/{id}/",
      "    search:",
      "      sort: [body]",
      "",
    ].join("\n"),
    "_data/posts.yml": `- id: a\n  title: A\n  body: ${body}\n`,
    "_templates/posts.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n\n:field[body]\n",
  };
  await withSite(files, async (_root, result) => {
    const reports: Diagnostic[] = [];
    await search.run(result.site, { renderPage: async () => "", report: (d) => reports.push(d) });
    const finding = reports.find((d) => d.id === "search.sort-unsupported");
    assert.ok(finding, "the long text sort is reported");
    assert.equal(finding.severity, "warning");
    assert.match(finding.message, /body/);
  });
});
