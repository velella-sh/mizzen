import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { dataChanges } from "../src/data/changes/write.ts";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
}

const CONFIG = "collections:\n  items:\n    source: _data/items.yml\n    changelog:\n      track: [title]\n";

function site(items = "- id: a\n  title: A\n"): string {
  const root = mkdtempSync(join(tmpdir(), "data-changes-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), CONFIG);
  writeFileSync(join(root, "_data", "items.yml"), items);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  return root;
}

async function commit(root: string, items: string): Promise<void> {
  writeFileSync(join(root, "_data", "items.yml"), items);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "more");
  assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
}

const history = (root: string) => readFileSync(join(root, "data-changes", "items.jsonl"), "utf8");

test("a first run lists the events, and --write appends them dated by the snapshot", async () => {
  const root = site();
  assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
  const lock = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8"));
  const dry = await dataChanges({ root });
  assert.equal(dry.code, 0);
  assert.equal(dry.pending.length, 1);
  assert.equal(dry.pending[0]!.event.date, lock.snapshots.items.capturedAt);
  assert.throws(() => history(root));

  const written = await dataChanges({ root, write: true });
  assert.equal(written.code, 0);
  assert.match(history(root), /"type":"added","record":"a","fields":\{"title":"A"\},"date":"20\d\d-/);
});

test("a repeated run writes nothing, and a later change appends one event", async () => {
  const root = site();
  await dataSnapshot({ root, name: "items" });
  await dataChanges({ root, write: true });
  const first = history(root);
  const again = await dataChanges({ root, write: true });
  assert.equal(again.pending.length, 0);
  assert.equal(history(root), first);

  await commit(root, "- id: a\n  title: B\n");
  const next = await dataChanges({ root, write: true });
  assert.equal(next.pending.length, 1);
  assert.equal(next.pending[0]!.event.type, "changed");
  assert.equal(history(root).startsWith(first), true, "the file only grows");
  assert.equal(history(root).trim().split("\n").length, 2);
});

test("a collection without a snapshot date is refused and nothing is written", async () => {
  const root = site();
  const result = await dataChanges({ root, write: true });
  assert.equal(result.code, 1);
  assert.match(result.errors[0]!, /no snapshot date/);
  assert.throws(() => history(root));
});

test("the command parses and --check fails on a pending event", async () => {
  const parsed = parseArgs(["data", "changes", "items", "site", "--check"]);
  assert.ok("options" in parsed);
  assert.deepEqual(parsed.options, { command: "data-changes", root: "site", name: "items", write: false, check: true });
  assert.ok("error" in parseArgs(["data", "changes", "--write", "--check"]));

  const root = site();
  await dataSnapshot({ root, name: "items" });
  const out: string[] = [];
  const err: string[] = [];
  assert.equal(await main(["data", "changes", "items", root, "--check"], { log: (m: string) => out.push(m), error: (m: string) => err.push(m) }), 1);
  assert.match(err.join("\n"), /without a history entry/);
});
