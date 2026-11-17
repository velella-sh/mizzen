import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/cli/index.ts";
import { run, site } from "./helpers-stale.ts";
import { REVIEW_LOCK_FILE } from "../src/stale/lock.ts";

const FILES = {
  "mizzen.yml": "title: T\n",
  "a.md": "---\ntitle: A\ncovers:\n  - src/*.ts\n---\n# A\n",
  "b.md": "---\ntitle: B\ncovers: [src/x.ts]\n---\n# B\n",
  "plain.md": "# Plain\n",
  "src/x.ts": "x",
  "src/y.ts": "y",
};

test("parseArgs registers stale", () => {
  assert.deepEqual(parseArgs(["stale", "mark", "a.md"]), { options: { command: "stale", args: ["mark", "a.md"] } });
});

test("marks one page and nothing else", async () => {
  const root = site(FILES);
  const r = await run(["stale", "mark", "a.md", "--site", root, "--date", "2026-01-01"]);
  assert.equal(r.code, 0, r.errors.join("\n"));
  const lock = JSON.parse(readFileSync(join(root, REVIEW_LOCK_FILE), "utf8"));
  assert.deepEqual(Object.keys(lock.pages), ["a.md"]);
  assert.equal(lock.pages["a.md"].reviewed, "2026-01-01");
  assert.deepEqual(lock.pages["a.md"].files.map((f: { path: string }) => f.path), ["src/x.ts", "src/y.ts"]);
});

test("--all marks every page with covers and writes an audit entry per page with the reason", async () => {
  const root = site(FILES);
  const r = await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01", "--reason", "read against token=abc123secret"]);
  assert.equal(r.code, 0, r.errors.join("\n"));
  const lock = JSON.parse(readFileSync(join(root, REVIEW_LOCK_FILE), "utf8"));
  assert.deepEqual(Object.keys(lock.pages), ["a.md", "b.md"]);
  const lines = readFileSync(join(root, "docs-review.audit.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.page), ["a.md", "b.md"]);
  assert.equal(lines[0].event, "mark");
  assert.equal(lines[0].date, "2026-01-01");
  assert.equal(String(lines[0].reason).includes("abc123secret"), false);
  const again = await run(["stale", "mark", "a.md", "--site", root, "--date", "2026-02-02"]);
  assert.equal(again.code, 0);
  assert.equal(readFileSync(join(root, "docs-review.audit.jsonl"), "utf8").trimEnd().split("\n").length, 3);
});

test("a page without covers is refused and nothing is written", async () => {
  const root = site(FILES);
  const r = await run(["stale", "mark", "a.md", "plain.md", "--site", root, "--date", "2026-01-01"]);
  assert.equal(r.code, 1);
  assert.match(r.errors.join("\n"), /plain\.md has no covers/);
  assert.throws(() => readFileSync(join(root, REVIEW_LOCK_FILE)));
});

test("marking needs a page or --all", async () => {
  const root = site(FILES);
  assert.equal((await run(["stale", "mark", "--site", root])).code, 2);
  assert.equal((await run(["stale", "mark", "a.md", "--all", "--site", root])).code, 2);
});

test("a covers path outside the root refuses the mark", async () => {
  const root = site({ ...FILES, "c.md": "---\ncovers: [../x]\n---\n# C\n" });
  const r = await run(["stale", "mark", "c.md", "--site", root, "--date", "2026-01-01"]);
  assert.equal(r.code, 1);
});
