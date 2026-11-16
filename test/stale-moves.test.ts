import assert from "node:assert/strict";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { matchMoves } from "../src/stale/moves.ts";
import { run, site, write } from "./helpers-stale.ts";

const FILES = {
  "mizzen.yml": "title: T\n",
  "a.md": "---\ntitle: A\ncovers: [src/old.ts]\n---\n# A\n",
  "src/old.ts": "export const a = 1;\n",
};

async function marked() {
  const root = site(FILES);
  assert.equal((await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01"])).code, 0);
  return root;
}

test("a moved file is a move, not a stale page", async () => {
  const root = await marked();
  renameSync(join(root, "src/old.ts"), join(root, "src/new.ts"));
  const r = await run(["stale", root, "--json", "--fail"]);
  const report = JSON.parse(r.logs[0]!);
  assert.equal(r.code, 0);
  assert.deepEqual(report.pages, []);
  assert.deepEqual(report.moves, [{ page: "a.md", from: "src/old.ts", to: "src/new.ts" }]);
  assert.match((await run(["stale", root])).logs[0]! , /src\/old\.ts moved to src\/new\.ts/);
});

test("a move with an edit stays removed", async () => {
  const root = await marked();
  rmSync(join(root, "src/old.ts"));
  write(root, { "src/new.ts": "export const a = 2;\n" });
  const report = JSON.parse((await run(["stale", root, "--json"])).logs[0]!);
  assert.deepEqual(report.pages[0].files, [{ path: "src/old.ts", change: "removed" }]);
  assert.deepEqual(report.moves, []);
});

test("a copy is not a move: the old path is still there", async () => {
  const root = await marked();
  write(root, { "src/copy.ts": "export const a = 1;\n" });
  const report = JSON.parse((await run(["stale", root, "--json"])).logs[0]!);
  assert.deepEqual(report.pages, []);
  assert.deepEqual(report.moves, []);
});

test("a name match without the same content is not a move", async () => {
  const root = await marked();
  rmSync(join(root, "src/old.ts"));
  write(root, { "lib/old.ts": "different" });
  assert.deepEqual(JSON.parse((await run(["stale", root, "--json"])).logs[0]!).moves, []);
});

test("matchMoves pairs only an unambiguous hash", () => {
  const h = (c: string) => c.repeat(64);
  assert.deepEqual(matchMoves([{ path: "a", sha256: h("1") }], [{ path: "b", sha256: h("1") }, { path: "c", sha256: h("1") }]), []);
  assert.deepEqual(matchMoves([{ path: "a", sha256: h("1") }], [{ path: "b", sha256: h("1") }]), [{ from: "a", to: "b" }]);
});
