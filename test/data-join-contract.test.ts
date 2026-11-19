import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "join-contract-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CONFIG = [
  "collections:",
  "  catalog:",
  "    source: data/catalog.yml",
  "    id: sku",
  "    join:",
  "      type: left",
  "      key: [region, code]",
  "      fields:",
  "        title: name",
  "      sources:",
  "        - collection: inventory",
  "          key: [region, code]",
  "          fields:",
  "            stock: stock",
  "      onMissingKey: skip",
  "      onConflict: precedence",
  "      onNull: fallthrough",
  "      many: first",
  "  inventory:",
  "    source: data/inventory.yml",
  "    id: sku",
  "",
].join("\n");

test("a join contract parses its sources, keys, type, mappings, and policies", () => {
  const root = tree({ "mizzen.yml": CONFIG });
  try {
    const { config, diagnostics } = loadConfig(root);
    assert.deepEqual(diagnostics, []);
    const join = config.collections["catalog"]!.join!;
    assert.equal(join.type, "left");
    assert.deepEqual(join.key, ["region", "code"]);
    assert.deepEqual(join.fields, { title: "name" });
    assert.equal(join.sources.length, 1);
    assert.equal(join.sources[0]!.collection, "inventory");
    assert.deepEqual(join.sources[0]!.key, ["region", "code"]);
    assert.deepEqual(join.sources[0]!.fields, { stock: "stock" });
    assert.equal(join.onMissingKey, "skip");
    assert.equal(join.onConflict, "precedence");
    assert.equal(join.onNull, "fallthrough");
    assert.equal(join.many, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a join source the site does not declare is a config error", () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: missing",
      "",
    ].join("\n"),
  });
  try {
    const { diagnostics } = loadConfig(root);
    const finding = diagnostics.find((diagnostic) => diagnostic.id === "config.join-source");
    assert.ok(finding);
    assert.match(finding.message, /"missing"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source key of another length than the primary key is a config error", () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    join:",
      "      key: [region, code]",
      "      sources:",
      "        - collection: inventory",
      "          key: sku",
      "  inventory:",
      "    source: data/inventory.yml",
      "",
    ].join("\n"),
  });
  try {
    const { diagnostics } = loadConfig(root);
    const finding = diagnostics.find((diagnostic) => diagnostic.id === "config.join-key");
    assert.ok(finding);
    assert.match(finding.message, /2 key field\(s\) against 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cycle of joined collections is rejected in configuration", () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  first:",
      "    source: data/first.yml",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: second",
      "  second:",
      "    source: data/second.yml",
      "    join:",
      "      key: sku",
      "      sources:",
      "        - collection: first",
      "",
    ].join("\n"),
  });
  try {
    const { diagnostics } = loadConfig(root);
    const finding = diagnostics.find((diagnostic) => diagnostic.id === "config.join-cycle");
    assert.ok(finding);
    assert.match(finding.message, /first → second → first/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the schema rejects an empty source list and an unknown join type", () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  catalog:",
      "    source: data/catalog.yml",
      "    join:",
      "      type: outer",
      "      key: sku",
      "      sources: []",
      "",
    ].join("\n"),
  });
  try {
    const { diagnostics } = loadConfig(root);
    assert.ok(diagnostics.length > 0);
    assert.ok(diagnostics.every((diagnostic) => diagnostic.id.startsWith("config.")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
