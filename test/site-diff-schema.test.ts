import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";

const schema = JSON.parse(readFileSync(new URL("../schema/site-diff.schema.json", import.meta.url), "utf8")) as object;
// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** The first JSON code block of the documentation page: its example report. */
function documentedExample(): unknown {
  const text = readFileSync(new URL("../site/site-diff.md", import.meta.url), "utf8");
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  assert.ok(match, "site/site-diff.md has a JSON example");
  return JSON.parse(match[1]!);
}

test("the example in the documentation validates against the schema", () => {
  assert.equal(validate(documentedExample()), true, JSON.stringify(validate.errors));
});

test("a report without its build hashes does not validate", () => {
  const example = documentedExample() as Record<string, unknown>;
  const { head: _head, ...rest } = example;
  assert.equal(validate(rest), false);
});

test("a reader may meet a field it does not know: the format only gains fields", () => {
  const example = documentedExample() as Record<string, unknown>;
  assert.equal(validate({ ...example, later: { anything: true } }), true);
});
