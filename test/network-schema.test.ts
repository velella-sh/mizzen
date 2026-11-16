import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const read = (name: string): object => JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8"));

const sample = {
  version: 1,
  projects: [
    { id: "alpha", path: "alpha", title: "Alpha", public: true },
    { id: "beta", path: "beta", title: "Beta", public: false, analytics: { provider: "goatcounter", site: "example" }, search: "find" },
  ],
};

test("a sample network file validates against the schema", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(read("network.schema.json"));
  assert.equal(validate(sample), true, JSON.stringify(validate.errors));
});

test("the schema rejects an unknown key, a bad id, and a missing flag", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(read("network.schema.json"));
  assert.equal(validate({ ...sample, extra: 1 }), false);
  assert.equal(validate({ version: 1, projects: [{ id: "Bad Id", path: "x", title: "X", public: true }] }), false);
  assert.equal(validate({ version: 1, projects: [{ id: "x", path: "x", title: "X" }] }), false);
});

test("the lock schema compiles and accepts a minimal lock", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(read("network-lock.schema.json"));
  const hash = "a".repeat(64);
  assert.equal(
    validate({ version: 1, source: "https://example.org/network.json", sha256: hash, projects: [{ id: "alpha", path: "alpha", title: "Alpha", public: false }] }),
    true,
    JSON.stringify(validate.errors),
  );
});

test("the ADR names every key of the schema", () => {
  const adr = readFileSync(new URL("../docs/adr/network.md", import.meta.url), "utf8");
  const schema = read("network.schema.json") as { $defs: { project: { properties: Record<string, unknown> } } };
  for (const key of Object.keys(schema.$defs.project.properties)) assert.ok(adr.includes(`\`${key}\``), key);
});
