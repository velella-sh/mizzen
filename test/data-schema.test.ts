import assert from "node:assert/strict";
import { test } from "node:test";
import { idsOf, loadSite } from "./data-schema-tree.ts";

const SCHEMA = JSON.stringify({
  type: "object",
  required: ["title"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    count: { type: "integer" },
    status: { type: "string", enum: ["stable", "beta"] },
  },
});

const CONFIG = "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n";

test("a valid schema keeps every record and reports nothing", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": SCHEMA,
    "_data/items.yml": "- id: one\n  title: First\n  count: 1\n  status: stable\n- id: two\n  title: Second\n",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.collections["items"]!.records.length, 2);
  assert.equal(result.stats.schemas, 1);
  assert.deepEqual(result.stats.unchecked, []);
});

test("a wrong type, a missing field, and a bad enum each point at the field, and the records are left out", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": SCHEMA,
    "_data/items.yml":
      "- id: one\n  title: First\n  count: \"three\"\n- id: two\n  count: 2\n  status: shipped\n",
  });
  const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
  assert.deepEqual(
    invalid.map((diagnostic) => [diagnostic.severity, diagnostic.pos?.file, diagnostic.pos?.line, diagnostic.pos?.column]),
    [
      ["error", "_data/items.yml", 3, 10],
      ["error", "_data/items.yml", 4, 3],
      ["error", "_data/items.yml", 6, 11],
    ],
  );
  assert.match(invalid[0]!.message, /Field "count" of record "one" in "items" must be an integer\./);
  assert.match(invalid[1]!.message, /Record "two" of "items" is missing the required field "title"\./);
  assert.match(invalid[2]!.message, /Field "status" of record "two" in "items" must be one of "stable", "beta"\./);
  assert.match(invalid[0]!.message, /The record was skipped\.$/);
  assert.equal(result.collections["items"]!.records.length, 0);
  assert.equal(result.stats.skipped, 2);
  assert.ok(idsOf(result).includes("data.records-skipped"));
});

test("one JSON record points at the exact value", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.json\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": JSON.stringify({ type: "object", properties: { count: { type: "integer" } } }),
    "_data/items.json": '[{"id":"one","count":"three"}]',
  });
  const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
  assert.equal(invalid.length, 1);
  assert.deepEqual(
    [invalid[0]!.pos?.file, invalid[0]!.pos?.line, invalid[0]!.pos?.column, invalid[0]!.pos?.endColumn],
    ["_data/items.json", 1, 22, 28],
  );
});

test("one CSV cell points at its own column", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.csv\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": JSON.stringify({ type: "object", properties: { count: { type: "integer" } } }),
    "_data/items.csv": "id,count\none,three\n",
  });
  const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
  assert.equal(invalid.length, 1);
  assert.deepEqual(
    [invalid[0]!.pos?.file, invalid[0]!.pos?.line, invalid[0]!.pos?.column, invalid[0]!.pos?.endColumn],
    ["_data/items.csv", 2, 5, 9],
  );
});

test("several keywords about one field become one finding", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": JSON.stringify({
      type: "object",
      properties: { count: { type: "integer", minimum: 5, maximum: 10 } },
    }),
    "_data/items.yml": "- id: one\n  count: 2\n",
  });
  const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
  assert.equal(invalid.length, 1);
  assert.match(invalid[0]!.message, /must be at least 5/);
});

test("a schema that is not JSON, not an object, or cannot be compiled is one error naming the file", async () => {
  for (const [name, text] of [
    ["not JSON", "{ not json"],
    ["not an object", "[]"],
    ["unresolvable", JSON.stringify({ $ref: "https://example.com/remote.schema.json" })],
  ] as const) {
    const result = await loadSite({
      "mizzen.yml": CONFIG,
      "_data/items.schema.json": text,
      "_data/items.yml": "- id: one\n",
    });
    const invalid = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.schema-invalid");
    assert.equal(invalid.length, 1, name);
    assert.equal(invalid[0]!.pos?.file, "_data/items.schema.json", name);
    assert.match(invalid[0]!.message, /_data\/items\.schema\.json/, name);
    assert.equal(result.collections["items"]!.records.length, 1, `${name}: only the schema is reported`);
  }
});

test("a missing schema is one error naming the file, and the records stay unchecked", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.yml": "- id: one\n",
  });
  const missing = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.schema-missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.pos?.file, "mizzen.yml");
  assert.equal(result.collections["items"]!.records.length, 1);
  assert.equal(result.stats.schemas, 0);
});

test("a collection without a schema is unchecked, and its records load without findings", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
    "_data/items.yml": "- id: one\n",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.stats.unchecked, ["items"]);
  assert.equal(result.stats.records, 1);
});

test("wrong type, missing required, and bad enum point at exact YAML, JSON, and CSV positions", async () => {
  const schemaText = JSON.stringify({
    type: "object",
    required: ["title"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      count: { type: "integer" },
      status: { type: "string", enum: ["stable", "beta"] },
    },
  });

  const cases: { name: string; config: string; file: string; text: string; expected: [number, number][] }[] = [
    {
      name: "YAML",
      config: CONFIG,
      file: "_data/items.yml",
      text: "- id: one\n  title: T\n  count: \"three\"\n- id: two\n  count: 2\n  status: shipped\n",
      expected: [[3, 10], [4, 3], [6, 11]],
    },
    {
      name: "JSON",
      config: "collections:\n  items:\n    source: _data/items.json\n    schema: _data/items.schema.json\n",
      file: "_data/items.json",
      text: '[{"id":"one","title":"T","count":"three"},{"id":"two","count":2,"status":"shipped"}]',
      expected: [[1, 34], [1, 43], [1, 74]],
    },
    {
      name: "CSV",
      config: "collections:\n  items:\n    source: _data/items.csv\n    schema: _data/items.schema.json\n",
      file: "_data/items.csv",
      text: "id,count,status\none,three,shipped\ntwo,2,beta\n",
      expected: [[2, 1], [2, 5], [2, 11], [3, 1], [3, 5]],
    },
  ];

  for (const { name, config, file, text, expected } of cases) {
    const result = await loadSite({ "mizzen.yml": config, "_data/items.schema.json": schemaText, [file]: text });
    const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
    assert.deepEqual(
      found.map((diagnostic) => [diagnostic.pos?.line, diagnostic.pos?.column]),
      expected,
      `${name}: one exact position per finding`,
    );
    assert.equal(found.every((diagnostic) => diagnostic.pos?.file === file), true, name);
  }
});

test("a boolean schema is valid: true accepts every record, false rejects each one", async () => {
  const accepted = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": "true",
    "_data/items.yml": "- id: one\n- id: two\n",
  });
  assert.deepEqual(accepted.diagnostics, []);
  assert.equal(accepted.collections["items"]!.records.length, 2);
  assert.equal(accepted.stats.schemas, 1);

  const rejected = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": "false",
    "_data/items.yml": "- id: one\n- id: two\n",
  });
  assert.equal(rejected.diagnostics.some((diagnostic) => diagnostic.id === "data.schema-invalid"), false);
  assert.equal(rejected.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid").length, 2);
  assert.equal(rejected.collections["items"]!.records.length, 0);
  assert.equal(rejected.stats.skipped, 2);
});
