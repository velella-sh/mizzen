import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { api } from "../src/outputs/api.ts";
import { site } from "./data-api-site.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;

const SOURCE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Package",
  type: "object",
  required: ["name", "secret"],
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    eol: { type: "string", format: "date" },
    secret: { type: "string" },
  },
};

function withSchema<T>(schema: unknown, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "api-schema-"));
  mkdirSync(join(root, "schemas"));
  writeFileSync(join(root, "schemas/packages.json"), JSON.stringify(schema));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function model(overrides: Partial<SiteConfig> = {}) {
  const base = site();
  return {
    ...base,
    config: {
      ...base.config,
      collections: { ...base.config.collections, packages: { source: "_data/packages.yml", schema: "schemas/packages.json" } },
      ...overrides,
    },
  };
}

function ctx(root: string, reports: Diagnostic[] = []): OutputContext {
  return { renderPage: () => Promise.reject(new Error("no page")), build: { root, workers: 1 }, report: (d) => void reports.push(d) };
}

test("the schema is limited to the published fields and carries its published address", () =>
  withSchema(SOURCE_SCHEMA, async (root) => {
    const files = new Map((await api.run(model(), ctx(root))).map((f) => [f.path, String(f.contents)]));
    const published = JSON.parse(files.get("api/v1/schemas/packages.json")!) as Record<string, unknown>;
    assert.equal(published.$id, "https://example.test/docs/api/v1/schemas/packages.json");
    assert.deepEqual(Object.keys(published.properties as object), ["id", "name", "eol"]);
    assert.deepEqual(published.required, ["id", "name"]);
    assert.ok(!files.get("api/v1/schemas/packages.json")!.includes("secret"));
    const index = JSON.parse(files.get("api/v1/index.json")!) as { collections: { name: string; schema: string | null }[] };
    assert.equal(index.collections[0]!.schema, "/docs/api/v1/schemas/packages.json");
  }));

test("every published record validates against the published schema", () =>
  withSchema(SOURCE_SCHEMA, async (root) => {
    const files = new Map((await api.run(model(), ctx(root))).map((f) => [f.path, String(f.contents)]));
    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(files.get("api/v1/schemas/packages.json")!));
    const records = (JSON.parse(files.get("api/v1/packages.json")!) as { records: unknown[] }).records;
    assert.equal(records.length, 2);
    for (const record of records) assert.equal(validate(record), true, JSON.stringify(validate.errors));
    assert.equal(validate({ id: "x" }), false);
  }));

test("a published field the schema does not describe is an error", () =>
  withSchema({ type: "object", properties: { name: { type: "string" } } }, async (root) => {
    const reports: Diagnostic[] = [];
    await api.run(model(), ctx(root, reports));
    assert.deepEqual(reports.map((d) => d.id), ["api.field-not-in-schema"]);
    assert.equal(reports[0]!.severity, "error");
    assert.match(reports[0]!.message, /"eol"/);
  }));

test("a collection without a schema publishes none and the index says null", async () => {
  const files = new Map((await api.run(site(), { renderPage: () => Promise.reject(new Error("x")), build: { root: tmpdir(), workers: 1 }, report: () => {} })).map((f) => [f.path, String(f.contents)]));
  assert.ok(![...files.keys()].some((path) => path.startsWith("api/v1/schemas/")));
  assert.equal((JSON.parse(files.get("api/v1/index.json")!) as { collections: { schema: unknown }[] }).collections[0]!.schema, null);
});
