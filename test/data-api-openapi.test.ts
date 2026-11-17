import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic } from "../src/contracts/index.ts";
import { api } from "../src/outputs/api.ts";
import { site } from "./data-api-site.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
// The OpenAPI Initiative's published OpenAPI 3.1 document schema (2022-10-07), the validator for this test.
// Its `$dynamicRef` to the Schema Object anchor is resolved statically, because Ajv does not implement dynamic scope for it.
const oas = JSON.parse(
  readFileSync(new URL("./fixtures/openapi-3.1.schema.json", import.meta.url), "utf8").replace(/"\$dynamicRef":\s*"#meta"/g, '"$ref": "#/$defs/schema"'),
) as object;
const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(oas);

const SCHEMA = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" }, eol: { $ref: "#/$defs/date" } },
  $defs: { date: { type: "string", format: "date" } },
};

async function build(withSchema: boolean): Promise<Map<string, string>> {
  const root = mkdtempSync(join(tmpdir(), "api-openapi-"));
  try {
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas/packages.json"), JSON.stringify(SCHEMA));
    const model = site();
    const config = withSchema
      ? { ...model.config, collections: { ...model.config.collections, packages: { source: "_data/packages.yml", schema: "schemas/packages.json" } } }
      : model.config;
    const reports: Diagnostic[] = [];
    const files = await api.run({ ...model, config }, { renderPage: () => Promise.reject(new Error("x")), build: { root, workers: 1 }, report: (d) => void reports.push(d) });
    assert.deepEqual(reports, []);
    return new Map(files.map((f) => [f.path, String(f.contents)]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const withSchema of [true, false]) {
  test(`the validator accepts the file and every path exists in the output (schema: ${withSchema})`, async () => {
    const out = await build(withSchema);
    const doc = JSON.parse(out.get("api/v1/openapi.json")!) as { openapi: string; paths: Record<string, unknown> };
    assert.equal(validate(doc), true, JSON.stringify(validate.errors?.slice(0, 3)));
    assert.equal(doc.openapi, "3.1.0");
    const ids = (JSON.parse(out.get("api/v1/packages.json")!) as { records: { id: string }[] }).records.map((r) => r.id);
    for (const path of Object.keys(doc.paths)) {
      const file = path.slice(1);
      const expanded = file.includes("{id}") ? ids.map((id) => file.replace("{id}", id)) : [file];
      for (const candidate of expanded) assert.ok(out.has(candidate), `${candidate} is written`);
    }
    // The other direction: every collection, record, and schema file the build writes is described.
    const described = new Set(Object.keys(doc.paths).flatMap((p) => (p.includes("{id}") ? ids.map((id) => p.replace("{id}", id)) : [p])).map((p) => p.slice(1)));
    for (const path of out.keys()) if (path !== "api/v1/openapi.json") assert.ok(described.has(path), `${path} is described`);
  });
}

test("a published schema is the response schema, and its refs stay resolvable", async () => {
  const out = await build(true);
  const doc = JSON.parse(out.get("api/v1/openapi.json")!) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> }; paths: Record<string, unknown> };
  assert.deepEqual(Object.keys(doc.components.schemas.PackagesRecord!.properties), ["id", "name", "eol"]);
  const record = JSON.stringify(doc.paths["/api/v1/packages/{id}.json"]);
  assert.match(record, /https:\/\/example\.test\/docs\/api\/v1\/schemas\/packages\.json#\/\$defs\/date/);
  assert.ok(Object.hasOwn(doc.paths, "/api/v1/schemas/packages.json"));
});

test("a collection without a schema describes no schema path", async () => {
  const doc = JSON.parse((await build(false)).get("api/v1/openapi.json")!) as { paths: Record<string, unknown> };
  assert.ok(!Object.hasOwn(doc.paths, "/api/v1/schemas/packages.json"));
});

test("the validator rejects a document that is not OpenAPI", () => {
  assert.equal(validate({ openapi: "3.1.0", info: { title: "x" }, paths: {} }), false);
  assert.equal(validate({ openapi: "2.0", info: { title: "x", version: "1" }, paths: {} }), false);
});
