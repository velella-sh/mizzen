import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfig } from "../src/config/load.ts";

const ROOT = fileURLToPath(new URL("../fixtures/data-site/", import.meta.url));

interface FixtureRecord {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function components(): FixtureRecord[] {
  const list = parse(readFileSync(join(ROOT, "_data/components.yml"), "utf8")) as Array<Record<string, unknown>>;
  return list.map((fields) => ({ id: String(fields["slug"]), fields }));
}

/** The JSON source is an object keyed by id. */
function releases(): FixtureRecord[] {
  const map = JSON.parse(readFileSync(join(ROOT, "_data/releases.json"), "utf8")) as Record<string, Record<string, unknown>>;
  return Object.entries(map).map(([id, fields]) => ({ id, fields }));
}

/**
 * The CSV source has a header and one line per row.
 * shortcut: the fixture's cells hold no embedded newlines or escaped quotes, so one line is one record and a
 * quoted comma only splits the last cell; a test that needs more parses them with the CSV reader instead.
 */
function regions(): FixtureRecord[] {
  const [header, ...rows] = readFileSync(join(ROOT, "_data/regions.csv"), "utf8").trimEnd().split("\n");
  assert.equal(header, "id,name,code,note", "the header names the columns");
  return rows.map((row) => {
    const cells = row.split(",");
    return { id: cells[0]!, fields: { name: cells[1], code: cells[2], note: cells.slice(3).join(",") } };
  });
}

test("the fixture loads with the config loader and names its three collections", () => {
  const { config, diagnostics } = loadConfig(ROOT);
  assert.deepEqual(diagnostics, []);
  assert.equal(config.title, "Sample catalogue");
  assert.deepEqual(config.collections["components"], { source: "_data/components.yml", id: "slug" });
  assert.deepEqual(config.collections["releases"], { source: "_data/releases.json" });
  assert.deepEqual(config.collections["regions"], { source: "_data/regions.csv" });
});

test("the fixture holds thirty records with unique ids and resolvable references", () => {
  const parts = components();
  const versions = releases();
  const areas = regions();
  assert.deepEqual([parts.length, versions.length, areas.length], [12, 10, 8]);

  for (const [name, records] of [["components", parts], ["releases", versions], ["regions", areas]] as const) {
    const ids = records.map((record) => record.id);
    assert.equal(new Set(ids).size, ids.length, `${name} ids are unique`);
  }

  const regionIds = new Set(areas.map((record) => record.id));
  const slugs = new Set(parts.map((record) => record.id));
  for (const record of parts) assert.ok(regionIds.has(String(record.fields["region"])), `${record.id} names a region`);
  for (const record of versions) assert.ok(slugs.has(String(record.fields["component"])), `${record.id} names a component`);
});

test("a record carries a date, a status, and a Markdown field", () => {
  for (const record of components()) {
    assert.match(String(record.fields["released"]), /^\d{4}-\d{2}-\d{2}$/, `${record.id} has a date`);
    assert.ok(["stable", "beta", "deprecated"].includes(String(record.fields["status"])), `${record.id} has a status`);
  }
  const button = components().find((record) => record.id === "button")!;
  assert.match(String(button.fields["summary"]), /\*\*button\*\*/, "the Markdown field holds Markdown");
});
