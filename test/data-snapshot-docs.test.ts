import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const doc = readFileSync(new URL("../site/data/snapshots.md", import.meta.url), "utf8");
const lock = read("../schema/data-lock.schema.json");
const config = read("../schema/config.schema.json");

test("the docs name every snapshot field of the lock schema, and no field it lacks", () => {
  const fields = Object.keys(lock.$defs.snapshot.properties);
  for (const key of fields) assert.ok(doc.includes(`| \`${key}\` |`), `snapshot.${key}`);
  const table = doc.split("## What is recorded")[1]!.split("\n## ")[0]!;
  for (const m of table.matchAll(/^\| `([A-Za-z]+)` \|/gm)) assert.ok(fields.includes(m[1]!), `undocumented in schema: ${m[1]}`);
});

test("the docs name the config keys the schema has", () => {
  for (const key of Object.keys(config.properties.snapshot.properties)) assert.ok(doc.includes(`${key}`), key);
  assert.ok(config.properties.snapshot);
  assert.ok(doc.includes("private") && doc.includes("raw: false"));
});

test("the docs list the commands and the output files", () => {
  for (const command of ["data snapshot", "data fetch", "data verify"]) assert.ok(doc.includes(`mizzen ${command}`), command);
  for (const file of [".raw.json", ".csv", ".sha256"]) assert.ok(doc.includes(file), file);
  assert.ok(doc.includes(":snapshot[capturedAt]"));
});
