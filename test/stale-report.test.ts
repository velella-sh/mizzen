import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run, site, write } from "./helpers-stale.ts";
import { compareToLock } from "../src/stale/report.ts";

const FILES = {
  "mizzen.yml": "title: T\n",
  "a.md": "---\ntitle: A\ncovers:\n  - src/*.ts\n---\n# A\n",
  "src/x.ts": "x",
  "src/y.ts": "y",
};

async function marked() {
  const root = site(FILES);
  const r = await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01"]);
  assert.equal(r.code, 0);
  return root;
}

test("a clean site lists nothing and exits 0 even with --fail", async () => {
  const root = await marked();
  const r = await run(["stale", root, "--fail"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.logs, ["No stale pages."]);
  assert.deepEqual(JSON.parse((await run(["stale", root, "--json"])).logs[0]!), { version: 1, pages: [], moves: [] });
});

test("a changed file names the page and the file", async () => {
  const root = await marked();
  write(root, { "src/x.ts": "x2" });
  const r = await run(["stale", root, "--json"]);
  const report = JSON.parse(r.logs[0]!);
  assert.equal(r.code, 0);
  assert.deepEqual(report.pages[0].files, [{ path: "src/x.ts", change: "changed" }]);
  assert.equal(report.pages[0].reviewed, "2026-01-01");
  assert.match(report.pages[0].fix, /mizzen stale mark a\.md/);
  assert.match((await run(["stale", root])).logs[0]!, /changed\s+src\/x\.ts/);
});

test("a removed file and a new file are reported", async () => {
  const root = await marked();
  rmSync(join(root, "src/y.ts"));
  write(root, { "src/z.ts": "z" });
  const report = JSON.parse((await run(["stale", root, "--json"])).logs[0]!);
  assert.deepEqual(report.pages[0].files, [
    { path: "src/y.ts", change: "removed" },
    { path: "src/z.ts", change: "added" },
  ]);
});

test("--fail exits 1 when a page is stale", async () => {
  const root = await marked();
  write(root, { "src/x.ts": "x2" });
  assert.equal((await run(["stale", root, "--fail"])).code, 1);
  assert.equal((await run(["stale", root])).code, 0);
});

test("a page with covers and no lock entry was never reviewed", async () => {
  const root = site(FILES);
  const report = JSON.parse((await run(["stale", root, "--json"])).logs[0]!);
  assert.equal(report.pages[0].reviewed, undefined);
  assert.deepEqual(report.pages[0].files.map((f: { change: string }) => f.change), ["added", "added"]);
});

test("usage errors exit 2", async () => {
  assert.equal((await run(["stale", "--nope"])).code, 2);
  assert.equal((await run(["stale", "a", "b"])).code, 2);
});

test("compareToLock ignores pages whose files match", () => {
  const h = "a".repeat(64);
  const pages = [{ page: "a.md", files: [{ path: "x", sha256: h }], diagnostics: [] }];
  assert.deepEqual(compareToLock(pages, { version: 1, pages: { "a.md": { reviewed: "2026-01-01", files: [{ path: "x", sha256: h }] } } }), []);
});
