import assert from "node:assert/strict";
import { test } from "node:test";
import { searchFacets } from "../src/outputs/search-facets.ts";
import { withSite } from "./data-record-site.ts";
import { SEARCH_FILES } from "./search-fixture.ts";

const context = { renderPage: async () => "", report: () => {} };

test("search-facets.json counts each filter value and names the query parameters", async () => {
  await withSite(SEARCH_FILES, async (_root, result) => {
    const files = await searchFacets.run(result.site, context);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "search-facets.json");
    const facets = JSON.parse(String(files[0]!.contents)) as {
      query: Record<string, string>;
      filters: Record<string, Record<string, number>>;
    };
    assert.deepEqual(facets.query, { text: "q", filter: "filter.{field}", sort: "sort", order: "order" });
    assert.deepEqual(facets.filters, {
      collection: { posts: 3 },
      status: { draft: 1, published: 2 },
      tags: { news: 2, release: 2 },
    });
    assert.deepEqual(Object.keys(facets.filters), ["collection", "status", "tags"], "filters are in code-point order");
    assert.deepEqual(Object.keys(facets.filters.status!), ["draft", "published"], "values are in code-point order");
  });
});

test("two builds write byte-identical facets", async () => {
  await withSite(SEARCH_FILES, async (_root, result) => {
    const first = await searchFacets.run(result.site, context);
    const second = await searchFacets.run(result.site, context);
    assert.deepEqual(second, first);
  });
});
