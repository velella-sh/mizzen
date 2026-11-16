import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH_FILES } from "./search-fixture.ts";
import { withIndexedSite } from "./search-runtime.ts";

test("a record is found by another name, and only words in a field find it", async () => {
  await withIndexedSite(SEARCH_FILES, async (_result, runtime) => {
    const alias = await runtime.search("Alphonso");
    assert.equal(alias.results.length, 1);
    const data = await alias.results[0]!.data();
    assert.equal(data.url, "/posts/alpha/");
    assert.doesNotMatch(data.excerpt ?? "", /Alphonso/, "an alias is never page text");

    assert.equal((await runtime.search("Zebra")).results.length, 0, "a word in no field finds nothing");
  });
});
