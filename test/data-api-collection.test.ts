import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/outputs/api.ts";
import { context, site } from "./data-api-site.ts";

async function files(model = site()): Promise<Map<string, string>> {
  return new Map((await api.run(model, context())).map((file) => [file.path, String(file.contents)]));
}

test("the collection file lists every published record ordered by id", async () => {
  const out = await files();
  const text = out.get("api/v1/packages.json")!;
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), {
    collection: "packages",
    count: 2,
    records: [
      { id: "a", name: "a", eol: "2030-01-01" },
      { id: "b", name: "b", eol: "2030-01-01" },
    ],
  });
});

test("the NDJSON file has one record per line in the same order", async () => {
  const text = (await files()).get("api/v1/packages.ndjson")!;
  assert.ok(text.endsWith("\n"));
  const lines = text.slice(0, -1).split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { id: "a", name: "a", eol: "2030-01-01" },
    { id: "b", name: "b", eol: "2030-01-01" },
  ]);
  assert.ok(!text.includes("secret"));
});

test("a field the config does not list is never published, and a listed field keeps its listed order", async () => {
  const out = await files(site({ api: { version: "v1", collections: { packages: { fields: ["eol", "name"], id: "key" } } } }));
  const body = JSON.parse(out.get("api/v1/packages.json")!) as { records: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(body.records[0]!), ["key", "eol", "name"]);
  assert.ok(![...out.values()].some((text) => text.includes("secret")));
});

test("ids order by code point, not by locale or source order", async () => {
  const model = site();
  const records = ["b", "B", "a", "10", "9"].map((id) => ({ ...model.collections.packages!.records[0]!, id, fields: { name: id } }));
  const sorted = { ...model, collections: { ...model.collections, packages: { ...model.collections.packages!, records } } };
  const body = JSON.parse((await files(sorted)).get("api/v1/packages.json")!) as { records: { id: string }[] };
  assert.deepEqual(body.records.map((r) => r.id), ["10", "9", "B", "a", "b"]);
});

test("a collection with no records writes an empty file and an empty NDJSON file", async () => {
  const model = site();
  const empty = { ...model, collections: { ...model.collections, packages: { ...model.collections.packages!, records: [] } } };
  const out = await files(empty);
  assert.equal(out.get("api/v1/packages.ndjson"), "");
  assert.deepEqual(JSON.parse(out.get("api/v1/packages.json")!), { collection: "packages", count: 0, records: [] });
});
