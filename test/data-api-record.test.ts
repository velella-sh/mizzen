import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Page, Site } from "../src/contracts/index.ts";
import { unsafeIdReason } from "../src/api/ids.ts";
import { api } from "../src/outputs/api.ts";
import { context, site } from "./data-api-site.ts";

async function run(model: Site, reports: Diagnostic[] = []): Promise<Map<string, string>> {
  return new Map((await api.run(model, context(reports))).map((file) => [file.path, String(file.contents)]));
}

test("a record file holds the fields, the page address, and the earlier addresses", async () => {
  const model = site();
  const pages = model.pages.map((p): Page =>
    p.record?.id === "a" ? { ...p, record: { ...p.record, previousUrls: ["/docs/old/a/"] } } : p,
  );
  const out = await run({ ...model, pages });
  assert.deepEqual(JSON.parse(out.get("api/v1/packages/a.json")!), {
    collection: "packages",
    id: "a",
    fields: { name: "a", eol: "2030-01-01" },
    url: "/docs/packages/a/",
    previousUrls: ["/docs/old/a/"],
  });
  assert.deepEqual(JSON.parse(out.get("api/v1/packages/b.json")!).previousUrls, []);
});

test("a renamed record keeps its id file while its page address changes", async () => {
  const before = await run(site());
  const model = site();
  const moved = model.pages.map((p): Page =>
    p.record?.id === "a"
      ? { ...p, url: "/docs/pkgs/a-renamed/", record: { ...p.record, previousUrls: ["/docs/packages/a/"] } }
      : p,
  );
  const after = await run({ ...model, pages: moved });
  assert.deepEqual([...after.keys()], [...before.keys()]);
  const a = JSON.parse(after.get("api/v1/packages/a.json")!) as { url: string; previousUrls: string[] };
  assert.equal(a.url, "/docs/pkgs/a-renamed/");
  assert.deepEqual(a.previousUrls, ["/docs/packages/a/"]);
  assert.equal(before.get("api/v1/packages/b.json"), after.get("api/v1/packages/b.json"));
});

test("a record without a page has a null address", async () => {
  const model = site();
  const out = await run({ ...model, pages: [] });
  assert.equal(JSON.parse(out.get("api/v1/packages/a.json")!).url, null);
});

test("an id that is not safe as a file name fails and writes no file", async () => {
  const model = site();
  const unsafe = ["../x", "a/b", "CON", "", "name.", "q?"];
  const records = unsafe.map((id) => ({ ...model.collections.packages!.records[0]!, id, fields: { name: id, eol: "x" } }));
  const reports: Diagnostic[] = [];
  const out = await run({ ...model, collections: { ...model.collections, packages: { ...model.collections.packages!, records } } }, reports);
  assert.deepEqual(reports.map((d) => d.id), unsafe.map(() => "api.unsafe-id"));
  assert.ok(reports.every((d) => d.severity === "error"));
  assert.deepEqual([...out.keys()].filter((path) => path.startsWith("api/v1/packages/")), []);
});

test("ids that differ only in case are reported", async () => {
  const model = site();
  const records = ["Tool", "tool"].map((id) => ({ ...model.collections.packages!.records[0]!, id, fields: { name: id, eol: "x" } }));
  const reports: Diagnostic[] = [];
  await run({ ...model, collections: { ...model.collections, packages: { ...model.collections.packages!, records } } }, reports);
  assert.deepEqual(reports.map((d) => d.id), ["api.id-collision"]);
});

test("safe ids pass, including non-ASCII and dotted ones", () => {
  for (const id of ["a", "node-22", "v1.2.3", "گزینه", "@scope"]) assert.equal(unsafeIdReason(id), undefined, id);
});
