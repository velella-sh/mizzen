import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfigText } from "../src/config/load.ts";

const COLLECTIONS = "collections:\n  packages:\n    source: _data/packages.yml\n  tools:\n    source: _data/tools.yml\n";

test("a site without the api key has no api config", () => {
  const { config, diagnostics } = loadConfigText(COLLECTIONS, "mizzen.yml", "site");
  assert.deepEqual(diagnostics, []);
  assert.equal("api" in config, false);
});

test("a valid api key keeps its collections, and the version defaults to v1", () => {
  const text = `${COLLECTIONS}api:\n  collections:\n    packages:\n      fields: [name, eol]\n      id: key\n`;
  const { config, diagnostics } = loadConfigText(text, "mizzen.yml", "site");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(config.api, { version: "v1", collections: { packages: { fields: ["name", "eol"], id: "key" } } });
});

test("an explicit version is kept", () => {
  const text = `${COLLECTIONS}api:\n  version: v2\n  collections:\n    tools:\n      fields: [name]\n`;
  const { config, diagnostics } = loadConfigText(text, "mizzen.yml", "site");
  assert.deepEqual(diagnostics, []);
  assert.equal(config.api?.version, "v2");
});

test("an api collection the site does not declare is an error at its name", () => {
  const text = `${COLLECTIONS}api:\n  collections:\n    ghosts:\n      fields: [name]\n`;
  const { diagnostics } = loadConfigText(text, "mizzen.yml", "site");
  const found = diagnostics.filter((d) => d.id === "config.api-collection");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "error");
  assert.equal(found[0]!.pos?.line, 8);
  assert.match(found[0]!.message, /ghosts/);
});

test("each shape error is reported", () => {
  const bad: Array<[string, string]> = [
    ["no collections", "api: {}\n"],
    ["a collection without fields", `${COLLECTIONS}api:\n  collections:\n    packages: {}\n`],
    ["an empty field list", `${COLLECTIONS}api:\n  collections:\n    packages:\n      fields: []\n`],
    ["a repeated field", `${COLLECTIONS}api:\n  collections:\n    packages:\n      fields: [a, a]\n`],
    ["a bad version", `${COLLECTIONS}api:\n  version: one\n  collections:\n    packages:\n      fields: [a]\n`],
    ["an unknown key", `${COLLECTIONS}api:\n  collections:\n    packages:\n      fields: [a]\n      hidden: [b]\n`],
  ];
  for (const [name, text] of bad) {
    const { diagnostics } = loadConfigText(text, "mizzen.yml", "site");
    assert.ok(diagnostics.some((d) => d.severity === "error"), name);
  }
});
