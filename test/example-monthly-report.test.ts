import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { api } from "../src/outputs/api.ts";

const ROOT = fileURLToPath(new URL("../examples/monthly-report/", import.meta.url));

test("the monthly-report example runs from raw rows to summary, archive, and static API", async () => {
  const { site, diagnostics } = await buildModel(ROOT);
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

  const monthly = site.collections["monthly"]!;
  assert.deepEqual(monthly.records.map((record) => record.id), ["2026-01", "2026-02"]);
  assert.deepEqual(monthly.records[1]!.fields, {
    id: "2026-02",
    date: "2026-02",
    orders: 4,
    customers: 3,
    revenue: 180.25,
    average: 60.08,
  });

  const summary = site.pages.find((page) => page.url === "/")!;
  assert.deepEqual(summary.list?.records.map((record) => record.id), ["2026-02", "2026-01"]);
  const archive = site.pages.find((page) => page.url === "/archive/")!;
  assert.deepEqual(archive.list?.records.map((record) => record.id), ["2026-02", "2026-01"]);

  const files = new Map((await api.run(site, { renderPage: async () => "", report: () => {} })).map((file) => [file.path, String(file.contents)]));
  const body = JSON.parse(files.get("api/v1/monthly.json")!) as { count: number; records: { id: string }[] };
  assert.equal(body.count, monthly.records.length);
  assert.deepEqual(body.records.map((record) => record.id).sort(), ["2026-01", "2026-02"]);
});
