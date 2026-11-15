import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { idsOf, loadSite } from "./data-schema-tree.ts";

/** The one finding a site makes. */
function only(result: Awaited<ReturnType<typeof loadSite>>, id: string): Diagnostic {
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === id);
  assert.equal(found.length, 1, idsOf(result).join(", "));
  return found[0]!;
}

const schema = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "object", properties, ...extra });

test("a near-miss enum value suggests the allowed value and the span that replaces it", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ status: { type: "string", enum: ["stable", "beta"] } }),
    "_data/items.yml": "- id: one\n  status: stabel\n",
  });
  const found = only(result, "data.record-invalid");
  assert.equal(found.help, 'Did you mean "stable"?');
  assert.deepEqual(found.fix, {
    file: "_data/items.yml",
    line: 2,
    column: 11,
    endLine: 2,
    endColumn: 16,
    text: "stable",
  });
});

test("a near-miss field name is suggested in prose, without a span fix", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ id: { type: "string" }, title: { type: "string" } }, { additionalProperties: false }),
    "_data/items.yml": "- id: one\n  titel: First\n",
  });
  const found = only(result, "data.record-invalid");
  assert.equal(found.help, 'Did you mean "title"?');
  assert.equal("fix" in found, false, "renaming a key needs the key's span, which a record does not carry");
});

test("a number written as a string suggests the unquoted number", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ count: { type: "integer" } }),
    "_data/items.yml": '- id: one\n  count: "42"\n',
  });
  const found = only(result, "data.record-invalid");
  assert.equal(found.help, "Write the number without quotes: 42.");
  assert.deepEqual(
    [found.fix?.column, found.fix?.endColumn, found.fix?.text],
    [10, 13, "42"],
  );
});

test("a missing required field states the expected type and an example", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ title: { type: "string" } }, { required: ["title"] }),
    "_data/items.yml": "- id: one\n",
  });
  const found = only(result, "data.record-invalid");
  assert.equal(found.help, 'Add a "title" field (a string), such as `title: Example`.');
});

test("a finding with no safe suggestion carries neither help nor fix", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ code: { type: "string", pattern: "^[0-9]+$" } }),
    "_data/items.yml": "- id: one\n  code: abc\n",
  });
  const found = only(result, "data.record-invalid");
  assert.equal("help" in found, false);
  assert.equal("fix" in found, false);
});
