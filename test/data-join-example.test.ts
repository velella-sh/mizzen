import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { build } from "../src/pipeline/build.ts";

const ROOT = fileURLToPath(new URL("../examples/data-join/", import.meta.url));
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

test("the two-local-file catalog joins inventory and keeps the catalog title on a conflict", async () => {
  const { config, diagnostics } = loadConfig(ROOT);
  assert.deepEqual(diagnostics, []);
  const loaded = await loadCollections({ root: ROOT, config });
  assert.deepEqual(loaded.diagnostics, []);
  const records = loaded.collections["catalog"]!.records;
  assert.deepEqual(records.map((record) => record.id), ["field-lamp", "desk-mat", "pack-bag"]);
  assert.equal(records[0]!.fields["title"], "Field Lamp", "precedence keeps the catalog name, not the warehouse label");
  assert.equal(records[0]!.fields["stock"], 4);
  assert.equal(Object.hasOwn(records[2]!.fields, "stock"), false, "the unmatched primary record stays with a left join");
  assert.equal(loaded.collections["inventory"]!.records.length, 3, "an unmatched secondary row is not added");
});

test("the example builds with no error and writes its joined records", async () => {
  const out = mkdtempSync(join(tmpdir(), "join-example-out-"));
  try {
    const result = await build({ root: ROOT, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    for (const file of ["catalog/field-lamp/index.html", "data/catalog.raw.json"]) {
      assert.ok(result.files.includes(file), `the build writes ${file}`);
    }
    const raw = JSON.parse(readFileSync(join(out, "data/catalog.raw.json"), "utf8")) as {
      records: { id: string; fields: { title: string; stock?: number } }[];
    };
    const lamp = raw.records.find((record) => record.id === "field-lamp")!;
    assert.equal(lamp.fields.title, "Field Lamp");
    assert.equal(lamp.fields.stock, 4);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("switching the example to onConflict: error shows the sample conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "join-example-conflict-"));
  try {
    cpSync(ROOT, root, { recursive: true });
    const file = join(root, "mizzen.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace("onConflict: precedence", "onConflict: error"));
    const { config, diagnostics } = loadConfig(root);
    assert.deepEqual(diagnostics, []);
    const loaded = await loadCollections({ root, config });
    const finding = loaded.diagnostics.find((entry) => entry.id === "data.join-conflict");
    assert.ok(finding, "the sample conflict is reported when precedence is not chosen");
    assert.match(finding.message, /field-lamp/);
    assert.match(finding.message, /sku="field-lamp"/);
    assert.match(finding.message, /catalog\.name/);
    assert.match(finding.message, /inventory\.label/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
