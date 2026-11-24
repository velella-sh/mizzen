import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { canonicalJson, sha256 } from "../src/data/lock.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const guide = readFileSync(new URL("../docs/upgrade-0.2.7.md", import.meta.url), "utf8");
const examples = [...guide.matchAll(/<!-- schema: ([a-z-]+) -->\n```json\n([\s\S]*?)\n```/g)];

test("every example in the 0.2.7 upgrade guide validates against its published schema", () => {
  assert.deepEqual(examples.map((match) => match[1]), ["evidence-envelope", "evidence-lock"]);
  for (const [, name, body] of examples) {
    const schema = JSON.parse(readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), "utf8")) as object;
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const value = JSON.parse(body!) as { payload?: unknown; payloadSha256?: string };
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
    if (name === "evidence-envelope") assert.equal(value.payloadSha256, sha256(canonicalJson(value.payload)));
  }
});

test("the 0.2.7 upgrade guide names every contract schema and the site page links to it", () => {
  for (const name of [
    "surface-report", "behavior-report", "evidence-envelope", "evidence-lock", "evidence-report", "decision-report",
    "federation-lock", "knowledge-bundle", "propagation-manifest", "propagation-ledger", "site-attestation",
  ]) {
    assert.ok(existsSync(new URL(`../schema/${name}.schema.json`, import.meta.url)), `${name} schema is missing`);
    assert.ok(guide.includes(`${name}`), `the guide does not cover ${name}`);
  }
  assert.match(readFileSync(new URL("../site/upgrade.md", import.meta.url), "utf8"), /docs\/upgrade-0\.2\.7\.md/);
});
