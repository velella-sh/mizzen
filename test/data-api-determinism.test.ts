import assert from "node:assert/strict";
import { test } from "node:test";
import { overBudget } from "../src/api/budget.ts";
import { verify } from "../src/cli/verify.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { api } from "../src/outputs/api.ts";
import { apiSiteFiles, readTree, withBuiltSite } from "./data-api-build.ts";
import { context, site } from "./data-api-site.ts";

const block = ["api:", "  version: v2", "  versions:", "    v1:", "      collections:", "        packages:", "          fields: [name]", "  collections:", "    packages:", "      fields: [name, eol]"];

test("two builds of the same site write the same API files, and mizzen verify accepts the result", async () => {
  const first = await withBuiltSite(apiSiteFiles(block), async (out, diagnostics) => {
    assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
    const result = await verify({ dir: out });
    assert.equal(result.ok, true);
    return readTree(out);
  });
  const second = await withBuiltSite(apiSiteFiles(block), (out) => readTree(out));
  const apiFiles = (tree: Map<string, string>): [string, string][] => [...tree].filter(([path]) => path.startsWith("api/"));
  assert.ok(apiFiles(first).length > 8);
  assert.deepEqual(apiFiles(second), apiFiles(first));
});

test("a file over api.maxFileBytes gets a warning that points at the NDJSON file, and is written whole", async () => {
  const reports: Diagnostic[] = [];
  const config = { version: "v1", maxFileBytes: 200, collections: { packages: { fields: ["name", "eol"] } } };
  const files = await api.run(site({ api: config }), context(reports));
  const warned = reports.filter((d) => d.id === "api.file-too-large");
  assert.ok(warned.length > 0);
  assert.ok(warned.every((d) => d.severity === "warning"));
  const collection = warned.find((d) => d.message.startsWith("api/v1/packages.json "));
  assert.match(collection?.help ?? "", /api\/v1\/packages\.ndjson/);
  // Nothing was cut: the file still lists every record.
  const body = JSON.parse(String(files.find((f) => f.path === "api/v1/packages.json")!.contents)) as { count: number; records: unknown[] };
  assert.equal(body.records.length, body.count);
});

test("no limit and a file under it report nothing", () => {
  const reports: Diagnostic[] = [];
  overBudget([{ path: "api/v1/a.json", contents: "x".repeat(50) }], undefined, (d) => reports.push(d));
  overBudget([{ path: "api/v1/a.json", contents: "x".repeat(50) }], 50, (d) => reports.push(d));
  assert.deepEqual(reports, []);
});
