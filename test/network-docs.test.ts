import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const doc = readFileSync(new URL("../site/network.md", import.meta.url), "utf8");
const config = read("../schema/config.schema.json").properties.network;
const file = read("../schema/network.schema.json");

test("the docs name every key of the shared file and of the config's network key", () => {
  for (const key of Object.keys(file.properties)) assert.ok(doc.includes(`\`${key}\``), `network file: ${key}`);
  for (const key of Object.keys(file.$defs.project.properties)) assert.ok(doc.includes(`\`${key}\``), `project.${key}`);
  for (const key of Object.keys(config.properties)) assert.ok(doc.includes(`\`${key}\``), `network.${key}`);
});

test("the docs describe no key the schemas lack", () => {
  const known = new Set([
    ...Object.keys(file.properties), ...Object.keys(file.$defs.project.properties), ...Object.keys(config.properties),
    "network", "base", "analytics", "scope", "public",
  ]);
  const table = (heading: string) => doc.split(`## ${heading}`)[1]!.split("\n## ")[0]!;
  for (const section of ["The shared file", "The site config"]) {
    for (const m of table(section).matchAll(/^\| `([A-Za-z]+)` \|/gm)) assert.ok(known.has(m[1]!), `${section}: ${m[1]}`);
  }
});

test("the docs list every network subcommand", () => {
  for (const command of ["check", "update", "sitemap"]) assert.ok(doc.includes(`mizzen network ${command}`), command);
  assert.ok(doc.includes("--accept") && doc.includes("--check"));
});
