import assert from "node:assert/strict";
import { test } from "node:test";
import { idsOf, loadSite } from "./data-schema-tree.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
  "_data/items.schema.json": JSON.stringify({ type: "object", required: ["title"], properties: { title: { type: "string" } } }),
  "_data/items.yml": "- id: good\n  title: Good\n- id: bad\n",
};

test("the default policy fails the build, leaves the record out, and counts it", async () => {
  const result = await loadSite(FILES);
  const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
  assert.deepEqual(invalid.map((diagnostic) => diagnostic.severity), ["error"]);
  assert.deepEqual(result.collections["items"]!.records.map((record) => record.id), ["good"]);
  assert.equal(result.stats.skipped, 1);
  const summary = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.records-skipped");
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.severity, "info");
  assert.match(summary[0]!.message, /^Skipped 1 record that failed validation\.$/);
  assert.ok(result.diagnostics[result.diagnostics.length - 1] === summary[0], "the count ends the run");
});

test("onInvalid skip warns instead of failing, and still leaves the record out", async () => {
  const result = await loadSite({
    ...FILES,
    "mizzen.yml":
      "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n    onInvalid: skip\n",
  });
  const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
  assert.deepEqual(invalid.map((diagnostic) => diagnostic.severity), ["warning"]);
  assert.deepEqual(result.collections["items"]!.records.map((record) => record.id), ["good"]);
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    false,
    "a skipped record never fails the build",
  );
  assert.ok(idsOf(result).includes("data.records-skipped"));
});

test("no invalid record means no summary line", async () => {
  const result = await loadSite({
    ...FILES,
    "_data/items.yml": "- id: good\n  title: Good\n",
  });
  assert.deepEqual(idsOf(result), []);
  assert.equal(result.stats.skipped, 0);
});

test("the summary line counts records across collections", async () => {
  const result = await loadSite({
    "mizzen.yml":
      "collections:\n" +
      "  one:\n    source: _data/one.yml\n    schema: _data/items.schema.json\n    onInvalid: skip\n" +
      "  two:\n    source: _data/two.yml\n    schema: _data/items.schema.json\n    onInvalid: skip\n",
    "_data/items.schema.json": JSON.stringify({ type: "object", required: ["title"], properties: { title: { type: "string" } } }),
    "_data/one.yml": "- id: a\n",
    "_data/two.yml": "- id: b\n- id: c\n",
  });
  const summary = result.diagnostics.find((diagnostic) => diagnostic.id === "data.records-skipped");
  assert.match(summary?.message ?? "", /Skipped 3 records/);
  assert.equal(result.stats.skipped, 3);
});
