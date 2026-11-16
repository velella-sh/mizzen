import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { opensearch } from "../src/outputs/opensearch.ts";
import { searchFacets } from "../src/outputs/search-facets.ts";
import { withSite } from "./data-record-site.ts";
import { SEARCH_FILES } from "./search-fixture.ts";

const context = { renderPage: async () => "", report: () => {} };

test("opensearch.xml and search-facets.json name the search parameters the same way", async () => {
  const files = {
    ...SEARCH_FILES,
    "mizzen.yml": `url: https://example.com\n${SEARCH_FILES["mizzen.yml"]}`,
  };
  await withSite(files, async (_root, result) => {
    const facets = JSON.parse(String((await searchFacets.run(result.site, context))[0]!.contents)) as {
      query: Record<string, string>;
    };
    const description = String((await opensearch.run(result.site, context))[0]!.contents);
    assert.match(description, new RegExp(`template="[^"]*\\?${facets.query.text}=\\{searchTerms\\}"`));
    assert.equal(facets.query.filter, "filter.{field}");
    assert.equal(facets.query.sort, "sort");
    assert.equal(facets.query.order, "order");
  });
});

test("the data-sites note publishes the same parameter names and the unknown-parameter rule", () => {
  const note = readFileSync(new URL("../docs/data-sites.md", import.meta.url), "utf8");
  assert.match(note, /\| Search text \| `q` \|/);
  assert.match(note, /`filter\.<field>`/);
  assert.match(note, /`sort`/);
  assert.match(note, /`order`/);
  assert.match(note, /parameter it does not know is ignored/);
});
