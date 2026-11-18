import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import type { TransformEvent } from "../src/data/transform.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "transform-records-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function load(root: string, onTransformEvent?: (event: TransformEvent) => void) {
  const { config } = loadConfig(root);
  return loadCollections({ root, config, ...(onTransformEvent === undefined ? {} : { onTransformEvent }) });
}

test("a filter over several fields keeps exactly the matching records", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - id: recent-books",
      "          op: filter",
      "          where:",
      "            type: book",
      "            year: 2026",
      "",
    ].join("\n"),
    "data/items.yml": [
      "- slug: a",
      "  type: book",
      "  year: 2026",
      "- slug: b",
      "  type: book",
      "  year: 2025",
      "- slug: c",
      "  type: cd",
      "  year: 2026",
      "- slug: d",
      "  type: book",
      "  year: 2026",
      "",
    ].join("\n"),
  });
  try {
    const result = await load(root);
    assert.deepEqual(result.collections["items"]!.records.map((record) => record.id), ["a", "d"]);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dedupe uses a composite key and the selection policy picks the surviving row", async () => {
  const config = (keep: string) => [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    transform:",
    "      steps:",
    "        - id: one-per-place",
    "          op: dedupe",
    "          by: [region, kind]",
    `          keep: ${keep}`,
    "",
  ].join("\n");
  const data = [
    "- slug: first",
    "  region: north",
    "  kind: town",
    "  note: first north",
    "- slug: south",
    "  region: south",
    "  kind: town",
    "- slug: second",
    "  region: north",
    "  kind: town",
    "  note: second north",
    "- slug: other",
    "  region: north",
    "  kind: city",
    "",
  ].join("\n");

  const kept = await load(tree({ "mizzen.yml": config("first"), "data/items.yml": data }));
  assert.deepEqual(kept.collections["items"]!.records.map((record) => record.id), ["first", "south", "other"]);

  const last = await load(tree({ "mizzen.yml": config("last"), "data/items.yml": data }));
  assert.deepEqual(last.collections["items"]!.records.map((record) => record.id), ["south", "second", "other"]);
});

test("raw input and transformed output schema findings name their stage and the step", async () => {
  const schema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { slug: { type: "string" }, price: { type: "number" }, label: { type: "string" } },
    required: ["slug", "price", "label"],
    additionalProperties: false,
  });
  const config = (validate: string) => [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    schema: schema.json",
    "    transform:",
    `      validate: ${validate}`,
    "      steps:",
    "        - id: price-number",
    "          op: cast",
    "          field: price",
    "          to: number",
    "        - id: drop-label",
    "          op: remove",
    "          fields: [label]",
    "",
  ].join("\n");
  const data = "- slug: a\n  price: \"2.5\"\n  label: Name\n";

  const split = await load(tree({ "mizzen.yml": config("before-and-after"), "schema.json": schema, "data/items.yml": data }));
  const input = split.diagnostics.find((diagnostic) => diagnostic.id === "data.record-invalid-input");
  const output = split.diagnostics.find((diagnostic) => diagnostic.id === "data.record-invalid-output");
  assert.ok(input, "the raw record is reported before transformation");
  assert.match(input.message, /raw record does not match the schema/);
  assert.ok(output, "the transformed record is reported after transformation");
  assert.match(output.message, /after step "drop-label"/);
  assert.equal(split.collections["items"]!.records.length, 0, "an output that violates the schema is still skipped");

  const after = await load(tree({ "mizzen.yml": config("after"), "schema.json": schema, "data/items.yml": data }));
  assert.equal(after.diagnostics.some((diagnostic) => diagnostic.id === "data.record-invalid-input"), false);
  assert.ok(after.diagnostics.some((diagnostic) => diagnostic.id === "data.record-invalid-output"));
});

test("every field change reaches the internal consumer with its rule id and input path", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - id: move-title",
      "          op: rename",
      "          from: title",
      "          to: label",
      "        - id: price-number",
      "          op: cast",
      "          field: price",
      "          to: number",
      "        - id: fill-missing",
      "          op: default",
      "          field: missing",
      "          value: filled",
      "",
    ].join("\n"),
    "data/items.yml": "- slug: a\n  title: Alpha\n  price: \"2.5\"\n",
  });
  try {
    const events: TransformEvent[] = [];
    const result = await load(root, (event) => events.push(event));
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      events.map((event) => [event.rule, event.path, event.target]),
      [
        ["move-title", "title", "label"],
        ["price-number", "price", "price"],
        ["fill-missing", "missing", "missing"],
      ],
    );
    assert.equal(events[0]!.record, "a");
    assert.equal(events[0]!.from, "Alpha");
    assert.equal(events[0]!.to, "Alpha");
    assert.equal(events[1]!.from, "2.5");
    assert.equal(events[1]!.to, 2.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
