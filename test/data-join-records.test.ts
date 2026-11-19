import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import type { CollectionsResult } from "../src/data/collections.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "join-records-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function load(config: string, files: Record<string, string>): Promise<{ root: string; result: CollectionsResult }> {
  const root = tree({ "mizzen.yml": config, ...files });
  const parsed = loadConfig(root);
  const result = await loadCollections({ root, config: parsed.config });
  return { root, result: { ...result, diagnostics: [...parsed.diagnostics, ...result.diagnostics] } };
}

const CATALOG = [
  "- sku: a",
  "  name: Alpha",
  "  price: 10",
  "- sku: b",
  "  name: Beta",
  "  price: 20",
  "",
].join("\n");

test("inner join leaves out an unmatched primary record", async () => {
  const { root, result } = await load(
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: inventory",
      "          fields: {stock: stock}",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: sku",
      "",
    ].join("\n"),
    { "data/catalog.yml": CATALOG, "data/inventory.yml": "- sku: a\n  stock: 5\n" },
  );
  try {
    assert.deepEqual(result.collections["catalog"]!.records.map((record) => record.id), ["a"]);
    assert.equal(result.collections["catalog"]!.records[0]!.fields["stock"], 5);
    assert.deepEqual(result.diagnostics.filter((finding) => finding.severity === "error"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("left join keeps an unmatched primary record in the output shape", async () => {
  const { root, result } = await load(
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      type: left",
      "      key: sku",
      "      sources:",
      "        - collection: inventory",
      "          fields: {stock: stock}",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: sku",
      "",
    ].join("\n"),
    { "data/catalog.yml": CATALOG, "data/inventory.yml": "- sku: a\n  stock: 5\n" },
  );
  try {
    const records = result.collections["catalog"]!.records;
    assert.deepEqual(records.map((record) => record.id), ["a", "b"]);
    assert.deepEqual(records[1]!.fields, { sku: "b", name: "Beta", price: 20 });
    assert.equal(Object.hasOwn(records[1]!.fields, "stock"), false, "an unmatched field is absent, not null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composite keys match by type and never join two shorter keys into one", async () => {
  const { root, result } = await load(
    [
      "collections:",
      "  places:",
      "    source: data/places.yml",
      "    id: id",
      "    join:",
      "      key: [region, code]",
      "      sources:",
      "        - collection: stock",
      "          key: [region, code]",
      "          fields: {count: count}",
      "  stock:",
      "    source: data/stock.yml",
      "    id: id",
      "",
    ].join("\n"),
    {
      "data/places.yml": [
        "- id: number",
        "  region: north",
        "  code: 1",
        "- id: string",
        "  region: north",
        "  code: \"1\"",
        "- id: split",
        "  region: a",
        "  code: bc",
        "",
      ].join("\n"),
      "data/stock.yml": [
        "- id: five",
        "  region: north",
        "  code: 1",
        "  count: 5",
        "- id: seven",
        "  region: north",
        "  code: \"1\"",
        "  count: 7",
        "- id: nine",
        "  region: ab",
        "  code: c",
        "  count: 9",
        "",
      ].join("\n"),
    },
  );
  try {
    const counts = Object.fromEntries(
      result.collections["places"]!.records.map((record) => [record.id, record.fields["count"]]),
    );
    assert.deepEqual(counts, { number: 5, string: 7 });
    assert.equal(Object.hasOwn(counts, "split"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the missing-key policy skips with a warning or fails with an error", async () => {
  const config = (policy: string) =>
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: id",
      "    join:",
      "      type: left",
      `      onMissingKey: ${policy}`,
      "      key: sku",
      "      sources:",
      "        - collection: inventory",
      "          fields: {stock: stock}",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: id",
      "",
    ].join("\n");
  const files = {
    "data/catalog.yml": "- id: a\n  sku: a\n  name: Alpha\n- id: b\n  name: No key\n",
    "data/inventory.yml": "- id: a\n  sku: a\n  stock: 5\n- id: b\n  stock: 6\n",
  };

  const skipped = await load(config("skip"), files);
  try {
    assert.deepEqual(skipped.result.collections["catalog"]!.records.map((record) => record.id), ["a"]);
    const findings = skipped.result.diagnostics.filter((finding) => finding.id === "data.join-missing-key");
    assert.equal(findings.length, 2);
    assert.ok(findings.every((finding) => finding.severity === "warning"));
  } finally {
    rmSync(skipped.root, { recursive: true, force: true });
  }

  const failed = await load(config("error"), files);
  try {
    const findings = failed.result.diagnostics.filter((finding) => finding.id === "data.join-missing-key");
    assert.equal(findings.length, 2);
    assert.ok(findings.every((finding) => finding.severity === "error"));
  } finally {
    rmSync(failed.root, { recursive: true, force: true });
  }
});

test("more than one match reports a one-to-one violation or keeps a stable first, last, or list", async () => {
  const base = (many: string, extra = "") =>
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: inventory",
      `          many: ${many}`,
      extra,
      "          fields: {stock: stock}",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: row",
      "",
    ].join("\n");
  const inventory = [
    "- row: z",
    "  sku: a",
    "  stock: 9",
    "- row: a",
    "  sku: a",
    "  stock: 1",
    "- row: m",
    "  sku: a",
    "  stock: 5",
    "",
  ].join("\n");
  const files = { "data/catalog.yml": "- sku: a\n  name: Alpha\n", "data/inventory.yml": inventory };

  const erroneous = await load(base("error"), files);
  try {
    const record = erroneous.result.collections["catalog"]!.records[0]!;
    assert.equal(record.fields["stock"], 1, "the first match by id keeps the build deterministic");
    const finding = erroneous.result.diagnostics.find((entry) => entry.id === "data.join-many");
    assert.ok(finding);
    assert.match(finding.message, /matches 3 records/);
  } finally {
    rmSync(erroneous.root, { recursive: true, force: true });
  }

  const first = await load(base("first"), files);
  try {
    assert.equal(first.result.collections["catalog"]!.records[0]!.fields["stock"], 1);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }

  const last = await load(base("last"), files);
  try {
    assert.equal(last.result.collections["catalog"]!.records[0]!.fields["stock"], 9);
  } finally {
    rmSync(last.root, { recursive: true, force: true });
  }

  const listed = await load(base("list", "          manyField: lots"), files);
  try {
    const lots = listed.result.collections["catalog"]!.records[0]!.fields["lots"] as readonly { id: string; stock: number }[];
    assert.deepEqual(lots.map((entry) => entry.id), ["a", "m", "z"]);
    assert.deepEqual(lots.map((entry) => entry.stock), [1, 5, 9]);
  } finally {
    rmSync(listed.root, { recursive: true, force: true });
  }
});

test("source precedence resolves a conflict, and an unresolved one names the record key, field, and both inputs", async () => {
  const config = (onConflict: string) =>
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      `      onConflict: ${onConflict}`,
      "      sources:",
      "        - collection: inventory",
      "          fields:",
      "            title: label",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: sku",
      "",
    ].join("\n");
  const files = {
    "data/catalog.yml": "- sku: a\n  title: Alpha\n",
    "data/inventory.yml": "- sku: a\n  label: Other\n",
  };

  const resolved = await load(config("precedence"), files);
  try {
    assert.equal(resolved.result.collections["catalog"]!.records[0]!.fields["title"], "Alpha");
  } finally {
    rmSync(resolved.root, { recursive: true, force: true });
  }

  const unresolved = await load(config("error"), files);
  try {
    const finding = unresolved.result.diagnostics.find((entry) => entry.id === "data.join-conflict");
    assert.ok(finding);
    assert.match(finding.message, /Record "a"/);
    assert.match(finding.message, /sku="a"/);
    assert.match(finding.message, /"title"/);
    assert.match(finding.message, /catalog\.title/);
    assert.match(finding.message, /inventory\.label/);
  } finally {
    rmSync(unresolved.root, { recursive: true, force: true });
  }
});

test("a null is kept as a value or falls through to the next source, and absent stays absent", async () => {
  const config = (onNull: string) =>
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      `      onNull: ${onNull}`,
      "      fields:",
      "        note: note",
      "        title: title",
      "      sources:",
      "        - collection: inventory",
      "          fields:",
      "            note: note",
      "            title: label",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: sku",
      "",
    ].join("\n");
  const files = {
    "data/catalog.yml": "- sku: a\n  title: Alpha\n  note: null\n- sku: b\n  title: Beta\n",
    "data/inventory.yml": "- sku: a\n  label: Other\n  note: from inventory\n- sku: b\n  label: Other B\n  note: also inventory\n",
  };

  const kept = await load(config("keep"), files);
  try {
    const records = kept.result.collections["catalog"]!.records;
    assert.equal(records[0]!.fields["note"], null, "a null primary value wins over a secondary value");
    assert.equal(records[1]!.fields["note"], "also inventory", "an absent primary value lets the source supply one");
  } finally {
    rmSync(kept.root, { recursive: true, force: true });
  }

  const fallen = await load(config("fallthrough"), files);
  try {
    const records = fallen.result.collections["catalog"]!.records;
    assert.equal(records[0]!.fields["note"], "from inventory");
  } finally {
    rmSync(fallen.root, { recursive: true, force: true });
  }
});

test("a joined record records the selected source and every contributing input", async () => {
  const { root, result } = await load(
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      "      fields: {title: title}",
      "      sources:",
      "        - collection: inventory",
      "          fields:",
      "            title: label",
      "            stock: stock",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: sku",
      "",
    ].join("\n"),
    {
      "data/catalog.yml": "- sku: a\n  title: Alpha\n",
      "data/inventory.yml": "- sku: a\n  label: Other\n  stock: 5\n",
    },
  );
  try {
    const record = result.collections["catalog"]!.records[0]!;
    assert.deepEqual(record.joined?.key, { sku: "a" });
    const title = record.joined?.fields["title"];
    assert.deepEqual(title, {
      field: "title",
      source: "catalog",
      input: "title",
      inputs: ["catalog.title", "inventory.label"],
      reason: "precedence",
    });
    const stock = record.joined?.fields["stock"];
    assert.equal(stock?.source, "inventory");
    assert.equal(stock?.reason, "only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a secondary source reorder preserves ids, field values, and nested order", async () => {
  const config = [
    "collections:",
    "  catalog:",
    "    source: data/catalog.yml",
    "    id: sku",
    "    join:",
    "      type: left",
    "      key: sku",
    "      sources:",
    "        - collection: inventory",
    "          many: list",
    "          manyField: lots",
    "          fields: {stock: stock}",
    "  inventory:",
    "    source: data/inventory.yml",
    "    id: row",
    "",
  ].join("\n");
  const catalog = "- sku: b\n  name: Beta\n- sku: a\n  name: Alpha\n";
  const forward = [
    "- row: z",
    "  sku: a",
    "  stock: 9",
    "- row: a",
    "  sku: a",
    "  stock: 1",
    "",
  ].join("\n");
  const reversed = ["- row: a", "  sku: a", "  stock: 1", "- row: z", "  sku: a", "  stock: 9", ""].join("\n");

  const one = await load(config, { "data/catalog.yml": catalog, "data/inventory.yml": forward });
  const two = await load(config, { "data/catalog.yml": catalog, "data/inventory.yml": reversed });
  try {
    const first = one.result.collections["catalog"]!.records;
    const second = two.result.collections["catalog"]!.records;
    assert.deepEqual(first.map((record) => record.id), ["b", "a"]);
    const shape = (records: readonly { id: string; fields: unknown; joined?: unknown }[]) =>
      records.map((record) => ({ id: record.id, fields: record.fields, joined: record.joined }));
    assert.deepEqual(shape(first), shape(second), "the secondary row order changes no id, value, or nested order");
  } finally {
    rmSync(one.root, { recursive: true, force: true });
    rmSync(two.root, { recursive: true, force: true });
  }
});

test("a three-source chain runs two join steps and keeps the primary id and order", async () => {
  const { root, result } = await load(
    [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: enriched",
      "          fields: {title: title, stock: stock}",
      "  enriched:",
      "    source: data/enriched.yml",
      "    id: sku",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: inventory",
      "          fields: {stock: stock}",
      "  inventory:",
      "    source: data/inventory.yml",
      "    id: sku",
      "",
    ].join("\n"),
    {
      "data/catalog.yml": "- sku: a\n  name: Alpha\n- sku: b\n  name: Beta\n",
      "data/enriched.yml": "- sku: a\n  title: Enriched A\n- sku: b\n  title: Enriched B\n",
      "data/inventory.yml": "- sku: a\n  stock: 4\n- sku: b\n  stock: 7\n",
    },
  );
  try {
    const records = result.collections["catalog"]!.records;
    assert.deepEqual(records.map((record) => record.id), ["a", "b"]);
    assert.deepEqual(records.map((record) => [record.fields["title"], record.fields["stock"]]), [
      ["Enriched A", 4],
      ["Enriched B", 7],
    ]);
    assert.equal(records[0]!.joined?.fields["stock"]?.source, "enriched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
