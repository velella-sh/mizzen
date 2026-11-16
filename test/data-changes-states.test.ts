import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { replayHistory, stateAtRef, stateInFolder } from "../src/data/changes/states.ts";

const target = { name: "items", source: "_data/items.yml" };

function site(): string {
  const root = mkdtempSync(join(tmpdir(), "data-states-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: A\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  git("tag", "v1");
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: B\n");
  return root;
}

test("a git ref gives the data as it was committed", () => {
  const result = stateAtRef(site(), target, "v1");
  assert.ok(result.ok);
  assert.deepEqual(result.records, [{ id: "a", fields: { id: "a", title: "A" } }]);
});

test("a missing ref and a file missing at a ref are reported", () => {
  const root = site();
  const none = stateAtRef(root, target, "nope");
  assert.ok(!none.ok);
  assert.match(none.message, /does not exist/);
  const file = stateAtRef(root, { ...target, source: "_data/other.yml" }, "v1");
  assert.ok(!file.ok);
});

test("a folder is read through the same loaders, CSV included", async () => {
  const root = site();
  const old = mkdtempSync(join(tmpdir(), "data-old-"));
  mkdirSync(join(old, "_data"));
  writeFileSync(join(old, "_data", "items.csv"), "id,title\nz,Z\n");
  const result = await stateInFolder(root, { name: "items", source: "_data/items.csv" }, old);
  assert.ok(result.ok);
  assert.deepEqual(result.records, [{ id: "z", fields: { id: "z", title: "Z" } }]);
  assert.ok(!(await stateInFolder(root, target, join(old, "missing"))).ok);
});

test("replaying the history rebuilds the tracked state", () => {
  const state = replayHistory([], [
    { type: "added", record: "a", fields: { t: 1 } },
    { type: "changed", record: "a", field: "t", new: 2 },
    { type: "renamed", record: "b", from: "a" },
    { type: "added", record: "c" },
    { type: "removed", record: "c" },
  ]);
  assert.deepEqual(state, [{ id: "b", fields: { t: 2 } }]);
});
