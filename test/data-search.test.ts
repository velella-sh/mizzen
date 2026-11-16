import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfigText } from "../src/config/load.ts";
import { SEARCH_FILES } from "./search-fixture.ts";
import { urlsOf, withIndexedSite } from "./search-runtime.ts";

test("record pages enter the index with their title, description, and declared metadata", async () => {
  await withIndexedSite(SEARCH_FILES, async (result, runtime) => {
    assert.deepEqual(result.diagnostics, []);
    const found = await runtime.search("Alpha");
    assert.equal(found.results.length, 1);
    const data = await found.results[0]!.data();
    assert.equal(data.url, "/posts/alpha/");
    assert.equal(data.meta.title, "Alpha");
    assert.equal(data.meta.description, "Alpha record");
    assert.equal(data.meta.author, "Ada");
    assert.equal(data.meta.date, "2024-01-01");
  });
});

test("a record whose own search field is false stays out of the index", async () => {
  await withIndexedSite(SEARCH_FILES, async (_result, runtime) => {
    const found = await runtime.search("Searchable");
    assert.deepEqual((await urlsOf(found)).sort(), ["/posts/alpha/", "/posts/beta/", "/posts/gamma/"]);
    assert.equal((await runtime.search("Delta")).results.length, 0);
  });
});

test("a collection keeps its search and index settings", () => {
  const src = [
    "collections:",
    "  posts:",
    "    source: _data/posts.yml",
    "    search:",
    "      meta: [author]",
    "      filters: [status, tags]",
    "      sort: [date]",
    "      aliases: aka",
    "    index:",
    "      fields: [title, date]",
    "      bytes: 500",
    "",
  ].join("\n");
  const { config, diagnostics } = loadConfigText(src, "mizzen.yml", "site");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(config.collections.posts?.search, {
    meta: ["author"],
    filters: ["status", "tags"],
    sort: ["date"],
    aliases: "aka",
  });
  assert.deepEqual(config.collections.posts?.index, { fields: ["title", "date"], bytes: 500 });
});

test("a bad search key and an index without fields are errors", () => {
  const badSearch = loadConfigText(
    "collections:\n  posts:\n    source: _data/posts.yml\n    search:\n      filter: [status]\n",
    "mizzen.yml",
    "site",
  );
  assert.ok(badSearch.diagnostics.some((d) => d.id === "config.unknown-key"));
  assert.equal(badSearch.config.collections.posts?.search, undefined);

  const badIndex = loadConfigText(
    "collections:\n  posts:\n    source: _data/posts.yml\n    index:\n      bytes: 500\n",
    "mizzen.yml",
    "site",
  );
  assert.ok(badIndex.diagnostics.some((d) => d.id === "config.invalid"));
  assert.equal(badIndex.config.collections.posts?.index, undefined);
});
