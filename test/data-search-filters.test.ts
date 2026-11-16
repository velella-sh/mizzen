import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { search } from "../src/outputs/search.ts";
import { searchFacets } from "../src/outputs/search-facets.ts";
import { buildModel } from "../src/model/build.ts";
import { withSite } from "./data-record-site.ts";
import { SEARCH_FILES } from "./search-fixture.ts";
import { urlsOf, withIndexedSite } from "./search-runtime.ts";

test("a filter narrows the index by one field, by two, and by collection", async () => {
  await withIndexedSite(SEARCH_FILES, async (_result, runtime) => {
    const published = await runtime.search("Searchable", { filters: { status: "published" } });
    assert.deepEqual((await urlsOf(published)).sort(), ["/posts/alpha/", "/posts/gamma/"]);

    const news = await runtime.search("Searchable", { filters: { status: "published", tags: "news" } });
    assert.deepEqual(await urlsOf(news), ["/posts/alpha/"]);

    const posts = await runtime.search("Searchable", { filters: { collection: "posts" } });
    assert.equal(posts.results.length, 3, "the collection filter matches every record page");
  });
});

test("a filter field with too many values is reported and left out", async () => {
  const records = Array.from({ length: 101 }, (_, index) => `- id: p${index}\n  title: Title ${index}\n`);
  const files = {
    "mizzen.yml": [
      "collections:",
      "  posts:",
      "    source: _data/posts.yml",
      "    template: _templates/posts.md",
      "    permalink: /posts/{id}/",
      "    search:",
      "      filters: [title]",
      "",
    ].join("\n"),
    "_data/posts.yml": records.join(""),
    "_templates/posts.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
  };
  await withSite(files, async (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const reports: Diagnostic[] = [];
    await search.run(result.site, { renderPage: async () => "", report: (d) => reports.push(d) });
    const finding = reports.find((d) => d.id === "search.filter-too-many");
    assert.ok(finding, "the free-text filter is reported");
    assert.equal(finding.severity, "warning");
    assert.match(finding.message, /posts/);
    assert.match(finding.message, /title/);

    const facets = String((await searchFacets.run(result.site, { renderPage: async () => "", report: () => {} }))[0]?.contents);
    assert.doesNotMatch(facets, /"title"/, "the free-text field is not a facet");
    assert.match(facets, /"collection"/);
  });
});
