import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { buildModel } from "../src/model/build.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/data-site/", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-collections-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the fixture loads all three collections in source order with their ids", async () => {
  const { config } = loadConfig(FIXTURE);
  const result = await loadCollections({ root: FIXTURE, config });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.keys(result.collections), ["components", "releases", "regions"]);

  const components = result.collections["components"]!;
  assert.equal(components.source, "_data/components.yml");
  assert.equal(components.records.length, 12);
  assert.equal(components.records[0]!.id, "button");
  assert.equal(components.records[0]!.fields["name"], "Button");
  assert.equal(components.records[0]!.position.file, "_data/components.yml");

  const releases = result.collections["releases"]!;
  assert.equal(releases.records.length, 10);
  assert.equal(releases.records[0]!.id, "4.0.0", "the mapping key is the id");

  const regions = result.collections["regions"]!;
  assert.equal(regions.records.length, 8);
  assert.equal(regions.records[0]!.id, "north", "the id column is the id");
  assert.equal(regions.records[5]!.fields["note"], "Harbours, and one island");
});

test("a list record without the configured id field is one error at its line, and the others still load", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    id: slug\n",
    "_data/items.yml": "- name: first\n- slug: second\n  name: second\n",
  });
  try {
    const { config } = loadConfig(root);
    const result = await loadCollections({ root, config });
    const missing = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-missing-id");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.pos?.file, "_data/items.yml");
    assert.equal(missing[0]!.pos?.line, 1);
    assert.deepEqual(result.collections["items"]!.records.map((record) => record.id), ["second"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing source and a source that is not records are diagnostics, not throws", async () => {
  const root = tree({
    "mizzen.yml":
      "collections:\n  gone:\n    source: _data/gone.yml\n  scalar:\n    source: _data/scalar.yml\n",
    "_data/scalar.yml": "just a string\n",
  });
  try {
    const { config } = loadConfig(root);
    const result = await loadCollections({ root, config });
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.id).sort(),
      ["data.collection-shape", "data.source-missing"],
    );
    assert.deepEqual(result.collections, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the model adds collections without changing what Site.data holds", async () => {
  const { site, diagnostics } = await buildModel(FIXTURE);
  assert.deepEqual(diagnostics, []);
  assert.equal(site.collections["components"]!.records.length, 12);
  assert.ok(Array.isArray(site.data["components"]), "Site.data still holds the loaded file");
  assert.deepEqual(Object.keys(site.data["components"] as object).length, 12);
});
