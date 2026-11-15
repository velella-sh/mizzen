import assert from "node:assert/strict";
import { test } from "node:test";
import { idsOf, loadSite } from "./data-schema-tree.ts";

test("two records with one id are one error naming both positions, and both records stay", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
    "_data/items.yml": "- id: one\n  name: First\n- id: one\n  name: Second\n",
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.duplicate-id");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "error");
  assert.match(found[0]!.message, /Record "one" of "items" repeats an id first used at _data\/items\.yml:1:3/);
  assert.match(found[0]!.message, /_data\/items\.yml:3:3/);
  assert.deepEqual(
    [found[0]!.pos?.line, found[0]!.pos?.column],
    [3, 3],
    "the finding points at the record that repeats",
  );
  assert.equal(result.collections["items"]!.records.length, 2, "the check never drops a record");
});

test("a duplicate in a configured unique field is one error at the repeated value", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    unique: [slug]\n",
    "_data/items.yml": "- id: one\n  slug: same\n- id: two\n  slug: same\n",
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.duplicate-value");
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /Field "slug" of record "two" in "items" repeats "same"/);
  assert.deepEqual([found[0]!.pos?.line, found[0]!.pos?.column], [4, 9]);
  assert.equal(result.collections["items"]!.records.length, 2);
});

test("ids and unique values that differ only by case are kept", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    unique: [slug]\n",
    "_data/items.yml": "- id: north\n  slug: North\n- id: North\n  slug: north\n",
  });
  assert.deepEqual(idsOf(result), []);
  assert.equal(result.collections["items"]!.records.length, 2);
});

test("an empty or missing unique value is never compared", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    unique: [slug]\n",
    "_data/items.yml": "- id: one\n  slug: \"\"\n- id: two\n",
  });
  assert.deepEqual(idsOf(result), []);
});
