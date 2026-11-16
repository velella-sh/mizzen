import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, SiteConfig } from "../src/contracts/index.ts";
import { context, site } from "./data-api-site.ts";
import { api } from "../src/outputs/api.ts";
import { llms } from "../src/outputs/llms.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/api-index.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

test("the index validates against its schema and holds no records", async () => {
  const files = await api.run(site(), context());
  assert.deepEqual(files.map((f) => f.path), ["api/v1/index.json", "api/v1/packages.json", "api/v1/packages.ndjson", "api/v1/packages/a.json", "api/v1/packages/b.json"]);
  const text = String(files[0]!.contents);
  assert.ok(text.endsWith("\n"));
  const body = JSON.parse(text) as unknown;
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.deepEqual(body, {
    version: "v1",
    collections: [
      {
        name: "packages",
        count: 2,
        fields: ["name", "eol"],
        json: "/docs/api/v1/packages.json",
        ndjson: "/docs/api/v1/packages.ndjson",
        record: "/docs/api/v1/packages/{id}.json",
        schema: null,
        snapshot: { source: "_data/packages.yml", ref: "abc123", capturedAt: "2026-11-01", tool: "git" },
      },
    ],
  });
});

test("only a collection the config names is published, and its snapshot is null when it has none", async () => {
  const model = site({ api: { version: "v1", collections: { tools: { fields: ["name"] }, packages: { fields: ["eol"] } } } });
  const body = JSON.parse(String((await api.run(model, context()))[0]!.contents)) as { collections: { name: string; snapshot: unknown }[] };
  assert.deepEqual(body.collections.map((c) => c.name), ["packages", "tools"]);
  assert.equal(body.collections[1]!.snapshot, null);
  assert.equal(validate(body), true);
});

test("a site without the api key writes nothing", async () => {
  const model = site();
  const { api: _removed, ...rest } = model.config;
  assert.deepEqual(await api.run({ ...model, config: rest as SiteConfig }, context()), []);
});

test("a published field no record has, and an id key that is also a field, are errors", async () => {
  const reports: Diagnostic[] = [];
  await api.run(site({ api: { version: "v1", collections: { packages: { fields: ["name", "missing"], id: "key" } } } }), context(reports));
  assert.deepEqual(reports.map((d) => d.id), ["api.unknown-field"]);
  const conflict: Diagnostic[] = [];
  await api.run(site({ api: { version: "v1", collections: { packages: { fields: ["name"], id: "name" } } } }), context(conflict));
  assert.deepEqual(conflict.map((d) => d.id), ["api.id-key-conflict"]);
});

test("llms.txt links the index", async () => {
  const text = String((await llms.run(site(), context()))[0]!.contents);
  assert.match(text, /## Data API\n\n- \[API index\]\(https:\/\/example\.test\/docs\/api\/v1\/index\.json\)/);
});
