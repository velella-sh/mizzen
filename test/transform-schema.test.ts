import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/transform/", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "transform-schema-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function load(root: string) {
  const { config, diagnostics: configDiagnostics } = loadConfig(root);
  const result = await loadCollections({ root, config });
  return { config, configDiagnostics, result };
}

test("a collection without transformation rules keeps its records as the source writes them", async () => {
  const fixture = await load(FIXTURE);
  assert.deepEqual(fixture.result.diagnostics, []);
  assert.deepEqual(fixture.result.collections["plain"]!.records.map((record) => ({ id: record.id, fields: record.fields })), [
    { id: "one", fields: { slug: "one", name: "One" } },
    { id: "two", fields: { slug: "two", name: "Two" } },
  ]);

  const root = tree({
    "mizzen.yml": "collections:\n  plain:\n    source: data/plain.yml\n    id: slug\n",
    "data/plain.yml": "- slug: one\n  name: One\n- slug: two\n  name: Two\n",
  });
  try {
    const untransformed = await load(root);
    assert.deepEqual(
      untransformed.result.collections["plain"]!.records,
      fixture.result.collections["plain"]!.records,
      "a collection without rules matches the same data with no transform key",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("steps run in order, each reading the record the previous step wrote", async () => {
  const { result } = await load(FIXTURE);
  const records = result.collections["items"]!.records;
  assert.deepEqual(
    records.map((record) => record.fields),
    [
      { slug: "beta", label: "SECOND", price: 250 },
      { slug: "alpha", label: "FIRST", price: 125 },
    ],
    "rename creates label, normalize reads it, cast makes price numeric, unit multiplies it",
  );
  assert.equal(records[0]!.fieldPositions["label"]?.startLine, 2, "a renamed field keeps the source position of its value");
});

test("an unknown operator is reported at its configuration path", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    transform:",
      "      steps:",
      "        - op: explode",
      "          field: name",
      "",
    ].join("\n"),
    "data/items.yml": "- id: a\n  name: Alpha\n",
  });
  try {
    const { configDiagnostics, result } = await load(root);
    const finding = configDiagnostics.find((diagnostic) => diagnostic.message.includes("collections.items.transform.steps.0.op"));
    assert.ok(finding, "the invalid operator names the configuration path");
    assert.equal(finding.severity, "error");
    assert.equal(finding.pos?.line, 6, "the finding points at the step");
    assert.equal(result.collections["items"]!.records.length, 1, "the data still loads while the config error fails the build");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("select keeps nested paths and remove drops them, leaving the rest of the record as it was", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  kept:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - op: select",
      "          fields: [slug, author.name]",
      "  removed:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - op: remove",
      "          fields: [author.email, note]",
      "",
    ].join("\n"),
    "data/items.yml": [
      "- slug: a",
      "  title: Alpha",
      "  note: keep me out",
      "  author:",
      "    name: Ada",
      "    email: ada@example.com",
      "",
    ].join("\n"),
  });
  try {
    const { result } = await load(root);
    assert.deepEqual(result.collections["kept"]!.records[0]!.fields, { slug: "a", author: { name: "Ada" } });
    assert.deepEqual(result.collections["removed"]!.records[0]!.fields, {
      slug: "a",
      title: "Alpha",
      author: { name: "Ada" },
    });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename moves a nested value and rejects or overwrites a collision by policy", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  rejected:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - id: move-name",
      "          op: rename",
      "          from: author.name",
      "          to: author.writer",
      "  overwritten:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - op: rename",
      "          from: author.name",
      "          to: author.writer",
      "          onConflict: overwrite",
      "",
    ].join("\n"),
    "data/items.yml": "- slug: a\n  author:\n    name: Ada\n    writer: Existing\n",
  });
  try {
    const { result } = await load(root);
    assert.deepEqual(result.collections["rejected"]!.records[0]!.fields, { slug: "a", author: { name: "Ada", writer: "Existing" } });
    const conflict = result.diagnostics.find((diagnostic) => diagnostic.id === "data.transform-rename-conflict");
    assert.ok(conflict);
    assert.match(conflict.message, /Step "move-name"/);
    assert.equal(conflict.pos?.line, 3, "the finding points at the nested source value");
    assert.deepEqual(result.collections["overwritten"]!.records[0]!.fields, { slug: "a", author: { writer: "Ada" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaults distinguish a missing field, null, and zero", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - id: fill-missing",
      "          op: default",
      "          field: missing",
      "          value: filled",
      "        - id: fill-null",
      "          op: default",
      "          field: nulled",
      "          value: filled",
      "          when: null",
      "        - id: fill-either",
      "          op: default",
      "          field: either",
      "          value: filled",
      "          when: missing-or-null",
      "        - id: fill-zero",
      "          op: default",
      "          field: zero",
      "          value: 9",
      "          when: missing-or-null",
      "",
    ].join("\n"),
    "data/items.yml": "- slug: a\n  nulled: null\n  either: null\n  zero: 0\n",
  });
  try {
    const { result } = await load(root);
    assert.deepEqual(result.collections["items"]!.records[0]!.fields, {
      slug: "a",
      missing: "filled",
      nulled: "filled",
      either: "filled",
      zero: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
